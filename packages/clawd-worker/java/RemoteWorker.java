///usr/bin/env java --source 21 "$0" "$@"; exit $?
// ^ shebang trick: `chmod +x RemoteWorker.java && ./RemoteWorker.java --server ...`
// Or run directly: `java RemoteWorker.java --server <url> --token <token>`

/**
 * Claw'd Remote Worker — single-file, zero-dependency Java 21 client.
 * Connects to a Claw'd server via WebSocket and executes file tools on the remote machine.
 *
 * Requires Java 21+. Zero external dependencies.
 *
 * Usage:
 *   java RemoteWorker.java --server <url> --token <token> [options]
 */

import java.io.*;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import java.util.stream.Collectors;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Main class — single-file Java 21 source-code program.
 */
public class RemoteWorker {

    static final String VERSION = "0.1.0";
    static final String USER_AGENT = "Clawd-RemoteWorker/0.1";

    // -----------------------------------------------------------------------
    // Platform detection
    // -----------------------------------------------------------------------
    static final boolean IS_WINDOWS = System.getProperty("os.name", "").toLowerCase().contains("win");
    static final boolean IS_MACOS = System.getProperty("os.name", "").toLowerCase().contains("mac");
    static final boolean IS_WSL2;
    static {
        boolean wsl = false;
        if (!IS_WINDOWS && !IS_MACOS) {
            try {
                String procVersion = Files.readString(Path.of("/proc/version"));
                wsl = procVersion.toLowerCase().contains("microsoft");
            } catch (Exception ignored) {}
        }
        IS_WSL2 = wsl;
    }

    static final String REAL_TMP;
    static {
        String tmp;
        try { tmp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath().toString(); }
        catch (Exception e) { tmp = System.getProperty("java.io.tmpdir"); }
        REAL_TMP = tmp;
    }

    static final Pattern WIN_RESERVED = Pattern.compile(
        "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..+)?$", Pattern.CASE_INSENSITIVE);

    static boolean isDrvFs(String p) {
        return IS_WSL2 && p.matches("(?i)^/mnt/[a-z]/.*");
    }

    // -----------------------------------------------------------------------
    // Logging
    // -----------------------------------------------------------------------
    static void log(String msg) {
        System.err.println("[worker] " + msg);
        System.err.flush();
    }

    // -----------------------------------------------------------------------
    // Minimal JSON parser/serializer
    // -----------------------------------------------------------------------

    /** Represents a JSON value: Map, List, String, Number, Boolean, or null. */
    static final class Json {
        private Json() {}

        // --- Parser ---
        static Object parse(String json) {
            return new JsonParser(json).parseValue();
        }

        // --- Serializer ---
        static String serialize(Object obj) {
            var sb = new StringBuilder();
            writeValue(sb, obj);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        private static void writeValue(StringBuilder sb, Object obj) {
            if (obj == null) {
                sb.append("null");
            } else if (obj instanceof String s) {
                writeString(sb, s);
            } else if (obj instanceof Boolean b) {
                sb.append(b ? "true" : "false");
            } else if (obj instanceof Number n) {
                double d = n.doubleValue();
                if (d == Math.floor(d) && !Double.isInfinite(d) && !Double.isNaN(d)
                        && d >= Long.MIN_VALUE && d <= Long.MAX_VALUE && Math.abs(d) < 1e15) {
                    sb.append((long) d);
                } else {
                    sb.append(n);
                }
            } else if (obj instanceof Map<?, ?> map) {
                sb.append('{');
                boolean first = true;
                for (var entry : map.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeString(sb, String.valueOf(entry.getKey()));
                    sb.append(':');
                    writeValue(sb, entry.getValue());
                }
                sb.append('}');
            } else if (obj instanceof List<?> list) {
                sb.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) sb.append(',');
                    writeValue(sb, list.get(i));
                }
                sb.append(']');
            } else {
                writeString(sb, obj.toString());
            }
        }

        private static void writeString(StringBuilder sb, String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"'  -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\b' -> sb.append("\\b");
                    case '\f' -> sb.append("\\f");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            sb.append("\\u").append(String.format("%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                    }
                }
            }
            sb.append('"');
        }

        /** Helper: build an ordered map from key/value pairs. */
        static Map<String, Object> obj(Object... kvs) {
            var map = new LinkedHashMap<String, Object>();
            for (int i = 0; i + 1 < kvs.length; i += 2) {
                map.put(String.valueOf(kvs[i]), kvs[i + 1]);
            }
            return map;
        }

        static List<Object> arr(Object... items) {
            return new ArrayList<>(List.of(items));
        }

        // --- JSON Parser implementation ---
        private static final class JsonParser {
            private final String src;
            private int pos;

            JsonParser(String src) {
                this.src = src;
                this.pos = 0;
            }

            Object parseValue() {
                skipWhitespace();
                if (pos >= src.length()) throw new IllegalArgumentException("Unexpected end of JSON");
                char c = src.charAt(pos);
                return switch (c) {
                    case '{' -> parseObject();
                    case '[' -> parseArray();
                    case '"' -> parseString();
                    case 't', 'f' -> parseBoolean();
                    case 'n' -> parseNull();
                    default -> {
                        if (c == '-' || (c >= '0' && c <= '9')) yield parseNumber();
                        throw new IllegalArgumentException("Unexpected char '" + c + "' at pos " + pos);
                    }
                };
            }

            private Map<String, Object> parseObject() {
                expect('{');
                var map = new LinkedHashMap<String, Object>();
                skipWhitespace();
                if (pos < src.length() && src.charAt(pos) == '}') { pos++; return map; }
                while (true) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    expect(':');
                    Object value = parseValue();
                    map.put(key, value);
                    skipWhitespace();
                    if (pos < src.length() && src.charAt(pos) == ',') { pos++; continue; }
                    if (pos < src.length() && src.charAt(pos) == '}') { pos++; return map; }
                    throw new IllegalArgumentException("Expected ',' or '}' at pos " + pos);
                }
            }

            private List<Object> parseArray() {
                expect('[');
                var list = new ArrayList<>();
                skipWhitespace();
                if (pos < src.length() && src.charAt(pos) == ']') { pos++; return list; }
                while (true) {
                    list.add(parseValue());
                    skipWhitespace();
                    if (pos < src.length() && src.charAt(pos) == ',') { pos++; continue; }
                    if (pos < src.length() && src.charAt(pos) == ']') { pos++; return list; }
                    throw new IllegalArgumentException("Expected ',' or ']' at pos " + pos);
                }
            }

            private String parseString() {
                skipWhitespace();
                expect('"');
                var sb = new StringBuilder();
                while (pos < src.length()) {
                    char c = src.charAt(pos++);
                    if (c == '"') return sb.toString();
                    if (c == '\\') {
                        if (pos >= src.length()) throw new IllegalArgumentException("Unexpected end in string escape");
                        char esc = src.charAt(pos++);
                        switch (esc) {
                            case '"'  -> sb.append('"');
                            case '\\' -> sb.append('\\');
                            case '/'  -> sb.append('/');
                            case 'b'  -> sb.append('\b');
                            case 'f'  -> sb.append('\f');
                            case 'n'  -> sb.append('\n');
                            case 'r'  -> sb.append('\r');
                            case 't'  -> sb.append('\t');
                            case 'u'  -> {
                                if (pos + 4 > src.length())
                                    throw new IllegalArgumentException("Incomplete unicode escape");
                                String hex = src.substring(pos, pos + 4);
                                sb.append((char) Integer.parseInt(hex, 16));
                                pos += 4;
                            }
                            default -> { sb.append('\\'); sb.append(esc); }
                        }
                    } else {
                        sb.append(c);
                    }
                }
                throw new IllegalArgumentException("Unterminated string");
            }

            private Number parseNumber() {
                int start = pos;
                if (pos < src.length() && src.charAt(pos) == '-') pos++;
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
                boolean isFloat = false;
                if (pos < src.length() && src.charAt(pos) == '.') {
                    isFloat = true;
                    pos++;
                    while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
                }
                if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                    isFloat = true;
                    pos++;
                    if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
                    while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
                }
                String numStr = src.substring(start, pos);
                if (isFloat) return Double.parseDouble(numStr);
                long l = Long.parseLong(numStr);
                return l;
            }

            private Boolean parseBoolean() {
                if (src.startsWith("true", pos)) { pos += 4; return true; }
                if (src.startsWith("false", pos)) { pos += 5; return false; }
                throw new IllegalArgumentException("Expected boolean at pos " + pos);
            }

            private Object parseNull() {
                if (src.startsWith("null", pos)) { pos += 4; return null; }
                throw new IllegalArgumentException("Expected null at pos " + pos);
            }

            private void skipWhitespace() {
                while (pos < src.length()) {
                    char c = src.charAt(pos);
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                    else break;
                }
            }

            private void expect(char c) {
                skipWhitespace();
                if (pos >= src.length() || src.charAt(pos) != c)
                    throw new IllegalArgumentException("Expected '" + c + "' at pos " + pos);
                pos++;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Configuration record
    // -----------------------------------------------------------------------
    record Config(
        String server,
        String token,
        String projectRoot,
        String name,
        boolean readOnly,
        long timeout,
        int reconnectMax,
        boolean insecure,
        String caCert,
        int maxConcurrent,
        String cfClientId,
        String cfClientSecret,
        String browser
    ) {}

    // -----------------------------------------------------------------------
    // CLI parsing
    // -----------------------------------------------------------------------

    static void printUsage() {
        System.err.print("""
            Usage: java RemoteWorker.java --server <url> --token <token> [options]

            Required:
              --server <url>         Claw'd server (e.g. clawd.example.com or localhost:3456)
              --token <token>        Auth token (or CLAWD_WORKER_TOKEN env var)

            Options:
              --project-root <path>  Project root directory (default: cwd)
              --name <name>          Worker name (default: hostname)
              --read-only            Disable edit/create/bash tools
              --timeout <ms>         Default command timeout (default: 30000)
              --reconnect-max <s>    Max reconnect delay in seconds (default: 300)
              --insecure             Disable TLS certificate verification
              --ca-cert <path>       Custom CA certificate file path
              --max-concurrent <n>   Max concurrent tool calls (default: 4)
              --cf-client-id <id>    Cloudflare Access service token client ID (or CF_ACCESS_CLIENT_ID env)
              --cf-client-secret <s> Cloudflare Access service token secret (or CF_ACCESS_CLIENT_SECRET env)
              --browser [profile]    Enable browser control via CDP (optional profile name)
            """.stripIndent());
        System.exit(1);
    }

    static String normalizeServerUrl(String raw) {
        String url = raw.strip().replaceAll("/+$", "");
        // Strip trailing /worker/ws if user included it
        url = url.replaceAll("/worker/ws/?$", "");
        // Add scheme if missing
        if (!url.matches("(?i)^wss?://.*")) {
            if (url.matches("(?i)^https?://.*")) {
                url = url.replaceFirst("(?i)^http:", "ws:").replaceFirst("(?i)^https:", "wss:");
            } else {
                boolean isLocal = url.matches("(?i)^(localhost|127\\.|0\\.0\\.0\\.|::1|\\[::1\\])(:|$).*");
                url = (isLocal ? "ws://" : "wss://") + url;
            }
        }
        return url;
    }

    static Config parseArgs(String[] args) {
        String server = "";
        String token = env("CLAWD_WORKER_TOKEN", "");
        String projectRoot = System.getProperty("user.dir");
        String name = hostname();
        boolean readOnly = false;
        long timeout = 30000;
        int reconnectMax = 300;
        boolean insecure = false;
        String caCert = null;
        int maxConcurrent = 4;
        String cfClientId = env("CF_ACCESS_CLIENT_ID", null);
        String cfClientSecret = env("CF_ACCESS_CLIENT_SECRET", null);
        String browser = null;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--server"          -> server = nextArg(args, ++i, "--server");
                case "--token"           -> token = nextArg(args, ++i, "--token");
                case "--project-root"    -> projectRoot = nextArg(args, ++i, "--project-root");
                case "--name"            -> name = nextArg(args, ++i, "--name");
                case "--read-only"       -> readOnly = true;
                case "--timeout"         -> timeout = Long.parseLong(nextArg(args, ++i, "--timeout"));
                case "--reconnect-max"   -> reconnectMax = Integer.parseInt(nextArg(args, ++i, "--reconnect-max"));
                case "--insecure"        -> insecure = true;
                case "--ca-cert"         -> caCert = nextArg(args, ++i, "--ca-cert");
                case "--max-concurrent"  -> maxConcurrent = Integer.parseInt(nextArg(args, ++i, "--max-concurrent"));
                case "--cf-client-id"    -> cfClientId = nextArg(args, ++i, "--cf-client-id");
                case "--cf-client-secret"-> cfClientSecret = nextArg(args, ++i, "--cf-client-secret");
                case "--browser"         -> {
                    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                        browser = args[++i];
                    } else {
                        browser = "";
                    }
                }
                default -> { System.err.println("Unknown argument: " + args[i]); printUsage(); }
            }
        }

        if (server.isEmpty()) { System.err.println("Error: --server is required"); printUsage(); }
        server = normalizeServerUrl(server);

        if (token.isEmpty()) { System.err.println("Error: --token or CLAWD_WORKER_TOKEN is required"); printUsage(); }

        // Resolve project root — convert MSYS paths first
        if (IS_WINDOWS && projectRoot.length() >= 2 && projectRoot.charAt(0) == '/'
                && Character.isLetter(projectRoot.charAt(1))
                && (projectRoot.length() == 2 || projectRoot.charAt(2) == '/')) {
            projectRoot = Character.toUpperCase(projectRoot.charAt(1)) + ":"
                    + (projectRoot.length() > 2 ? projectRoot.substring(2).replace('/', '\\') : "\\");
        } else if (IS_WINDOWS) {
            projectRoot = projectRoot.replace('/', '\\');
        }
        try { projectRoot = Path.of(projectRoot).toRealPath().toString(); }
        catch (IOException e) {
            try { projectRoot = Path.of(projectRoot).toAbsolutePath().normalize().toString(); }
            catch (Exception e2) { /* keep as-is */ }
        }

        if (!Files.isDirectory(Path.of(projectRoot))) {
            System.err.println("Error: project root does not exist: " + projectRoot);
            System.exit(1);
        }

        return new Config(server, token, projectRoot, name, readOnly, timeout,
                           reconnectMax, insecure, caCert, maxConcurrent, cfClientId, cfClientSecret, browser);
    }

    static String nextArg(String[] args, int i, String flag) {
        if (i >= args.length) { System.err.println("Error: " + flag + " requires a value"); printUsage(); }
        return args[i];
    }

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : def;
    }

    static String hostname() {
        try { return InetAddress.getLocalHost().getHostName(); }
        catch (Exception e) { return "unknown"; }
    }

    // -----------------------------------------------------------------------
    // Security helpers
    // -----------------------------------------------------------------------

    static String normalizeForComparison(String p) {
        String normalized = p.replace('\\', '/');
        if (IS_WINDOWS || IS_MACOS || isDrvFs(p)) {
            normalized = normalized.toLowerCase();
        }
        if (normalized.length() > 1 && normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    record PathValidation(boolean ok, String resolved, String error) {
        static PathValidation success(String resolved) { return new PathValidation(true, resolved, null); }
        static PathValidation fail(String error) { return new PathValidation(false, null, error); }
    }

    static PathValidation validatePath(String target, String root) {
        if (target == null || target.isEmpty()) return PathValidation.fail("Empty path");

        // Expand ~ on Unix
        if (target.startsWith("~")) {
            target = System.getProperty("user.home") + target.substring(1);
        }
        if (IS_WINDOWS) {
            // Convert MSYS/Git Bash paths like /d/foo → D:\foo before slash replacement
            if (target.length() >= 2 && target.charAt(0) == '/'
                    && Character.isLetter(target.charAt(1))
                    && (target.length() == 2 || target.charAt(2) == '/')) {
                target = Character.toUpperCase(target.charAt(1)) + ":"
                        + (target.length() > 2 ? target.substring(2) : "\\");
            }
            target = target.replace('/', '\\');
        }

        String resolved;
        Path targetPath = Path.of(target);
        try {
            if (Files.exists(targetPath)) {
                resolved = targetPath.toRealPath().toString();
            } else {
                Path parent = targetPath.getParent();
                if (parent == null) parent = Path.of(".");
                if (!Files.exists(parent)) {
                    return PathValidation.fail("Parent directory does not exist: " + parent);
                }
                resolved = parent.toRealPath().resolve(targetPath.getFileName()).toString();
            }
        } catch (IOException e) {
            return PathValidation.fail("Path validation failed: " + e.getMessage());
        }

        // Windows reserved names
        String basename = Path.of(resolved).getFileName().toString();
        if (IS_WINDOWS && WIN_RESERVED.matcher(basename).matches()) {
            return PathValidation.fail("Reserved filename on Windows: " + basename);
        }

        // Sensitive file check
        if (isSensitiveFile(basename)) {
            return PathValidation.fail("Access denied: sensitive file " + basename);
        }

        // Containment check: must be under root or temp dir
        String normResolved = normalizeForComparison(resolved);
        String normRoot = normalizeForComparison(root);
        String normTmp = normalizeForComparison(REAL_TMP);

        boolean inRoot = normResolved.equals(normRoot) || normResolved.startsWith(normRoot + "/");
        boolean inTmp = normResolved.equals(normTmp) || normResolved.startsWith(normTmp + "/");

        if (!inRoot && !inTmp) {
            return PathValidation.fail("Path escapes project root: " + resolved);
        }

        return PathValidation.success(resolved);
    }

    static boolean isSensitiveFile(String name) {
        String lower = name.toLowerCase();
        if (lower.equals(".env") || (lower.startsWith(".env.") && !lower.contains("example"))) return true;
        if (lower.startsWith(".secret")) return true;
        if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
        return Set.of("id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "credentials").contains(lower);
    }

    static final int MAX_OUTPUT = 50000;
    static String truncateOutput(String s) {
        if (s.length() <= MAX_OUTPUT) return s;
        return s.substring(0, MAX_OUTPUT) + "\n[output truncated]";
    }

    static final Pattern[] SECRET_PATTERNS = {
        Pattern.compile("(?i)(?:API_KEY|SECRET|PASSWORD|TOKEN)\\s*[=:]\\s*\\S+"),
        Pattern.compile("ghp_[a-zA-Z0-9]{36}"),
        Pattern.compile("sk-[a-zA-Z0-9]{32,}"),
        Pattern.compile("AKIA[A-Z0-9]{16}"),
        Pattern.compile("-----BEGIN\\s+(?:RSA\\s+)?PRIVATE\\s+KEY-----[\\s\\S]*?-----END"),
        Pattern.compile("eyJ[a-zA-Z0-9_-]{20,}\\.[a-zA-Z0-9_-]{20,}"),
    };

    static String sanitizeSecrets(String output) {
        for (Pattern p : SECRET_PATTERNS) {
            output = p.matcher(output).replaceAll("[REDACTED]");
        }
        return output;
    }

    // -----------------------------------------------------------------------
    // Shell resolution
    // -----------------------------------------------------------------------

    record ShellCmd(String exe, List<String> args) {}

    static ShellCmd resolveShell(String command) {
        if (!IS_WINDOWS) {
            return new ShellCmd("bash", List.of("-c", command));
        }
        // Use native Windows shell — no Git Bash conversion.
        // Agent should write OS-native commands (PowerShell/cmd syntax).
        for (String ps : List.of("pwsh.exe", "powershell.exe")) {
            try {
                var which = new ProcessBuilder("where", ps).redirectErrorStream(true).start();
                which.waitFor(5, TimeUnit.SECONDS);
                if (which.exitValue() == 0) {
                    return new ShellCmd(ps, List.of("-NoProfile", "-NonInteractive", "-Command", command));
                }
            } catch (Exception ignored) {}
        }
        String comSpec = System.getenv("ComSpec");
        return new ShellCmd(comSpec != null ? comSpec : "cmd.exe", List.of("/c", command));
    }

    // -----------------------------------------------------------------------
    // Process management
    // -----------------------------------------------------------------------

    static final ConcurrentHashMap<String, Process> activeProcesses = new ConcurrentHashMap<>();
    static final Set<String> cancelledCalls = ConcurrentHashMap.newKeySet();

    static void killProcessTree(long pid) {
        if (IS_WINDOWS) {
            try {
                new ProcessBuilder("taskkill", "/PID", String.valueOf(pid), "/T", "/F")
                    .redirectErrorStream(true).start().waitFor(5, TimeUnit.SECONDS);
            } catch (Exception ignored) {}
        } else {
            // Kill process group
            try {
                new ProcessBuilder("kill", "-TERM", "-" + pid)
                    .redirectErrorStream(true).start().waitFor(3, TimeUnit.SECONDS);
            } catch (Exception ignored) {}
            try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            try {
                new ProcessBuilder("kill", "-9", "-" + pid)
                    .redirectErrorStream(true).start().waitFor(3, TimeUnit.SECONDS);
            } catch (Exception ignored) {}
        }
    }

    // -----------------------------------------------------------------------
    // Tool implementations
    // -----------------------------------------------------------------------

    // -- view --

    static Map<String, Object> handleView(Map<String, Object> args, String projectRoot) {
        String path = strArg(args, "path", "");
        if (path.isEmpty()) return toolError("path is required");

        var v = validatePath(path, projectRoot);
        if (!v.ok()) return toolError(v.error());

        Path resolved = Path.of(v.resolved());

        try {
            if (Files.isDirectory(resolved)) {
                var entries = new ArrayList<String>();
                listDir(resolved, resolved, 0, 2, entries);
                return toolOk(String.join("\n", entries));
            }

            if (!Files.isRegularFile(resolved)) {
                return toolError("Not a file or directory: " + v.resolved());
            }

            // Size check (10 MB)
            long size = Files.size(resolved);
            if (size > 10 * 1024 * 1024) {
                return toolError("File too large: " + size + " bytes (max 10MB)");
            }

            String content = Files.readString(resolved, StandardCharsets.UTF_8);
            String[] lines = content.split("\r?\n", -1);

            // Parse view_range or start_line/end_line
            int startLine = 1;
            int endLine = lines.length;

            Object viewRange = args.get("view_range");
            if (viewRange instanceof List<?> range && !range.isEmpty()) {
                startLine = toInt(range.get(0), 1);
                if (range.size() > 1) {
                    int e = toInt(range.get(1), -1);
                    if (e != -1) endLine = e;
                }
            } else {
                if (args.containsKey("start_line")) startLine = toInt(args.get("start_line"), 1);
                if (args.containsKey("end_line")) endLine = toInt(args.get("end_line"), lines.length);
            }

            startLine = Math.max(1, startLine);
            endLine = Math.min(lines.length, endLine);

            var sb = new StringBuilder();
            for (int i = startLine - 1; i < endLine; i++) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(i + 1).append(". ").append(lines[i]);
            }

            return toolOk(sanitizeSecrets(truncateOutput(sb.toString())));
        } catch (IOException e) {
            return toolError(e.getMessage());
        }
    }

    static void listDir(Path dir, Path root, int depth, int maxDepth, List<String> entries) {
        if (depth >= maxDepth) return;
        try (var stream = Files.list(dir)) {
            var items = stream.sorted().toList();
            for (Path item : items) {
                String name = item.getFileName().toString();
                if (name.startsWith(".")) continue;
                try {
                    String rel = root.relativize(item).toString().replace('\\', '/');
                    if (Files.isDirectory(item, LinkOption.NOFOLLOW_LINKS)) {
                        entries.add(rel + "/");
                        listDir(item, root, depth + 1, maxDepth, entries);
                    } else {
                        entries.add(rel);
                    }
                } catch (Exception ignored) {}
            }
        } catch (IOException ignored) {}
    }

    // -- edit --

    static Map<String, Object> handleEdit(Map<String, Object> args, String projectRoot, boolean readOnly) {
        if (readOnly) return toolError("Worker is in read-only mode");

        String path = strArg(args, "path", "");
        String oldStr = strArg(args, "old_str", "");
        String newStr = strArg(args, "new_str", "");

        if (oldStr.isEmpty()) return toolError("old_str is required");

        var v = validatePath(path, projectRoot);
        if (!v.ok()) return toolError(v.error());

        Path resolved = Path.of(v.resolved());
        if (!Files.isRegularFile(resolved)) return toolError("File not found: " + v.resolved());

        try {
            String content = Files.readString(resolved, StandardCharsets.UTF_8);

            // Try exact match first
            String effectiveOld = oldStr;
            String effectiveNew = newStr;
            int idx = content.indexOf(effectiveOld);

            if (idx == -1) {
                // CRLF mismatch: try converting line endings
                boolean fileCRLF = content.contains("\r\n");
                boolean oldCRLF = oldStr.contains("\r\n");
                if (fileCRLF != oldCRLF) {
                    if (fileCRLF) {
                        effectiveOld = oldStr.replace("\n", "\r\n");
                        effectiveNew = newStr.replace("\n", "\r\n");
                    } else {
                        effectiveOld = oldStr.replace("\r\n", "\n");
                        effectiveNew = newStr.replace("\r\n", "\n");
                    }
                    idx = content.indexOf(effectiveOld);
                }
                if (idx == -1) return toolError("old_str not found in file");
            }

            // Uniqueness check
            int secondIdx = content.indexOf(effectiveOld, idx + 1);
            if (secondIdx != -1) {
                return toolError("old_str matches multiple locations — add more context to make it unique");
            }

            // Preserve line ending style in replacement
            String matchedRegion = content.substring(idx, idx + effectiveOld.length());
            boolean regionCRLF = matchedRegion.contains("\r\n");
            boolean newHasCRLF = effectiveNew.contains("\r\n");
            boolean newHasLF = effectiveNew.contains("\n");

            if (regionCRLF && !newHasCRLF && newHasLF) {
                effectiveNew = effectiveNew.replace("\n", "\r\n");
            } else if (!regionCRLF && newHasCRLF) {
                effectiveNew = effectiveNew.replace("\r\n", "\n");
            }

            String newContent = content.substring(0, idx) + effectiveNew +
                                content.substring(idx + effectiveOld.length());
            Files.writeString(resolved, newContent, StandardCharsets.UTF_8);

            return toolOk("Edited " + v.resolved());
        } catch (IOException e) {
            return toolError(e.getMessage());
        }
    }

    // -- create --

    static Map<String, Object> handleCreate(Map<String, Object> args, String projectRoot, boolean readOnly) {
        if (readOnly) return toolError("Worker is in read-only mode");

        String path = strArg(args, "path", "");
        String fileText = strArg(args, "file_text", strArg(args, "content", ""));

        var v = validatePath(path, projectRoot);
        if (!v.ok()) return toolError(v.error());

        Path resolved = Path.of(v.resolved());
        if (Files.exists(resolved)) return toolError("File already exists: " + v.resolved());

        Path parent = resolved.getParent();
        if (parent == null || !Files.isDirectory(parent)) {
            return toolError("Parent directory does not exist: " + parent);
        }

        try {
            Files.writeString(resolved, fileText, StandardCharsets.UTF_8);
            return toolOk("Created " + v.resolved());
        } catch (IOException e) {
            return toolError(e.getMessage());
        }
    }

    // -- grep --

    static Map<String, Object> handleGrep(Map<String, Object> args, String projectRoot) {
        String pattern = strArg(args, "pattern", "");
        if (pattern.isEmpty()) return toolError("pattern is required");

        String searchPath = strArg(args, "path", projectRoot);
        var v = validatePath(searchPath, projectRoot);
        if (!v.ok()) return toolError(v.error());

        String resolvedPath = v.resolved();
        String globFilter = strArg(args, "glob", null);
        boolean caseInsensitive = boolArg(args, "-i", false);
        boolean showLines = boolArg(args, "-n", true);
        Integer contextAfter = intArg(args, "-A");
        Integer contextBefore = intArg(args, "-B");
        Integer contextBoth = intArg(args, "-C");
        String outputMode = strArg(args, "output_mode", "content");
        Integer headLimit = intArg(args, "head_limit");

        // Try ripgrep first
        String rgPath = findExecutable("rg");
        if (rgPath != null) {
            var cmdArgs = new ArrayList<>(List.of(rgPath, "--no-follow", "--color=never"));
            if (caseInsensitive) cmdArgs.add("-i");
            if ("files_with_matches".equals(outputMode)) cmdArgs.add("-l");
            else if ("count".equals(outputMode)) cmdArgs.add("-c");
            else { if (showLines) cmdArgs.add("-n"); }
            if (contextBoth != null) { cmdArgs.add("-C"); cmdArgs.add(contextBoth.toString()); }
            else {
                if (contextAfter != null) { cmdArgs.add("-A"); cmdArgs.add(contextAfter.toString()); }
                if (contextBefore != null) { cmdArgs.add("-B"); cmdArgs.add(contextBefore.toString()); }
            }
            if (globFilter != null) { cmdArgs.add("-g"); cmdArgs.add(globFilter); }
            if (headLimit != null) { cmdArgs.add("-m"); cmdArgs.add(headLimit.toString()); }
            cmdArgs.add(pattern);
            cmdArgs.add(resolvedPath);

            var result = runCommand(cmdArgs, projectRoot, 60);
            if (result.exitCode == 0 || result.exitCode == 1) {
                return toolOk(sanitizeSecrets(truncateOutput(result.output.strip())));
            }
            // If rg failed for non-missing reason, still return its output
            if (!result.error.contains("No such file") && result.exitCode != 127) {
                return Json.obj("success", false, "output", result.output, "error", result.error.isEmpty() ? "rg failed" : result.error);
            }
        }

        // Fallback: grep on Unix, findstr on Windows
        var cmdArgs = new ArrayList<String>();
        if (IS_WINDOWS) {
            cmdArgs.addAll(List.of("findstr", "/s", "/n", "/r"));
            if (caseInsensitive) cmdArgs.add("/i");
            cmdArgs.add(pattern);
            cmdArgs.add(Files.isDirectory(Path.of(resolvedPath))
                ? resolvedPath + "\\*" : resolvedPath);
        } else {
            String grepBin = findExecutable("grep");
            if (grepBin == null) grepBin = "grep";
            cmdArgs.add(grepBin);
            cmdArgs.add("-rn");
            if (caseInsensitive) cmdArgs.add("-i");
            if ("files_with_matches".equals(outputMode)) cmdArgs.add("-l");
            else if ("count".equals(outputMode)) cmdArgs.add("-c");
            if (contextBoth != null) { cmdArgs.add("-C"); cmdArgs.add(contextBoth.toString()); }
            else {
                if (contextAfter != null) { cmdArgs.add("-A"); cmdArgs.add(contextAfter.toString()); }
                if (contextBefore != null) { cmdArgs.add("-B"); cmdArgs.add(contextBefore.toString()); }
            }
            if (globFilter != null) { cmdArgs.add("--include"); cmdArgs.add(globFilter); }
            if (headLimit != null) { cmdArgs.add("-m"); cmdArgs.add(headLimit.toString()); }
            cmdArgs.add(pattern);
            cmdArgs.add(resolvedPath);
        }

        var result = runCommand(cmdArgs, projectRoot, 60);
        if (result.exitCode == 0 || result.exitCode == 1) {
            return toolOk(sanitizeSecrets(truncateOutput(result.output.strip())));
        }
        return Json.obj("success", false, "output", result.output,
                         "error", result.error.isEmpty() ? "grep failed" : result.error);
    }

    // -- glob --

    static Map<String, Object> handleGlob(Map<String, Object> args, String projectRoot) {
        String pattern = strArg(args, "pattern", "");
        if (pattern.isEmpty()) return toolError("pattern is required");

        String searchPath = strArg(args, "path", projectRoot);
        var v = validatePath(searchPath, projectRoot);
        if (!v.ok()) return toolError(v.error());

        Path base = Path.of(v.resolved());
        if (!Files.isDirectory(base)) return toolError("Not a directory: " + v.resolved());

        try {
            var results = new ArrayList<String>();
            int limit = 1000;
            globWalk(base, pattern, base, projectRoot, results, limit);
            Collections.sort(results);
            String output = String.join("\n", results);
            if (results.size() >= limit) output += "\n[results limited to " + limit + "]";
            return toolOk(output);
        } catch (Exception e) {
            return toolError(e.getMessage());
        }
    }

    static void globWalk(Path dir, String pattern, Path root, String projectRoot,
                         List<String> results, int limit) {
        if (results.size() >= limit) return;
        try (var stream = Files.list(dir)) {
            for (Path entry : stream.toList()) {
                if (results.size() >= limit) break;
                String name = entry.getFileName().toString();
                if (name.startsWith(".")) continue;

                // Check symlinks
                if (Files.isSymbolicLink(entry)) {
                    try {
                        Path real = entry.toRealPath();
                        String normReal = normalizeForComparison(real.toString());
                        String normRoot = normalizeForComparison(projectRoot);
                        if (!normReal.equals(normRoot) && !normReal.startsWith(normRoot + "/")) {
                            continue;
                        }
                    } catch (IOException e) { continue; }
                }

                String relPath = root.relativize(entry).toString().replace('\\', '/');

                if (Files.isDirectory(entry)) {
                    globWalk(entry, pattern, root, projectRoot, results, limit);
                } else {
                    if (globMatch(pattern, relPath)) {
                        results.add(entry.toString());
                    }
                }
            }
        } catch (IOException ignored) {}
    }

    static boolean globMatch(String pattern, String filePath) {
        String normPattern = pattern.replace('\\', '/');
        String normPath = filePath.replace('\\', '/');
        String regex = globToRegex(normPattern);
        try {
            int flags = (IS_MACOS || IS_WINDOWS) ? Pattern.CASE_INSENSITIVE : 0;
            return Pattern.compile("^" + regex + "$", flags).matcher(normPath).matches();
        } catch (PatternSyntaxException e) {
            return false;
        }
    }

    static String globToRegex(String pattern) {
        var sb = new StringBuilder();
        int i = 0;
        while (i < pattern.length()) {
            char ch = pattern.charAt(i);
            if (ch == '*' && i + 1 < pattern.length() && pattern.charAt(i + 1) == '*') {
                if (i + 2 < pattern.length() && pattern.charAt(i + 2) == '/') {
                    sb.append("(?:.+/)?");
                    i += 3;
                } else {
                    sb.append(".*");
                    i += 2;
                }
            } else if (ch == '*') {
                sb.append("[^/]*");
                i++;
            } else if (ch == '?') {
                sb.append("[^/]");
                i++;
            } else if (ch == '{') {
                int close = pattern.indexOf('}', i);
                if (close != -1) {
                    String inner = pattern.substring(i + 1, close);
                    String[] alts = inner.split(",");
                    sb.append("(?:");
                    for (int a = 0; a < alts.length; a++) {
                        if (a > 0) sb.append('|');
                        sb.append(Pattern.quote(alts[a]));
                    }
                    sb.append(')');
                    i = close + 1;
                } else {
                    sb.append(Pattern.quote(String.valueOf(ch)));
                    i++;
                }
            } else {
                sb.append(Pattern.quote(String.valueOf(ch)));
                i++;
            }
        }
        return sb.toString();
    }

    // -- bash --

    static Map<String, Object> handleBash(String callId, Map<String, Object> args,
                                           String projectRoot, boolean readOnly,
                                           java.util.function.Consumer<Map<String, Object>> wsSend) {
        if (readOnly) return toolError("Worker is in read-only mode");

        String command = strArg(args, "command", "");
        if (command.isEmpty()) return toolError("command is required");

        String cwd = strArg(args, "cwd", projectRoot);
        var cwdV = validatePath(cwd, projectRoot);
        if (!cwdV.ok()) return toolError("Invalid cwd: " + cwdV.error());

        long timeoutMs = args.containsKey("timeout")
            ? toLong(args.get("timeout"), 300_000)
            : 300_000;

        ShellCmd shell = resolveShell(command);
        var cmdList = new ArrayList<String>();
        cmdList.add(shell.exe());
        cmdList.addAll(shell.args());

        ProcessBuilder pb = new ProcessBuilder(cmdList);
        pb.directory(new File(cwdV.resolved()));
        pb.redirectInput(ProcessBuilder.Redirect.PIPE);
        // Don't merge — we capture separately
        pb.redirectErrorStream(false);

        Process proc;
        try {
            proc = pb.start();
            proc.getOutputStream().close(); // close stdin
        } catch (IOException e) {
            return toolError("Failed to start process: " + e.getMessage());
        }

        activeProcesses.put(callId, proc);

        var stdoutBuf = new StringBuilder();
        var stderrBuf = new StringBuilder();

        // Read stdout in virtual thread
        Thread outThread = Thread.ofVirtual().start(() -> {
            try (var reader = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buf = new char[4096];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    String chunk = new String(buf, 0, n);
                    stdoutBuf.append(chunk);
                    try {
                        wsSend.accept(Json.obj("type", "stdout", "id", callId, "data", sanitizeSecrets(chunk)));
                    } catch (Exception ignored) {}
                }
            } catch (IOException ignored) {}
        });

        // Read stderr in virtual thread
        Thread errThread = Thread.ofVirtual().start(() -> {
            try (var reader = new BufferedReader(new InputStreamReader(proc.getErrorStream(), StandardCharsets.UTF_8))) {
                char[] buf = new char[4096];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    String chunk = new String(buf, 0, n);
                    stderrBuf.append(chunk);
                    try {
                        wsSend.accept(Json.obj("type", "stderr", "id", callId, "data", sanitizeSecrets(chunk)));
                    } catch (Exception ignored) {}
                }
            } catch (IOException ignored) {}
        });

        boolean timedOut = false;
        try {
            if (!proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                timedOut = true;
                killProcessTree(proc.pid());
                proc.waitFor(10, TimeUnit.SECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
        }

        try { outThread.join(10_000); } catch (InterruptedException ignored) {}
        try { errThread.join(10_000); } catch (InterruptedException ignored) {}

        // Signal end of streaming
        try { wsSend.accept(Json.obj("type", "stream_end", "id", callId)); } catch (Exception ignored) {}

        activeProcesses.remove(callId);

        // If cancelled, don't send result
        if (cancelledCalls.remove(callId)) {
            return Json.obj("success", false, "output", "", "error", "Cancelled");
        }

        String stdout = stdoutBuf.toString();
        String stderr = stderrBuf.toString();
        String combined = stdout;
        if (!stderr.isEmpty()) {
            combined = combined + (combined.isEmpty() ? "" : "\n") + stderr;
        }
        combined = sanitizeSecrets(truncateOutput(combined));

        int exitCode = timedOut ? 124 : proc.exitValue();

        if (timedOut) {
            return Json.obj("success", false, "output", combined,
                            "error", "Command timed out after " + timeoutMs + "ms",
                            "exitCode", exitCode);
        }

        return Json.obj("success", exitCode == 0, "output", combined,
                         "error", exitCode != 0 ? "Exit code: " + exitCode : null,
                         "exitCode", exitCode);
    }

    // -----------------------------------------------------------------------
    // Command runner helper (for grep fallback)
    // -----------------------------------------------------------------------

    record CmdResult(int exitCode, String output, String error) {}

    static CmdResult runCommand(List<String> cmd, String cwd, int timeoutSecs) {
        try {
            var pb = new ProcessBuilder(cmd);
            if (cwd != null) pb.directory(new File(cwd));
            pb.redirectInput(ProcessBuilder.Redirect.PIPE);
            Process proc = pb.start();
            proc.getOutputStream().close();

            var stdout = new CompletableFuture<String>();
            var stderr = new CompletableFuture<String>();
            Thread.ofVirtual().start(() -> {
                try { stdout.complete(new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8)); }
                catch (IOException e) { stdout.complete(""); }
            });
            Thread.ofVirtual().start(() -> {
                try { stderr.complete(new String(proc.getErrorStream().readAllBytes(), StandardCharsets.UTF_8)); }
                catch (IOException e) { stderr.complete(""); }
            });

            boolean done = proc.waitFor(timeoutSecs, TimeUnit.SECONDS);
            if (!done) {
                proc.destroyForcibly();
                return new CmdResult(124, "", "Command timed out after " + timeoutSecs + "s");
            }

            return new CmdResult(proc.exitValue(),
                stdout.get(5, TimeUnit.SECONDS),
                stderr.get(5, TimeUnit.SECONDS));
        } catch (Exception e) {
            return new CmdResult(127, "", e.getMessage());
        }
    }

    static String findExecutable(String name) {
        if (IS_WINDOWS) {
            try {
                var proc = new ProcessBuilder("where", name).redirectErrorStream(true).start();
                String out = new String(proc.getInputStream().readAllBytes()).trim();
                proc.waitFor(5, TimeUnit.SECONDS);
                if (proc.exitValue() == 0 && !out.isEmpty()) return out.lines().findFirst().orElse(null);
            } catch (Exception ignored) {}
            return null;
        }
        // Unix: check PATH
        String pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            for (String dir : pathEnv.split(File.pathSeparator)) {
                Path p = Path.of(dir, name);
                if (Files.isExecutable(p)) return p.toString();
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Browser CDP support
    // -----------------------------------------------------------------------

    static volatile ChromeManager chromeManager;
    static final java.util.concurrent.ConcurrentHashMap<String, String[]> scriptStore = new java.util.concurrent.ConcurrentHashMap<>();
    // scriptStore maps key -> [code, description]
    static final int STORE_MAX_SCRIPTS = 100;
    static final int STORE_MAX_SCRIPT_SIZE = 1_000_000; // 1MB
    static final int STORE_MAX_KEY_LEN = 256;
    static volatile Config activeConfig;

    static String findChromeBinary() {
        // Detect system default browser to prefer it
        String defaultBrowser = detectDefaultBrowser();

        List<String> candidates;
        if (IS_MACOS) {
            candidates = new ArrayList<>(List.of(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
            ));
            // If default is Chrome, move it first; if Edge, keep Edge first (already default order)
            if ("chrome".equals(defaultBrowser)) {
                candidates.remove("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
                candidates.add(0, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
            }
        } else if (IS_WINDOWS) {
            candidates = new ArrayList<>();
            boolean preferEdge = "edge".equals(defaultBrowser);
            for (String envVar : List.of("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")) {
                String base = System.getenv(envVar);
                if (base != null) {
                    String chrome = Path.of(base, "Google", "Chrome", "Application", "chrome.exe").toString();
                    String edge = Path.of(base, "Microsoft", "Edge", "Application", "msedge.exe").toString();
                    if (preferEdge) {
                        candidates.add(edge);
                        candidates.add(chrome);
                    } else {
                        candidates.add(chrome);
                        candidates.add(edge);
                    }
                }
            }
        } else {
            candidates = new ArrayList<>(List.of(
                "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium", "/usr/bin/chromium-browser",
                "/snap/bin/chromium", "/usr/bin/microsoft-edge"
            ));
        }
        for (String c : candidates) {
            if (Files.isRegularFile(Path.of(c))) return c;
        }
        // which fallback — respect system default preference
        List<String> fallback;
        if (IS_WINDOWS) {
            fallback = "edge".equals(defaultBrowser)
                ? List.of("msedge", "chrome", "google-chrome", "chromium", "microsoft-edge")
                : List.of("chrome", "google-chrome", "msedge", "chromium", "microsoft-edge");
        } else {
            fallback = List.of("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge");
        }
        for (String name : fallback) {
            String path = findExecutable(name);
            if (path != null) return path;
        }
        return null;
    }

    /** Detect system default browser: returns "edge", "chrome", or null */
    static String detectDefaultBrowser() {
        try {
            if (IS_WINDOWS) {
                var proc = new ProcessBuilder("reg", "query",
                    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
                    "/v", "ProgId")
                    .redirectErrorStream(true).start();
                boolean finished = proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
                if (!finished) { proc.destroyForcibly(); return null; }
                String output = new String(proc.getInputStream().readAllBytes()).toLowerCase();
                if (output.contains("chromehtml")) return "chrome";
                if (output.contains("msedgehtm")) return "edge";
            } else if (IS_MACOS) {
                // Use `open -Ra` to find the actual HTTP handler app
                var proc = new ProcessBuilder("/usr/bin/open", "-Ra", "http://example.com")
                    .redirectErrorStream(true).start();
                boolean finished = proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
                if (!finished) { proc.destroyForcibly(); return null; }
                String output = new String(proc.getInputStream().readAllBytes()).toLowerCase();
                if (output.contains("microsoft edge")) return "edge";
                if (output.contains("google chrome")) return "chrome";
            }
        } catch (Exception ignored) {}
        return null;
    }

    static final class CdpClient implements AutoCloseable {
        private final java.net.http.WebSocket ws;
        private final AtomicInteger nextId = new AtomicInteger(1);
        private final ConcurrentHashMap<Integer, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();
        private final ConcurrentHashMap<String, List<java.util.function.Consumer<Map<String, Object>>>> eventListeners = new ConcurrentHashMap<>();

        @SuppressWarnings("unchecked")
        CdpClient(String wsUrl) {
            this.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create(wsUrl), new java.net.http.WebSocket.Listener() {
                    final StringBuilder buf = new StringBuilder();
                    @Override
                    public CompletionStage<?> onText(java.net.http.WebSocket webSocket, CharSequence data, boolean last) {
                        buf.append(data);
                        if (last) {
                            String text = buf.toString();
                            buf.setLength(0);
                            try {
                                var msg = (Map<String, Object>) Json.parse(text);
                                var id = msg.get("id");
                                if (id instanceof Number n && pending.containsKey(n.intValue())) {
                                    pending.get(n.intValue()).complete(msg);
                                } else if (msg.containsKey("method")) {
                                    String method = String.valueOf(msg.get("method"));
                                    var listeners = eventListeners.get(method);
                                    if (listeners != null) {
                                        var params = msg.get("params") instanceof Map<?,?> p ? (Map<String, Object>) p : Map.<String, Object>of();
                                        for (var cb : listeners) {
                                            try { cb.accept(params); } catch (Exception ignored) {}
                                        }
                                    }
                                }
                            } catch (Exception ignored) {}
                        }
                        webSocket.request(1);
                        return null;
                    }
                    @Override
                    public void onOpen(java.net.http.WebSocket webSocket) { webSocket.request(1); }
                    @Override
                    public CompletionStage<?> onClose(java.net.http.WebSocket webSocket, int code, String reason) {
                        var ex = new RuntimeException("CDP WebSocket closed (code=" + code + ")");
                        pending.values().forEach(f -> f.completeExceptionally(ex));
                        pending.clear();
                        return null;
                    }
                    @Override
                    public void onError(java.net.http.WebSocket webSocket, Throwable error) {
                        pending.values().forEach(f -> f.completeExceptionally(error));
                        pending.clear();
                    }
                }).join();
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> send(String method, Map<String, Object> params, String sessionId, int timeoutSec) {
            int id = nextId.getAndIncrement();
            var future = new CompletableFuture<Map<String, Object>>();
            pending.put(id, future);
            var msg = new LinkedHashMap<String, Object>();
            msg.put("id", id);
            msg.put("method", method);
            if (params != null) msg.put("params", params);
            if (sessionId != null) msg.put("sessionId", sessionId);
            ws.sendText(Json.serialize(msg), true).join();
            try {
                var result = future.get(timeoutSec, TimeUnit.SECONDS);
                pending.remove(id);
                if (result.containsKey("error")) {
                    var err = result.get("error") instanceof Map<?,?> e ? (Map<String, Object>) e : Map.<String, Object>of();
                    throw new RuntimeException("CDP error: " + err.getOrDefault("message", result.get("error")));
                }
                return result.get("result") instanceof Map<?,?> r ? (Map<String, Object>) r : Map.of();
            } catch (java.util.concurrent.TimeoutException e) {
                pending.remove(id);
                throw new RuntimeException("CDP timeout: " + method);
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                pending.remove(id);
                throw new RuntimeException("CDP error: " + e.getMessage());
            }
        }

        Map<String, Object> send(String method) { return send(method, null, null, 30); }
        Map<String, Object> send(String method, Map<String, Object> params) { return send(method, params, null, 30); }
        Map<String, Object> send(String method, Map<String, Object> params, String sessionId) { return send(method, params, sessionId, 30); }

        void on(String event, java.util.function.Consumer<Map<String, Object>> callback) {
            eventListeners.computeIfAbsent(event, k -> new CopyOnWriteArrayList<>()).add(callback);
        }

        @Override
        public void close() {
            try { ws.sendClose(java.net.http.WebSocket.NORMAL_CLOSURE, "close").join(); }
            catch (Exception ignored) {}
        }
    }

    static final class ChromeManager {
        final String chromePath;
        final String profile;
        final int cdpPort;
        volatile Process process;
        volatile CdpClient cdp;
        volatile String pageSession;
        final java.util.concurrent.ConcurrentLinkedDeque<Map<String, Object>> dialogQueue = new java.util.concurrent.ConcurrentLinkedDeque<>();
        final java.util.concurrent.ConcurrentLinkedDeque<Map<String, Object>> authQueue = new java.util.concurrent.ConcurrentLinkedDeque<>();
        final java.util.concurrent.CopyOnWriteArrayList<Map<String, Object>> downloads = new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile String downloadPath;
        private Path tempDir;
        private final Path profileDir;

        ChromeManager(String chromePath, String profile) {
            this.chromePath = chromePath;
            this.profile = profile;
            this.cdpPort = 9222 + (int) (ProcessHandle.current().pid() % 1000);
            try {
                this.downloadPath = Files.createTempDirectory("clawd-downloads-").toString();
            } catch (IOException e) {
                this.downloadPath = System.getProperty("java.io.tmpdir") + "/clawd-downloads-" + ProcessHandle.current().pid();
                new File(this.downloadPath).mkdirs();
            }
            if (profile != null && !profile.isEmpty()) {
                this.profileDir = Path.of(System.getProperty("user.home"), ".clawd", "browser-profiles", profile);
                try { Files.createDirectories(profileDir); } catch (IOException ignored) {}
                this.tempDir = null;
            } else {
                try {
                    this.tempDir = Files.createTempDirectory("clawd-browser-" + ProcessHandle.current().pid() + "-");
                } catch (IOException e) {
                    throw new RuntimeException("Cannot create temp dir: " + e.getMessage());
                }
                this.profileDir = tempDir;
            }
        }

        @SuppressWarnings("unchecked")
        void launch() throws Exception {
            boolean hasDisplay = System.getenv("DISPLAY") != null || System.getenv("WAYLAND_DISPLAY") != null || IS_MACOS || IS_WINDOWS;
            var chromeArgs = new ArrayList<>(List.of(
                chromePath,
                "--remote-debugging-port=" + cdpPort,
                "--user-data-dir=" + profileDir,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-sync"
            ));
            if (!IS_MACOS && !IS_WINDOWS) chromeArgs.add("--no-sandbox");
            chromeArgs.add("--disable-default-apps");
            chromeArgs.add("--disable-features=TranslateUI");
            if (!hasDisplay) chromeArgs.add("--headless=new");
            process = new ProcessBuilder(chromeArgs)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();

            // Wait for CDP port
            for (int attempt = 0; attempt < 30; attempt++) {
                Thread.sleep(500);
                try (var sock = new java.net.Socket()) {
                    sock.connect(new java.net.InetSocketAddress("127.0.0.1", cdpPort), 1000);
                    break;
                } catch (IOException e) {
                    if (attempt == 29) throw new RuntimeException("Chrome CDP port not available after 15s");
                }
            }

            // Get WebSocket URL
            String wsUrl = null;
            var client = HttpClient.newHttpClient();
            for (int i = 0; i < 10; i++) {
                try {
                    var req = java.net.http.HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + cdpPort + "/json/version"))
                        .GET().build();
                    var resp = client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
                    var data = (Map<String, Object>) Json.parse(resp.body());
                    wsUrl = String.valueOf(data.get("webSocketDebuggerUrl"));
                    if (wsUrl != null && !wsUrl.equals("null")) break;
                } catch (Exception e) {
                    Thread.sleep(300);
                }
            }
            if (wsUrl == null || wsUrl.equals("null")) {
                throw new RuntimeException("Could not get CDP WebSocket URL");
            }

            cdp = new CdpClient(wsUrl);

            // Attach to first page
            var targets = cdp.send("Target.getTargets");
            var targetInfos = targets.get("targetInfos") instanceof List<?> l ? l : List.of();
            String targetId = null;
            for (var t : targetInfos) {
                if (t instanceof Map<?,?> m && "page".equals(m.get("type"))) {
                    targetId = String.valueOf(m.get("targetId"));
                    break;
                }
            }
            if (targetId == null) {
                var result = cdp.send("Target.createTarget", Map.of("url", "about:blank"));
                targetId = String.valueOf(result.get("targetId"));
            }
            var attach = cdp.send("Target.attachToTarget", Map.of("targetId", targetId, "flatten", true));
            pageSession = String.valueOf(attach.get("sessionId"));

            // Enable domains
            for (String domain : List.of("Page", "DOM", "Runtime", "Network")) {
                cdp.send(domain + ".enable", Map.of(), pageSession);
            }

            // Dialog listener
            cdp.on("Page.javascriptDialogOpening", params -> dialogQueue.addLast(params));
            // Register Fetch handlers BEFORE enabling to avoid race condition
            cdp.on("Fetch.authRequired", params -> authQueue.addLast(params));
            cdp.on("Fetch.requestPaused", params -> {
                // Continue non-auth requests transparently
                try { cdp.send("Fetch.continueRequest", Map.of("requestId", params.get("requestId")), pageSession); } catch (Exception ignored) {}
            });
            // Enable Fetch domain for HTTP auth interception (after handlers registered)
            try {
                cdp.send("Fetch.enable", Map.of("handleAuthRequests", true), pageSession);
            } catch (Exception ignored) {}

            // Configure downloads
            new File(downloadPath).mkdirs();
            cdp.send("Browser.setDownloadBehavior", Map.of(
                "behavior", "allowAndName",
                "downloadPath", downloadPath,
                "eventsEnabled", true
            ));
            cdp.on("Browser.downloadWillBegin", params -> {
                var dl = new java.util.concurrent.ConcurrentHashMap<String, Object>();
                dl.put("guid", params.getOrDefault("guid", ""));
                dl.put("url", params.getOrDefault("url", ""));
                dl.put("filename", params.getOrDefault("suggestedFilename", ""));
                dl.put("state", "inProgress");
                dl.put("totalBytes", 0);
                dl.put("receivedBytes", 0);
                downloads.add(dl);
                // Cap at 100 entries
                while (downloads.size() > 100) downloads.remove(0);
            });
            cdp.on("Browser.downloadProgress", params -> {
                var guid = String.valueOf(params.get("guid"));
                for (var dl : downloads) {
                    if (guid.equals(dl.get("guid"))) {
                        dl.put("state", params.getOrDefault("state", dl.get("state")));
                        dl.put("totalBytes", params.getOrDefault("totalBytes", dl.get("totalBytes")));
                        dl.put("receivedBytes", params.getOrDefault("receivedBytes", dl.get("receivedBytes")));
                        if ("completed".equals(dl.get("state"))) {
                            var fname = String.valueOf(dl.get("filename"));
                            var safeName = fname.replace("/", "_").replace("\\", "_");
                            if (safeName.isEmpty()) safeName = "download";
                            dl.put("path", downloadPath + "/" + safeName);
                        }
                        break;
                    }
                }
            });
        }

        Map<String, Object> popDialog() {
            return dialogQueue.pollFirst();
        }

        Map<String, Object> popAuth() { return authQueue.pollFirst(); }

        void switchToTarget(String targetId) {
            if (pageSession != null) {
                try { cdp.send("Target.detachFromTarget", Map.of("sessionId", pageSession)); } catch (Exception ignored) {}
            }
            var attach = cdp.send("Target.attachToTarget", Map.of("targetId", targetId, "flatten", true));
            pageSession = String.valueOf(attach.get("sessionId"));
            for (String domain : List.of("Page", "DOM", "Runtime", "Network")) {
                cdp.send(domain + ".enable", Map.of(), pageSession);
            }
            try { cdp.send("Fetch.enable", Map.of("handleAuthRequests", true), pageSession); } catch (Exception ignored) {}
        }

        void shutdown() {
            if (cdp != null) {
                try { cdp.send("Browser.close", null, null, 3); } catch (Exception ignored) {}
                cdp.close();
            }
            if (process != null) {
                process.destroyForcibly();
            }
            if (tempDir != null) {
                try {
                    try (var walk = Files.walk(tempDir)) {
                        walk.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(java.io.File::delete);
                    }
                } catch (Exception ignored) {}
            }
        }
    }

    static ChromeManager startChromeManager(String profileArg) {
        String chrome = findChromeBinary();
        if (chrome == null) return null;
        var mgr = new ChromeManager(chrome, (profileArg != null && !profileArg.isEmpty()) ? profileArg : null);
        try {
            mgr.launch();
        } catch (Exception e) {
            log("Failed to launch Chrome: " + e.getMessage());
            return null;
        }
        chromeManager = mgr;
        return mgr;
    }

    /** Ensure the browser is running. Lazy-starts if --browser was given but chromeManager is null/dead. */
    static synchronized ChromeManager ensureBrowser() {
        if (chromeManager != null && chromeManager.cdp != null) {
            // Quick health check: try a simple CDP call
            try {
                chromeManager.cdp.send("Browser.getVersion", null, null, 3);
                return chromeManager; // healthy
            } catch (Exception e) {
                log("Browser CDP connection lost, restarting...");
                try { chromeManager.shutdown(); } catch (Exception ignored) {}
                chromeManager = null;
            }
        }
        if (activeConfig == null || activeConfig.browser() == null) {
            throw new RuntimeException("Browser not enabled. Start worker with --browser flag.");
        }
        var mgr = startChromeManager(activeConfig.browser());
        if (mgr == null) {
            throw new RuntimeException("Failed to start browser. Ensure Chrome or Edge is installed.");
        }
        return mgr;
    }

    @SuppressWarnings("unchecked")
    static Object cdpEvaluate(String expression, String sessionId) {
        var cm = chromeManager;
        if (cm == null || cm.cdp == null) throw new RuntimeException("Browser not available");
        var result = cm.cdp.send("Runtime.evaluate",
            Map.of("expression", expression, "returnByValue", true, "awaitPromise", true), sessionId);
        var exDetails = result.get("exceptionDetails");
        if (exDetails instanceof Map<?,?> ex) {
            String text = ex.get("text") != null ? String.valueOf(ex.get("text")) : "";
            var excObj = ex.get("exception");
            String desc = excObj instanceof Map<?,?> eo ? (eo.get("description") != null ? String.valueOf(eo.get("description")) : "") : "";
            throw new RuntimeException(("JS error: " + text + " " + desc).strip());
        }
        var res = result.get("result");
        if (res instanceof Map<?,?> r) return ((Map<?,?>)r).get("value");
        return null;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> resolveSelector(String selector, String sessionId) {
        var cm = chromeManager;
        if (cm == null || cm.cdp == null) throw new RuntimeException("Browser not available");
        var cdp = cm.cdp;
        var doc = cdp.send("DOM.getDocument", Map.of("depth", 0), sessionId);
        var root = (Map<String, Object>) doc.get("root");
        int rootNodeId = ((Number) root.get("nodeId")).intValue();
        var qResult = cdp.send("DOM.querySelector", Map.of("nodeId", rootNodeId, "selector", selector), sessionId);
        int nodeId = ((Number) qResult.getOrDefault("nodeId", 0)).intValue();
        if (nodeId == 0) throw new RuntimeException("Element not found: " + selector);
        var box = cdp.send("DOM.getBoxModel", Map.of("nodeId", nodeId), sessionId);
        var model = (Map<String, Object>) box.get("model");
        var content = (List<Number>) model.get("content");
        double cx = (content.get(0).doubleValue() + content.get(2).doubleValue() + content.get(4).doubleValue() + content.get(6).doubleValue()) / 4;
        double cy = (content.get(1).doubleValue() + content.get(3).doubleValue() + content.get(5).doubleValue() + content.get(7).doubleValue()) / 4;
        return Map.of("x", cx, "y", cy, "nodeId", nodeId);
    }

    // -----------------------------------------------------------------------
    // Browser tool handlers
    // -----------------------------------------------------------------------

    static Map<String, Object> handleBrowserStatus(Map<String, Object> args) {
        try {
            String url = String.valueOf(cdpEvaluate("window.location.href", chromeManager.pageSession));
            String title = String.valueOf(cdpEvaluate("document.title", chromeManager.pageSession));
            return toolOk(Json.serialize(Json.obj("url", url, "title", title)));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserNavigate(Map<String, Object> args) {
        String url = strArg(args, "url", "");
        if (url.isEmpty()) return toolError("url required");
        if (url.toLowerCase().startsWith("file://")) return toolError("file:// URLs are not allowed");
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            cdp.send("Page.navigate", Map.of("url", url), sid);
            long deadline = System.currentTimeMillis() + 30_000;
            boolean loaded = false;
            while (System.currentTimeMillis() < deadline) {
                try {
                    Object state = cdpEvaluate("document.readyState", sid);
                    if ("complete".equals(state)) { loaded = true; break; }
                } catch (Exception ignored) {}
                Thread.sleep(300);
            }
            String title = String.valueOf(cdpEvaluate("document.title", sid));
            String finalUrl = String.valueOf(cdpEvaluate("window.location.href", sid));
            var result = Json.obj("url", finalUrl, "title", title);
            if (!loaded) result.put("warning", "Page did not fully load within 30s");
            return toolOk(Json.serialize(result));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserScreenshot(Map<String, Object> args) {
        try {
            var params = new LinkedHashMap<String, Object>();
            params.put("format", "jpeg");
            params.put("quality", args.getOrDefault("quality", 80));
            String selector = strArg(args, "selector", "");
            if (!selector.isEmpty()) {
                var pos = resolveSelector(selector, chromeManager.pageSession);
                var box = chromeManager.cdp.send("DOM.getBoxModel", Map.of("nodeId", pos.get("nodeId")), chromeManager.pageSession);
                var content = (List<Number>) ((Map<?,?>)box.get("model")).get("content");
                double minX = Math.min(Math.min(content.get(0).doubleValue(), content.get(2).doubleValue()), Math.min(content.get(4).doubleValue(), content.get(6).doubleValue()));
                double minY = Math.min(Math.min(content.get(1).doubleValue(), content.get(3).doubleValue()), Math.min(content.get(5).doubleValue(), content.get(7).doubleValue()));
                double maxX = Math.max(Math.max(content.get(0).doubleValue(), content.get(2).doubleValue()), Math.max(content.get(4).doubleValue(), content.get(6).doubleValue()));
                double maxY = Math.max(Math.max(content.get(1).doubleValue(), content.get(3).doubleValue()), Math.max(content.get(5).doubleValue(), content.get(7).doubleValue()));
                params.put("clip", Json.obj("x", minX, "y", minY, "width", maxX - minX, "height", maxY - minY, "scale", 1));
            }
            var result = chromeManager.cdp.send("Page.captureScreenshot", params, chromeManager.pageSession);
            var out = new LinkedHashMap<String, Object>();
            out.put("success", true);
            out.put("output", result.getOrDefault("data", ""));
            out.put("mimeType", "image/jpeg");
            out.put("isBase64", true);
            return out;
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserClick(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            double x, y;
            if (args.containsKey("selector") && !strArg(args, "selector", "").isEmpty()) {
                var pos = resolveSelector(strArg(args, "selector", ""), sid);
                x = ((Number) pos.get("x")).doubleValue();
                y = ((Number) pos.get("y")).doubleValue();
            } else if (args.containsKey("x") && args.containsKey("y")) {
                x = ((Number) args.get("x")).doubleValue();
                y = ((Number) args.get("y")).doubleValue();
            } else {
                return toolError("selector or x,y required");
            }
            String btn = strArg(args, "button", "left");
            int clickCount = Boolean.TRUE.equals(args.get("double")) ? 2 : 1;
            // Move mouse to target first (triggers hover states, mouseenter events)
            cdp.send("Input.dispatchMouseEvent", Map.of(
                "type", "mouseMoved", "x", x, "y", y
            ), sid);
            for (String evtType : List.of("mousePressed", "mouseReleased")) {
                cdp.send("Input.dispatchMouseEvent", Map.of(
                    "type", evtType, "x", x, "y", y, "button", btn, "clickCount", clickCount
                ), sid);
            }
            return toolOk(String.format("Clicked at (%.0f, %.0f)", x, y));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserType(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            String text = strArg(args, "text", "");
            String selector = strArg(args, "selector", "");
            if (!selector.isEmpty()) {
                var pos = resolveSelector(selector, sid);
                for (String evt : List.of("mousePressed", "mouseReleased")) {
                    cdp.send("Input.dispatchMouseEvent", Map.of(
                        "type", evt, "x", pos.get("x"), "y", pos.get("y"), "button", "left", "clickCount", 1
                    ), sid);
                }
            }
            if (Boolean.TRUE.equals(args.get("clear"))) {
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyDown", "key", "a", "modifiers", 2), sid);
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyUp", "key", "a", "modifiers", 2), sid);
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyDown", "key", "Backspace"), sid);
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyUp", "key", "Backspace"), sid);
            }
            cdp.send("Input.insertText", Map.of("text", text), sid);
            if (Boolean.TRUE.equals(args.get("submit"))) {
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyDown", "key", "Enter"), sid);
                cdp.send("Input.dispatchKeyEvent", Map.of("type", "keyUp", "key", "Enter"), sid);
            }
            return toolOk("Typed " + text.length() + " characters");
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserExtract(Map<String, Object> args) {
        try {
            var sid = chromeManager.pageSession;
            String mode = strArg(args, "mode", "text");
            String selector = strArg(args, "selector", "");
            String expr;
            if (!selector.isEmpty() && "text".equals(mode)) {
                expr = "(document.querySelector(" + jsStr(selector) + "))?.innerText || ''";
            } else if (!selector.isEmpty() && "html".equals(mode)) {
                expr = "(document.querySelector(" + jsStr(selector) + "))?.outerHTML || ''";
            } else {
                expr = switch (mode) {
                    case "html" -> "document.documentElement.outerHTML";
                    case "links" -> "JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(a=>({text:a.textContent.trim(),href:a.href})).filter(l=>l.text||l.href))";
                    case "forms" -> "JSON.stringify(Array.from(document.querySelectorAll('form')).map(f=>({action:f.action,method:f.method,inputs:Array.from(f.querySelectorAll('input,select,textarea')).map(i=>({name:i.name,type:i.type,value:i.value}))})))";
                    case "tables" -> "JSON.stringify(Array.from(document.querySelectorAll('table')).map(t=>({headers:Array.from(t.querySelectorAll('th')).map(th=>th.textContent.trim()),rows:Array.from(t.querySelectorAll('tbody tr')).map(tr=>Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim()))})))";
                    case "accessibility" -> "JSON.stringify({title:document.title,lang:document.documentElement.lang,headings:Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h=>({level:h.tagName,text:h.textContent.trim()})),landmarks:Array.from(document.querySelectorAll('[role]')).map(e=>({role:e.getAttribute('role'),label:e.getAttribute('aria-label')||''}))})";
                    default -> "document.body.innerText";
                };
            }
            Object result = cdpEvaluate(expr, sid);
            String output = result instanceof String s ? s : Json.serialize(result);
            if (output.length() > 100000) output = output.substring(0, 100000) + "\n... (truncated)";
            return toolOk(output);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserTabs(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            String action = strArg(args, "action", "list");
            return switch (action) {
                case "list" -> {
                    var targets = cdp.send("Target.getTargets");
                    var pages = new ArrayList<Map<String, Object>>();
                    for (var t : (List<?>) targets.getOrDefault("targetInfos", List.of())) {
                        if (t instanceof Map<?,?> m && "page".equals(m.get("type"))) {
                            var url = m.get("url") != null ? m.get("url") : "";
                            var title = m.get("title") != null ? m.get("title") : "";
                            pages.add(Json.obj("id", m.get("targetId"), "url", url, "title", title));
                        }
                    }
                    yield toolOk(Json.serialize(pages));
                }
                case "new" -> {
                    String url = strArg(args, "url", "about:blank");
                    var result = cdp.send("Target.createTarget", Map.of("url", url));
                    String tid = String.valueOf(result.get("targetId"));
                    chromeManager.switchToTarget(tid);
                    yield toolOk(Json.serialize(Json.obj("targetId", tid)));
                }
                case "close" -> {
                    String tid = strArg(args, "targetId", "");
                    if (tid.isEmpty()) yield toolError("targetId required");
                    cdp.send("Target.closeTarget", Map.of("targetId", tid));
                    yield toolOk("Closed tab " + tid);
                }
                case "switch" -> {
                    String tid = strArg(args, "targetId", "");
                    if (tid.isEmpty()) yield toolError("targetId required");
                    cdp.send("Target.activateTarget", Map.of("targetId", tid));
                    chromeManager.switchToTarget(tid);
                    yield toolOk("Switched to tab " + tid);
                }
                default -> toolError("Unknown action: " + action);
            };
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserExecute(Map<String, Object> args) {
        try {
            String code = strArg(args, "code", "");
            String scriptId = strArg(args, "script_id", "");
            String wrapped;
            if (!scriptId.isEmpty()) {
                String[] stored = scriptStore.get(scriptId);
                if (stored == null) return toolError("Script '" + scriptId + "' not found. Use browser_store action=set first.");
                String argsJson = "{}";
                var scriptArgs = args.get("script_args");
                if (scriptArgs != null) argsJson = Json.serialize(scriptArgs);
                wrapped = "(async function(){const __args=" + argsJson + ";" + stored[0] + "})()";
            } else {
                if (code.isEmpty()) return toolError("Either 'code' or 'script_id' is required");
                wrapped = "(async()=>{" + code + "})()";
            }
            Object result = cdpEvaluate(wrapped, chromeManager.pageSession);
            String output = result instanceof String s ? s : Json.serialize(result);
            return toolOk(output);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserStore(Map<String, Object> args) {
        try {
            String action = strArg(args, "action", "list");
            if ("set".equals(action)) {
                String key = strArg(args, "key", "");
                String value = strArg(args, "value", "");
                if (key.isEmpty()) return toolError("key is required");
                if (value.isEmpty()) return toolError("value is required");
                if (key.length() > STORE_MAX_KEY_LEN) return toolError("key too long (max " + STORE_MAX_KEY_LEN + " chars)");
                if (value.length() > STORE_MAX_SCRIPT_SIZE) return toolError("script too large (max " + STORE_MAX_SCRIPT_SIZE + " bytes)");
                if (!scriptStore.containsKey(key) && scriptStore.size() >= STORE_MAX_SCRIPTS) return toolError("store full (max " + STORE_MAX_SCRIPTS + " scripts)");
                String desc = strArg(args, "description", "");
                scriptStore.put(key, new String[]{value, desc});
                return toolOk(Json.serialize(Map.of("stored", true, "key", key)));
            } else if ("get".equals(action)) {
                String key = strArg(args, "key", "");
                if (key.isEmpty()) return toolError("key is required");
                String[] item = scriptStore.get(key);
                if (item == null) return toolOk(Json.serialize(Map.of("found", false)));
                return toolOk(Json.serialize(Map.of("found", true, "key", key, "value", item[0], "description", item[1])));
            } else if ("list".equals(action)) {
                var items = new java.util.ArrayList<Map<String,Object>>();
                scriptStore.forEach((k, v) -> items.add(Map.of("key", k, "description", v[1], "size", v[0].length())));
                return toolOk(Json.serialize(Map.of("count", items.size(), "items", items)));
            } else if ("delete".equals(action)) {
                String key = strArg(args, "key", "");
                if (key.isEmpty()) return toolError("key is required");
                boolean deleted = scriptStore.remove(key) != null;
                return toolOk(Json.serialize(Map.of("deleted", deleted)));
            } else if ("clear".equals(action)) {
                int count = scriptStore.size();
                scriptStore.clear();
                return toolOk(Json.serialize(Map.of("cleared", count)));
            }
            return toolError("Unknown action: " + action);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserAuth(Map<String, Object> args) {
        try {
            String action = strArg(args, "action", "status");
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            if ("status".equals(action)) {
                var auth = chromeManager.authQueue.peekFirst();
                if (auth == null) return toolOk(Json.serialize(Map.of("pending", false)));
                @SuppressWarnings("unchecked") var challenge = (Map<String,Object>)auth.getOrDefault("authChallenge", Map.of());
                @SuppressWarnings("unchecked") var request = (Map<String,Object>)auth.getOrDefault("request", Map.of());
                return toolOk(Json.serialize(Map.of(
                    "pending", true,
                    "url", String.valueOf(request.getOrDefault("url", "")),
                    "scheme", String.valueOf(challenge.getOrDefault("scheme", "")),
                    "realm", String.valueOf(challenge.getOrDefault("realm", ""))
                )));
            } else if ("provide".equals(action)) {
                var auth = chromeManager.popAuth();
                if (auth == null) return toolError("No pending auth challenge");
                String requestId = String.valueOf(auth.get("requestId"));
                String username = strArg(args, "username", "");
                String password = strArg(args, "password", "");
                cdp.send("Fetch.continueWithAuth", Map.of(
                    "requestId", requestId,
                    "authChallengeResponse", Map.of("response", "ProvideCredentials", "username", username, "password", password)
                ), sid);
                return toolOk(Json.serialize(Map.of("authenticated", true)));
            } else if ("cancel".equals(action)) {
                var auth = chromeManager.popAuth();
                if (auth == null) return toolError("No pending auth challenge");
                String requestId = String.valueOf(auth.get("requestId"));
                cdp.send("Fetch.continueWithAuth", Map.of(
                    "requestId", requestId,
                    "authChallengeResponse", Map.of("response", "CancelAuth")
                ), sid);
                return toolOk(Json.serialize(Map.of("cancelled", true)));
            }
            return toolError("Unknown action: " + action);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserPermissions(Map<String, Object> args) {
        try {
            String action = strArg(args, "action", "grant");
            @SuppressWarnings("unchecked")
            var perms = args.get("permissions") instanceof List<?> l ? (List<String>)(List<?>)l : List.<String>of();
            String origin = strArg(args, "origin", null);
            // Map friendly names to CDP PermissionType
            var permMap = Map.of(
                "camera", "videoCapture", "microphone", "audioCapture",
                "clipboard-read", "clipboardReadWrite", "clipboard-write", "clipboardSanitizedWrite",
                "background-sync", "backgroundSync", "screen-wake-lock", "wakeLockScreen"
            );
            var cdpPerms = perms.stream().map(p -> permMap.getOrDefault(p, p)).toList();
            if ("grant".equals(action)) {
                if (cdpPerms.isEmpty()) return toolError("permissions array is required");
                var params = new LinkedHashMap<String, Object>();
                params.put("permissions", cdpPerms);
                if (origin != null) params.put("origin", origin);
                chromeManager.cdp.send("Browser.grantPermissions", params, null);
                return toolOk(Json.serialize(Map.of("granted", cdpPerms)));
            } else if ("deny".equals(action)) {
                var params = new LinkedHashMap<String, Object>();
                if (origin != null) params.put("origin", origin);
                chromeManager.cdp.send("Browser.resetPermissions", params, null);
                return toolOk(Json.serialize(Map.of("denied", cdpPerms, "note", "Permissions reset (CDP has no explicit deny)")));
            } else if ("reset".equals(action)) {
                var params = new LinkedHashMap<String, Object>();
                if (origin != null) params.put("origin", origin);
                chromeManager.cdp.send("Browser.resetPermissions", params, null);
                return toolOk(Json.serialize(Map.of("reset", true)));
            }
            return toolError("Unknown action: " + action);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserScroll(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            String direction = strArg(args, "direction", "down");
            int amount = args.get("amount") instanceof Number n ? n.intValue() : 300;
            double x = args.get("x") instanceof Number n ? n.doubleValue() : 100;
            double y = args.get("y") instanceof Number n ? n.doubleValue() : 100;
            String selector = strArg(args, "selector", "");
            if (!selector.isEmpty()) {
                var pos = resolveSelector(selector, sid);
                x = ((Number) pos.get("x")).doubleValue();
                y = ((Number) pos.get("y")).doubleValue();
            }
            int dx = 0, dy = 0;
            switch (direction) {
                case "down" -> dy = amount;
                case "up" -> dy = -amount;
                case "right" -> dx = amount;
                case "left" -> dx = -amount;
            }
            cdp.send("Input.dispatchMouseEvent", Map.of(
                "type", "mouseWheel", "x", x, "y", y, "deltaX", dx, "deltaY", dy
            ), sid);
            return toolOk("Scrolled " + direction + " by " + amount + "px");
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static final Map<String, int[]> KEY_MAP = Map.ofEntries(
        Map.entry("Enter", new int[]{13}), Map.entry("Tab", new int[]{9}),
        Map.entry("Escape", new int[]{27}), Map.entry("Backspace", new int[]{8}),
        Map.entry("Delete", new int[]{46}), Map.entry("Space", new int[]{32}),
        Map.entry("ArrowUp", new int[]{38}), Map.entry("ArrowDown", new int[]{40}),
        Map.entry("ArrowLeft", new int[]{37}), Map.entry("ArrowRight", new int[]{39}),
        Map.entry("Home", new int[]{36}), Map.entry("End", new int[]{35}),
        Map.entry("PageUp", new int[]{33}), Map.entry("PageDown", new int[]{34}),
        Map.entry("F1", new int[]{112}), Map.entry("F2", new int[]{113}),
        Map.entry("F3", new int[]{114}), Map.entry("F4", new int[]{115}),
        Map.entry("F5", new int[]{116}), Map.entry("F6", new int[]{117}),
        Map.entry("F7", new int[]{118}), Map.entry("F8", new int[]{119}),
        Map.entry("F9", new int[]{120}), Map.entry("F10", new int[]{121}),
        Map.entry("F11", new int[]{122}), Map.entry("F12", new int[]{123})
    );

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserKeypress(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            String key = strArg(args, "key", "");
            if (key.isEmpty()) return toolError("key is required");
            var modifiersList = args.get("modifiers") instanceof List<?> l ? l : List.of();
            int modFlags = 0;
            for (var m : modifiersList) {
                switch (String.valueOf(m)) {
                    case "alt" -> modFlags |= 1;
                    case "ctrl" -> modFlags |= 2;
                    case "meta" -> modFlags |= 4;
                    case "shift" -> modFlags |= 8;
                }
            }
            var params = new LinkedHashMap<String, Object>();
            params.put("key", key);
            params.put("modifiers", modFlags);
            int[] keyInfo = KEY_MAP.get(key);
            if (keyInfo != null) {
                params.put("windowsVirtualKeyCode", keyInfo[0]);
            } else if (key.length() == 1) {
                params.put("text", key);
                params.put("windowsVirtualKeyCode", (int) Character.toUpperCase(key.charAt(0)));
            }
            var downParams = new LinkedHashMap<>(params);
            downParams.put("type", "keyDown");
            cdp.send("Input.dispatchKeyEvent", downParams, sid);
            var upParams = new LinkedHashMap<>(params);
            upParams.put("type", "keyUp");
            cdp.send("Input.dispatchKeyEvent", upParams, sid);
            return toolOk("Pressed " + key);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserWaitFor(Map<String, Object> args) {
        try {
            String selector = strArg(args, "selector", "");
            if (selector.isEmpty()) return toolError("selector required");
            int timeoutMs = args.get("timeout") instanceof Number n ? n.intValue() : 10000;
            boolean checkVisible = !(Boolean.FALSE.equals(args.get("visible")));
            var sid = chromeManager.pageSession;
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                String expr = checkVisible
                    ? "!!(function(){var el=document.querySelector(" + jsStr(selector) + ");if(!el)return false;var r=el.getBoundingClientRect();return r.width>0&&r.height>0;})()"
                    : "!!document.querySelector(" + jsStr(selector) + ")";
                Object found = cdpEvaluate(expr, sid);
                if (Boolean.TRUE.equals(found)) return toolOk("Found: " + selector);
                Thread.sleep(500);
            }
            return toolError("Timeout waiting for " + selector);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserSelect(Map<String, Object> args) {
        try {
            String selector = strArg(args, "selector", "");
            if (selector.isEmpty()) return toolError("selector required");
            var sid = chromeManager.pageSession;
            String expr;
            String value = strArg(args, "value", null);
            String text = strArg(args, "text", null);
            if (value != null) {
                expr = "(function(){var s=document.querySelector(" + jsStr(selector) + ");s.value=" + jsStr(value) + ";s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()";
            } else if (text != null) {
                expr = "(function(){var s=document.querySelector(" + jsStr(selector) + ");var o=Array.from(s.options).find(o=>o.text===" + jsStr(text) + ");if(o){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return o.value;}return null;})()";
            } else if (args.containsKey("index")) {
                int index = ((Number) args.get("index")).intValue();
                expr = "(function(){var s=document.querySelector(" + jsStr(selector) + ");s.selectedIndex=" + index + ";s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()";            } else {
                return toolError("value, text, or index required");
            }
            Object result = cdpEvaluate(expr, sid);
            return toolOk("Selected: " + result);
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserHover(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            double x, y;
            String selector = strArg(args, "selector", "");
            if (!selector.isEmpty()) {
                var pos = resolveSelector(selector, sid);
                x = ((Number) pos.get("x")).doubleValue();
                y = ((Number) pos.get("y")).doubleValue();
            } else if (args.containsKey("x") && args.containsKey("y")) {
                x = ((Number) args.get("x")).doubleValue();
                y = ((Number) args.get("y")).doubleValue();
            } else {
                return toolError("selector or x,y required");
            }
            cdp.send("Input.dispatchMouseEvent", Map.of("type", "mouseMoved", "x", x, "y", y), sid);
            return toolOk(String.format("Hovered at (%.0f, %.0f)", x, y));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserHistory(Map<String, Object> args) {
        try {
            String action = strArg(args, "action", "back");
            var sid = chromeManager.pageSession;
            var history = chromeManager.cdp.send("Page.getNavigationHistory", Map.of(), sid);
            int idx = ((Number) history.getOrDefault("currentIndex", 0)).intValue();
            var entries = (List<Map<String, Object>>) history.getOrDefault("entries", List.of());
            if ("back".equals(action) && idx > 0) {
                chromeManager.cdp.send("Page.navigateToHistoryEntry", Map.of("entryId", entries.get(idx - 1).get("id")), sid);
                return toolOk("Navigated back to " + entries.get(idx - 1).getOrDefault("url", ""));
            } else if ("forward".equals(action) && idx < entries.size() - 1) {
                chromeManager.cdp.send("Page.navigateToHistoryEntry", Map.of("entryId", entries.get(idx + 1).get("id")), sid);
                return toolOk("Navigated forward to " + entries.get(idx + 1).getOrDefault("url", ""));
            } else {
                return toolError("Cannot go " + action);
            }
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserDialog(Map<String, Object> args) {
        try {
            var dialog = chromeManager.popDialog();
            if (dialog == null) return toolOk(Json.serialize(Map.of("handled", false, "message", "No pending dialog")));
            String action = strArg(args, "action", "accept");
            var params = new LinkedHashMap<String, Object>();
            params.put("accept", "accept".equals(action));
            String promptText = strArg(args, "prompt_text", null);
            if (promptText != null) params.put("promptText", promptText);
            chromeManager.cdp.send("Page.handleJavaScriptDialog", params, chromeManager.pageSession);
            return toolOk(Json.serialize(Json.obj("type", dialog.getOrDefault("type", ""), "message", dialog.getOrDefault("message", ""), "action", action)));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static String getHttpBaseUrl() {
        var url = activeConfig.server();
        if (url.startsWith("wss://")) return "https://" + url.substring(6);
        if (url.startsWith("ws://")) return "http://" + url.substring(5);
        return url;
    }

    @SuppressWarnings("unchecked")
    static String downloadChatFile(String fileId) throws Exception {
        var url = getHttpBaseUrl() + "/api/files/" + URLEncoder.encode(fileId, StandardCharsets.UTF_8);
        var client = HttpClient.newHttpClient();
        var req = java.net.http.HttpRequest.newBuilder().uri(URI.create(url)).GET().build();
        var resp = client.send(req, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
        if (resp.statusCode() != 200) throw new RuntimeException("Failed to download file " + fileId + ": " + resp.statusCode());
        var bytes = resp.body();
        // Extract filename from Content-Disposition
        var name = fileId;
        var disposition = resp.headers().firstValue("Content-Disposition").orElse("");
        var m = java.util.regex.Pattern.compile("filename=\"?([^\";\r\n]+)\"?").matcher(disposition);
        if (m.find()) name = m.group(1);
        var dir = Path.of(System.getProperty("java.io.tmpdir"), "clawd-chat-files");
        Files.createDirectories(dir);
        var safeName = name.replace("/", "_").replace("\\", "_").replace("\0", "");
        if (safeName.isEmpty() || safeName.equals(".") || safeName.equals("..")) safeName = fileId;
        safeName = fileId.replace("/", "_").substring(0, Math.min(32, fileId.length())) + "_" + safeName;
        var path = dir.resolve(safeName);
        Files.write(path, bytes);
        return path.toString();
    }

    @SuppressWarnings("unchecked")
    static Map<String, String> uploadChatFile(String filePath) throws Exception {
        var file = Path.of(filePath);
        var name = file.getFileName().toString();
        var data = Files.readAllBytes(file);
        var mime = java.nio.file.Files.probeContentType(file);
        if (mime == null) mime = "application/octet-stream";
        var boundary = "----ClawdBoundary" + System.currentTimeMillis();
        var body = new java.io.ByteArrayOutputStream();
        body.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(("Content-Disposition: form-data; name=\"file\"; filename=\"" + name.replace("\"", "\\\"") + "\"\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(("Content-Type: " + mime + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(data);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        var url = getHttpBaseUrl() + "/api/files.upload";
        var client = HttpClient.newHttpClient();
        var req = java.net.http.HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()))
            .build();
        var resp = client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("Upload failed: " + resp.statusCode());
        var result = (Map<String, Object>) Json.parse(resp.body());
        if (!Boolean.TRUE.equals(result.get("ok"))) throw new RuntimeException(String.valueOf(result.getOrDefault("error", "Upload failed")));
        var fileInfo = (Map<String, Object>) result.get("file");
        return Map.of("id", String.valueOf(fileInfo.get("id")), "name", String.valueOf(fileInfo.get("name")));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserUpload(Map<String, Object> args) {
        var cm = chromeManager;
        if (cm == null || cm.cdp == null) return toolError("Browser not available");
        var tempFiles = new ArrayList<String>();
        try {
            var selector = strArg(args, "selector", "");
            var filesObj = args.get("files");
            if (selector.isEmpty()) return toolError("selector is required");
            var files = new ArrayList<String>();
            if (filesObj instanceof List<?> filesList && !filesList.isEmpty()) {
                for (var f : filesList) {
                    var path = String.valueOf(f);
                    if (!new File(path).isFile()) return toolError("File not found: " + path);
                    files.add(path);
                }
            }
            // Download chat files
            var fileIdsObj = args.get("file_ids");
            if (fileIdsObj instanceof List<?> fidList) {
                for (var fid : fidList) {
                    var tempPath = downloadChatFile(String.valueOf(fid));
                    tempFiles.add(tempPath);
                }
            }
            var allFiles = new ArrayList<>(files);
            allFiles.addAll(tempFiles);
            if (allFiles.isEmpty()) return toolError("files or file_ids required");
            var sid = cm.pageSession;
            var info = resolveSelector(selector, sid);
            var nodeId = ((Number) info.get("nodeId")).intValue();
            cm.cdp.send("DOM.setFileInputFiles", Map.of("files", allFiles, "nodeId", nodeId), sid);
            // Dispatch change and input events
            var js = "(() => { const el = document.querySelector(" + jsStr(selector) + "); if (el) { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); } })()";
            cm.cdp.send("Runtime.evaluate", Map.of("expression", js, "returnByValue", true), sid);
            for (var f : tempFiles) { try { Files.deleteIfExists(Path.of(f)); } catch (Exception ignored) {} }
            return toolOk("Uploaded " + allFiles.size() + " file(s) to " + selector);
        } catch (Exception e) {
            for (var f : tempFiles) { try { Files.deleteIfExists(Path.of(f)); } catch (Exception ignored) {} }
            return toolError(e.getMessage());
        }
    }

    static Map<String, Object> handleBrowserDownload(Map<String, Object> args) {
        var cm = chromeManager;
        if (cm == null || cm.cdp == null) return toolError("Browser not available");
        try {
            var action = strArg(args, "action", "list");
            if ("configure".equals(action)) {
                var path = strArg(args, "path", "");
                if (path.isEmpty()) return toolError("path is required for configure");
                // Validate path is under home or temp directory
                var resolved = Path.of(path).toAbsolutePath().normalize();
                var home = Path.of(System.getProperty("user.home"));
                var tmp = Path.of(System.getProperty("java.io.tmpdir"));
                if (!resolved.startsWith(home) && !resolved.startsWith(tmp)) {
                    return toolError("Download path must be under home or temp directory");
                }
                new File(path).mkdirs();
                cm.downloadPath = path;
                cm.cdp.send("Browser.setDownloadBehavior", Map.of(
                    "behavior", "allowAndName", "downloadPath", path, "eventsEnabled", true
                ));
                return toolOk("Download directory set to " + path);
            } else if ("wait".equals(action)) {
                var timeout = args.containsKey("timeout") ? ((Number) args.get("timeout")).longValue() : 30000L;
                var deadline = System.currentTimeMillis() + timeout;
                var startCount = cm.downloads.stream().filter(d -> "completed".equals(d.get("state"))).count();
                var startCanceledCount = cm.downloads.stream().filter(d -> "canceled".equals(d.get("state"))).count();
                while (System.currentTimeMillis() < deadline) {
                    var completed = cm.downloads.stream().filter(d -> "completed".equals(d.get("state"))).toList();
                    if (completed.size() > startCount) {
                        var latest = completed.get(completed.size() - 1);
                        Map<String, String> fileInfo = null;
                        if (boolArg(args, "upload", false) && latest.get("path") != null) {
                            try {
                                var dlPath = String.valueOf(latest.get("path"));
                                if (new File(dlPath).isFile()) {
                                    fileInfo = uploadChatFile(dlPath);
                                }
                            } catch (Exception ignored) {}
                        }
                        var resultMap = new java.util.LinkedHashMap<String, Object>();
                        resultMap.put("filename", latest.getOrDefault("filename", ""));
                        resultMap.put("path", latest.getOrDefault("path", ""));
                        resultMap.put("url", latest.getOrDefault("url", ""));
                        resultMap.put("totalBytes", latest.getOrDefault("totalBytes", 0));
                        if (fileInfo != null) {
                            resultMap.put("file_id", fileInfo.get("id"));
                            resultMap.put("file_name", fileInfo.get("name"));
                        }
                        return toolOk(Json.serialize(resultMap));
                    }
                    var canceledNow = cm.downloads.stream().filter(d -> "canceled".equals(d.get("state"))).toList();
                    if (canceledNow.size() > startCanceledCount) {
                        var latest = canceledNow.get(canceledNow.size() - 1);
                        return toolError("Download canceled: " + latest.getOrDefault("filename", "unknown"));
                    }
                    Thread.sleep(500);
                }
                return toolError("No download completed within " + timeout + "ms");
            } else if ("list".equals(action)) {
                var list = new ArrayList<Map<String, Object>>();
                for (var dl : cm.downloads) {
                    list.add(Map.of(
                        "filename", dl.getOrDefault("filename", ""),
                        "url", dl.getOrDefault("url", ""),
                        "state", dl.getOrDefault("state", ""),
                        "totalBytes", dl.getOrDefault("totalBytes", 0),
                        "receivedBytes", dl.getOrDefault("receivedBytes", 0),
                        "path", dl.getOrDefault("path", "")
                    ));
                }
                return toolOk(Json.serialize(list));
            } else {
                return toolError("Unknown action: " + action + ". Use 'configure', 'wait', or 'list'");
            }
        } catch (Exception e) {
            return toolError(e.getMessage());
        }
    }

    static Map<String, Object> handleBrowserMouseMove(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            var x = ((Number) args.get("x")).doubleValue();
            var y = ((Number) args.get("y")).doubleValue();
            var steps = args.containsKey("steps") ? ((Number) args.get("steps")).intValue() : 1;
            var fromX = args.containsKey("from_x") ? ((Number) args.get("from_x")).doubleValue() : 0.0;
            var fromY = args.containsKey("from_y") ? ((Number) args.get("from_y")).doubleValue() : 0.0;
            for (int i = 1; i <= steps; i++) {
                var px = fromX + (x - fromX) * ((double) i / steps);
                var py = fromY + (y - fromY) * ((double) i / steps);
                cdp.send("Input.dispatchMouseEvent", Map.of("type", "mouseMoved", "x", px, "y", py), sid);
            }
            return toolOk("Moved mouse to (" + (int) x + ", " + (int) y + ")");
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> handleBrowserDrag(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            double fromX, fromY, toX, toY;
            if (args.containsKey("from_selector")) {
                var pos = resolveSelector((String) args.get("from_selector"), sid);
                fromX = ((Number) pos.get("x")).doubleValue();
                fromY = ((Number) pos.get("y")).doubleValue();
            } else if (args.containsKey("from_x") && args.containsKey("from_y")) {
                fromX = ((Number) args.get("from_x")).doubleValue();
                fromY = ((Number) args.get("from_y")).doubleValue();
            } else {
                return toolError("from_selector or from_x/from_y required");
            }
            if (args.containsKey("to_selector")) {
                var pos = resolveSelector((String) args.get("to_selector"), sid);
                toX = ((Number) pos.get("x")).doubleValue();
                toY = ((Number) pos.get("y")).doubleValue();
            } else if (args.containsKey("to_x") && args.containsKey("to_y")) {
                toX = ((Number) args.get("to_x")).doubleValue();
                toY = ((Number) args.get("to_y")).doubleValue();
            } else {
                return toolError("to_selector or to_x/to_y required");
            }
            int steps = args.containsKey("steps") ? ((Number) args.get("steps")).intValue() : 10;
            cdp.send("Input.dispatchMouseEvent", Json.obj("type", "mousePressed", "x", fromX, "y", fromY, "button", "left", "clickCount", 1), sid);
            for (int i = 1; i <= steps; i++) {
                var px = fromX + (toX - fromX) * ((double) i / steps);
                var py = fromY + (toY - fromY) * ((double) i / steps);
                cdp.send("Input.dispatchMouseEvent", Json.obj("type", "mouseMoved", "x", px, "y", py, "button", "left"), sid);
                Thread.sleep(20);
            }
            cdp.send("Input.dispatchMouseEvent", Json.obj("type", "mouseReleased", "x", toX, "y", toY, "button", "left", "clickCount", 1), sid);
            return toolOk(String.format("Dragged from (%.0f, %.0f) to (%.0f, %.0f)", fromX, fromY, toX, toY));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    static Map<String, Object> touchPoint(double x, double y, int id) {
        return Json.obj("x", x, "y", y, "id", id, "radiusX", 1, "radiusY", 1, "force", 1);
    }

    static Map<String, Object> handleBrowserTouch(Map<String, Object> args) {
        try {
            var cdp = chromeManager.cdp;
            var sid = chromeManager.pageSession;
            String action = strArg(args, "action", "tap");
            double x = ((Number) args.get("x")).doubleValue();
            double y = ((Number) args.get("y")).doubleValue();
            switch (action) {
                case "tap" -> {
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchStart", "touchPoints", List.of(touchPoint(x, y, 0))), sid);
                    Thread.sleep(50);
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchEnd", "touchPoints", List.of()), sid);
                    return toolOk(String.format("Tapped at (%.0f, %.0f)", x, y));
                }
                case "swipe" -> {
                    double toX = args.containsKey("to_x") ? ((Number) args.get("to_x")).doubleValue() : x;
                    double toY = args.containsKey("to_y") ? ((Number) args.get("to_y")).doubleValue() : y;
                    int steps = args.containsKey("steps") ? ((Number) args.get("steps")).intValue() : 10;
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchStart", "touchPoints", List.of(touchPoint(x, y, 0))), sid);
                    for (int i = 1; i <= steps; i++) {
                        var px = x + (toX - x) * ((double) i / steps);
                        var py = y + (toY - y) * ((double) i / steps);
                        cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchMove", "touchPoints", List.of(touchPoint(px, py, 0))), sid);
                        Thread.sleep(20);
                    }
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchEnd", "touchPoints", List.of()), sid);
                    return toolOk(String.format("Swiped from (%.0f, %.0f) to (%.0f, %.0f)", x, y, toX, toY));
                }
                case "long-press" -> {
                    int duration = args.containsKey("duration") ? ((Number) args.get("duration")).intValue() : 500;
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchStart", "touchPoints", List.of(touchPoint(x, y, 0))), sid);
                    Thread.sleep(duration);
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchEnd", "touchPoints", List.of()), sid);
                    return toolOk(String.format("Long-pressed at (%.0f, %.0f) for %dms", x, y, duration));
                }
                case "pinch" -> {
                    double scale = args.containsKey("scale") ? ((Number) args.get("scale")).doubleValue() : 2.0;
                    int steps = args.containsKey("steps") ? ((Number) args.get("steps")).intValue() : 10;
                    double offset = 20.0;
                    var p0 = touchPoint(x - offset, y, 0);
                    var p1 = touchPoint(x + offset, y, 1);
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchStart", "touchPoints", List.of(p0, p1)), sid);
                    for (int i = 1; i <= steps; i++) {
                        double f = 1.0 + (scale - 1.0) * ((double) i / steps);
                        var mp0 = touchPoint(x - offset * f, y, 0);
                        var mp1 = touchPoint(x + offset * f, y, 1);
                        cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchMove", "touchPoints", List.of(mp0, mp1)), sid);
                        Thread.sleep(20);
                    }
                    cdp.send("Input.dispatchTouchEvent", Json.obj("type", "touchEnd", "touchPoints", List.of()), sid);
                    return toolOk(String.format("Pinched at (%.0f, %.0f) with scale %.1f", x, y, scale));
                }
                default -> { return toolError("Unknown touch action: " + action + ". Use tap, swipe, long-press, or pinch"); }
            }
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handleBrowserFrames(Map<String, Object> args) {
        try {
            var tree = chromeManager.cdp.send("Page.getFrameTree", Map.of(), chromeManager.pageSession);
            var result = new ArrayList<Map<String, Object>>();
            flattenFrames((Map<String, Object>) tree.get("frameTree"), result, 0);
            return toolOk(Json.serialize(result));
        } catch (Exception e) { return toolError(e.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    static void flattenFrames(Map<String, Object> node, List<Map<String, Object>> out, int depth) {
        var frame = (Map<String, Object>) node.getOrDefault("frame", Map.of());
        out.add(Json.obj("id", frame.getOrDefault("id", ""), "url", frame.getOrDefault("url", ""), "name", frame.getOrDefault("name", ""), "depth", depth));
        var children = node.get("childFrames");
        if (children instanceof List<?> list) {
            for (var child : list) {
                if (child instanceof Map<?,?> m) flattenFrames((Map<String, Object>) m, out, depth + 1);
            }
        }
    }

    static Map<String, Object> dispatchBrowserTool(String tool, Map<String, Object> args) {
        // Centralized health check + lazy init; returns healthy ChromeManager
        ChromeManager cm;
        try { cm = ensureBrowser(); } catch (Exception e) { return toolError(e.getMessage()); }
        return switch (tool) {
            case "browser_status" -> handleBrowserStatus(args);
            case "browser_navigate" -> handleBrowserNavigate(args);
            case "browser_screenshot" -> handleBrowserScreenshot(args);
            case "browser_click" -> handleBrowserClick(args);
            case "browser_type" -> handleBrowserType(args);
            case "browser_extract" -> handleBrowserExtract(args);
            case "browser_tabs" -> handleBrowserTabs(args);
            case "browser_execute" -> handleBrowserExecute(args);
            case "browser_scroll" -> handleBrowserScroll(args);
            case "browser_keypress" -> handleBrowserKeypress(args);
            case "browser_wait_for" -> handleBrowserWaitFor(args);
            case "browser_select" -> handleBrowserSelect(args);
            case "browser_hover" -> handleBrowserHover(args);
            case "browser_history" -> handleBrowserHistory(args);
            case "browser_handle_dialog" -> handleBrowserDialog(args);
            case "browser_frames" -> handleBrowserFrames(args);
            case "browser_mouse_move" -> handleBrowserMouseMove(args);
            case "browser_drag" -> handleBrowserDrag(args);
            case "browser_touch" -> handleBrowserTouch(args);
            case "browser_upload" -> handleBrowserUpload(args);
            case "browser_download" -> handleBrowserDownload(args);
            case "browser_auth" -> handleBrowserAuth(args);
            case "browser_permissions" -> handleBrowserPermissions(args);
            case "browser_store" -> handleBrowserStore(args);
            default -> toolError("Unknown browser tool: " + tool);
        };
    }

    // -----------------------------------------------------------------------
    // Tool schemas
    // -----------------------------------------------------------------------

    static List<Object> buildToolSchemas() {
        return Json.arr(
            Json.obj(
                "name", "view",
                "description", "View file contents with line numbers, or list directory entries.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("path"),
                    "properties", Json.obj(
                        "path", Json.obj("type", "string", "description", "Absolute path to file or directory"),
                        "view_range", Json.obj("type", "array", "items", Json.obj("type", "integer"),
                            "description", "Optional [start_line, end_line] range (1-indexed). Use -1 for end_line to read to EOF.")
                    )
                )
            ),
            Json.obj(
                "name", "edit",
                "description", "Replace exactly one occurrence of old_str with new_str in a file.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("path", "old_str", "new_str"),
                    "properties", Json.obj(
                        "path", Json.obj("type", "string", "description", "Absolute path to file"),
                        "old_str", Json.obj("type", "string", "description", "Exact string to find (must match exactly one location)"),
                        "new_str", Json.obj("type", "string", "description", "Replacement string")
                    )
                )
            ),
            Json.obj(
                "name", "create",
                "description", "Create a new file with the given content. Fails if file already exists.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("path", "file_text"),
                    "properties", Json.obj(
                        "path", Json.obj("type", "string", "description", "Absolute path for the new file"),
                        "file_text", Json.obj("type", "string", "description", "Content of the new file")
                    )
                )
            ),
            Json.obj(
                "name", "grep",
                "description", "Search file contents using ripgrep (rg) with grep fallback.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("pattern"),
                    "properties", Json.obj(
                        "pattern", Json.obj("type", "string", "description", "Regex pattern to search for"),
                        "path", Json.obj("type", "string", "description", "File or directory to search in"),
                        "glob", Json.obj("type", "string", "description", "Glob pattern to filter files (e.g. '*.ts')"),
                        "-i", Json.obj("type", "boolean", "description", "Case insensitive search"),
                        "-n", Json.obj("type", "boolean", "description", "Show line numbers"),
                        "-A", Json.obj("type", "number", "description", "Lines of context after match"),
                        "-B", Json.obj("type", "number", "description", "Lines of context before match"),
                        "-C", Json.obj("type", "number", "description", "Lines of context before and after match"),
                        "output_mode", Json.obj("type", "string", "description", "Output format",
                            "enum", Json.arr("content", "files_with_matches", "count")),
                        "head_limit", Json.obj("type", "number", "description", "Limit results")
                    )
                )
            ),
            Json.obj(
                "name", "glob",
                "description", "Find files by name pattern using glob matching.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("pattern"),
                    "properties", Json.obj(
                        "pattern", Json.obj("type", "string", "description", "Glob pattern (e.g. '**/*.py', 'src/**/*.ts')"),
                        "path", Json.obj("type", "string", "description", "Directory to search in (defaults to project root)")
                    )
                )
            ),
            Json.obj(
                "name", "bash",
                "description", "Run a shell command and return output.",
                "inputSchema", Json.obj(
                    "type", "object",
                    "required", Json.arr("command"),
                    "properties", Json.obj(
                        "command", Json.obj("type", "string", "description", "Shell command to execute"),
                        "description", Json.obj("type", "string", "description", "Short description of the command"),
                        "timeout", Json.obj("type", "number", "description", "Timeout in milliseconds"),
                        "cwd", Json.obj("type", "string", "description", "Working directory (defaults to project root)")
                    )
                )
            )
        );
    }

    static List<Object> buildBrowserToolSchemas() {
        return Json.arr(
            Json.obj("name", "browser_status", "description", "Get current browser page URL and title",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(), "required", Json.arr())),
            Json.obj("name", "browser_navigate", "description", "Navigate to a URL",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("url", Json.obj("type", "string", "description", "URL to navigate to")), "required", Json.arr("url"))),
            Json.obj("name", "browser_screenshot", "description", "Take a screenshot of the page or element",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("selector", Json.obj("type", "string", "description", "CSS selector"), "quality", Json.obj("type", "number", "description", "JPEG quality (default: 80)")), "required", Json.arr())),
            Json.obj("name", "browser_click", "description", "Click an element or coordinates",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("selector", Json.obj("type", "string"), "x", Json.obj("type", "number"), "y", Json.obj("type", "number"), "button", Json.obj("type", "string"), "double", Json.obj("type", "boolean")), "required", Json.arr())),
            Json.obj("name", "browser_type", "description", "Type text into an element",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("text", Json.obj("type", "string"), "selector", Json.obj("type", "string"), "clear", Json.obj("type", "boolean"), "submit", Json.obj("type", "boolean")), "required", Json.arr("text"))),
            Json.obj("name", "browser_extract", "description", "Extract content from the page",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("mode", Json.obj("type", "string"), "selector", Json.obj("type", "string")), "required", Json.arr())),
            Json.obj("name", "browser_tabs", "description", "Manage browser tabs",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("action", Json.obj("type", "string"), "url", Json.obj("type", "string"), "targetId", Json.obj("type", "string")), "required", Json.arr())),
            Json.obj("name", "browser_execute", "description", "Execute JavaScript in page context",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("code", Json.obj("type", "string"),
                    "script_id", Json.obj("type", "string", "description", "Key of a stored script (saved via browser_store)"),
                    "script_args", Json.obj("type", "object", "description", "Arguments passed to stored script as __args")
                ), "required", List.of())),
            Json.obj("name", "browser_scroll", "description", "Scroll the page or element",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("direction", Json.obj("type", "string"), "amount", Json.obj("type", "number"), "selector", Json.obj("type", "string"), "x", Json.obj("type", "number"), "y", Json.obj("type", "number")), "required", Json.arr())),
            Json.obj("name", "browser_keypress", "description", "Press a keyboard key with optional modifiers",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("key", Json.obj("type", "string"), "modifiers", Json.obj("type", "array", "items", Json.obj("type", "string"))), "required", Json.arr("key"))),
            Json.obj("name", "browser_wait_for", "description", "Wait for element to appear",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("selector", Json.obj("type", "string"), "timeout", Json.obj("type", "number"), "visible", Json.obj("type", "boolean")), "required", Json.arr("selector"))),
            Json.obj("name", "browser_select", "description", "Select dropdown option",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("selector", Json.obj("type", "string"), "value", Json.obj("type", "string"), "text", Json.obj("type", "string"), "index", Json.obj("type", "number")), "required", Json.arr("selector"))),
            Json.obj("name", "browser_hover", "description", "Hover over an element",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("selector", Json.obj("type", "string"), "x", Json.obj("type", "number"), "y", Json.obj("type", "number")), "required", Json.arr())),
            Json.obj("name", "browser_history", "description", "Navigate browser history",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("action", Json.obj("type", "string")), "required", Json.arr("action"))),
            Json.obj("name", "browser_handle_dialog", "description", "Handle JavaScript dialog",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj("action", Json.obj("type", "string"), "prompt_text", Json.obj("type", "string")), "required", Json.arr())),
            Json.obj("name", "browser_frames", "description", "List all frames in the page",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(), "required", Json.arr())),
            Json.obj("name", "browser_mouse_move", "description", "Move the mouse cursor to a position, optionally interpolating from a start point",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "x", Json.obj("type", "number", "description", "Target X coordinate"),
                    "y", Json.obj("type", "number", "description", "Target Y coordinate"),
                    "from_x", Json.obj("type", "number", "description", "Starting X coordinate (default: 0)"),
                    "from_y", Json.obj("type", "number", "description", "Starting Y coordinate (default: 0)"),
                    "steps", Json.obj("type", "number", "description", "Number of intermediate steps (default: 1)")
                ), "required", Json.arr("x", "y"))),
            Json.obj("name", "browser_drag", "description", "Drag from one position to another using mouse press, move, release",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "from_selector", Json.obj("type", "string", "description", "CSS selector for drag start element"),
                    "from_x", Json.obj("type", "number", "description", "Start X coordinate"),
                    "from_y", Json.obj("type", "number", "description", "Start Y coordinate"),
                    "to_selector", Json.obj("type", "string", "description", "CSS selector for drop target element"),
                    "to_x", Json.obj("type", "number", "description", "End X coordinate"),
                    "to_y", Json.obj("type", "number", "description", "End Y coordinate"),
                    "steps", Json.obj("type", "number", "description", "Number of intermediate move steps (default: 10)")
                ), "required", Json.arr())),
            Json.obj("name", "browser_touch", "description", "Simulate touch events: tap, swipe, long-press, or pinch",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "action", Json.obj("type", "string", "description", "Touch action: tap, swipe, long-press, or pinch"),
                    "x", Json.obj("type", "number", "description", "X coordinate"),
                    "y", Json.obj("type", "number", "description", "Y coordinate"),
                    "to_x", Json.obj("type", "number", "description", "End X for swipe"),
                    "to_y", Json.obj("type", "number", "description", "End Y for swipe"),
                    "duration", Json.obj("type", "number", "description", "Duration in ms for long-press (default: 500)"),
                    "scale", Json.obj("type", "number", "description", "Scale factor for pinch (default: 2.0)"),
                    "steps", Json.obj("type", "number", "description", "Number of intermediate steps (default: 10)")
                ), "required", Json.arr("action", "x", "y"))),
            Json.obj("name", "browser_upload", "description", "Upload files to a file input element on the page",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "selector", Json.obj("type", "string", "description", "CSS selector of the file input element"),
                    "files", Json.obj("type", "array", "items", Json.obj("type", "string"), "description", "Array of absolute file paths"),
                    "file_ids", Json.obj("type", "array", "items", Json.obj("type", "string"), "description", "Array of chat file IDs to download and upload to browser")
                ), "required", Json.arr("selector"))),
            Json.obj("name", "browser_download", "description", "Manage downloads: configure path, wait for completion, or list downloads",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "action", Json.obj("type", "string", "enum", Json.arr("configure", "wait", "list"), "description", "Action to perform"),
                    "path", Json.obj("type", "string", "description", "Download directory (for configure)"),
                    "timeout", Json.obj("type", "number", "description", "Max wait time in ms (for wait, default: 30000)"),
                    "upload", Json.obj("type", "boolean", "description", "Upload completed download to chat server (for wait action)")
                ), "required", Json.arr())),
            Json.obj("name", "browser_auth", "description", "Handle HTTP Basic/Digest authentication",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "action", Json.obj("type", "string", "enum", Json.arr("status", "provide", "cancel")),
                    "username", Json.obj("type", "string"),
                    "password", Json.obj("type", "string")
                ), "required", Json.arr("action"))),
            Json.obj("name", "browser_permissions", "description", "Grant, deny, or reset browser permissions for a site",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "action", Json.obj("type", "string", "enum", Json.arr("grant", "deny", "reset")),
                    "permissions", Json.obj("type", "array", "items", Json.obj("type", "string")),
                    "origin", Json.obj("type", "string")
                ), "required", Json.arr("action"))),
            Json.obj("name", "browser_store", "description", "Store and retrieve reusable scripts",
                "inputSchema", Json.obj("type", "object", "properties", Json.obj(
                    "action", Json.obj("type", "string", "enum", List.of("set", "get", "list", "delete", "clear")),
                    "key", Json.obj("type", "string"),
                    "value", Json.obj("type", "string"),
                    "description", Json.obj("type", "string")
                ), "required", List.of("action")))
        );
    }

    // -----------------------------------------------------------------------
    // Utility helpers
    // -----------------------------------------------------------------------

    static Map<String, Object> toolOk(String output) {
        return Json.obj("success", true, "output", output, "error", null);
    }

    static Map<String, Object> toolError(String error) {
        return Json.obj("success", false, "output", "", "error", error);
    }

    /** Escape a string for safe embedding in JavaScript using JSON serialization. */
    static String jsStr(String s) {
        return Json.serialize(s);
    }

    @SuppressWarnings("unchecked")
    static String strArg(Map<String, Object> args, String key, String def) {
        Object v = args.get(key);
        if (v == null) return def;
        return v.toString();
    }

    static boolean boolArg(Map<String, Object> args, String key, boolean def) {
        Object v = args.get(key);
        if (v == null) return def;
        if (v instanceof Boolean b) return b;
        return Boolean.parseBoolean(v.toString());
    }

    static Integer intArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        if (v == null) return null;
        if (v instanceof Number n) return n.intValue();
        try { return Integer.parseInt(v.toString()); } catch (NumberFormatException e) { return null; }
    }

    static int toInt(Object v, int def) {
        if (v == null) return def;
        if (v instanceof Number n) return n.intValue();
        try { return Integer.parseInt(v.toString()); } catch (NumberFormatException e) { return def; }
    }

    static long toLong(Object v, long def) {
        if (v == null) return def;
        if (v instanceof Number n) return n.longValue();
        try { return Long.parseLong(v.toString()); } catch (NumberFormatException e) { return def; }
    }

    // -----------------------------------------------------------------------
    // WebSocket client + connection management
    // -----------------------------------------------------------------------

    static final class Worker {
        final Config config;
        final String sessionId = UUID.randomUUID().toString();
        final Semaphore concurrencyLimiter;
        final AtomicBoolean running = new AtomicBoolean(true);
        final AtomicReference<WebSocket> wsRef = new AtomicReference<>();
        final AtomicLong lastPong = new AtomicLong(System.currentTimeMillis());
        final List<Object> toolSchemas;

        volatile ScheduledExecutorService heartbeatExecutor;
        volatile double reconnectDelay = 1.0;
        final HttpClient httpClient;

        Worker(Config config) {
            this.config = config;
            this.concurrencyLimiter = new Semaphore(config.maxConcurrent());
            this.toolSchemas = new ArrayList<>(buildToolSchemas());
            if (config.browser() != null) {
                this.toolSchemas.addAll(buildBrowserToolSchemas());
            }

            // Build HTTP client for WebSocket
            HttpClient.Builder builder = HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(30));

            if (config.insecure()) {
                try {
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, new TrustManager[]{ new X509TrustManager() {
                        public void checkClientTrusted(X509Certificate[] c, String t) {}
                        public void checkServerTrusted(X509Certificate[] c, String t) {}
                        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    }}, new SecureRandom());
                    builder.sslContext(ctx);
                } catch (Exception e) {
                    log("Warning: Failed to set insecure SSL: " + e.getMessage());
                }
            } else if (config.caCert() != null) {
                try {
                    var ks = java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType());
                    ks.load(null, null);
                    var cf = java.security.cert.CertificateFactory.getInstance("X.509");
                    try (var fis = new FileInputStream(config.caCert())) {
                        int idx = 0;
                        for (var cert : cf.generateCertificates(fis)) {
                            ks.setCertificateEntry("custom-ca-" + idx++, cert);
                        }
                    }
                    var tmf = javax.net.ssl.TrustManagerFactory.getInstance(
                        javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
                    tmf.init(ks);
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, tmf.getTrustManagers(), new SecureRandom());
                    builder.sslContext(ctx);
                } catch (Exception e) {
                    log("Warning: Failed to load CA cert: " + e.getMessage());
                }
            }

            this.httpClient = builder.build();
        }

        void connect() {
            String server = config.server().replaceAll("/+$", "");
            String nameEncoded = URLEncoder.encode(config.name(), StandardCharsets.UTF_8);
            String tokenEncoded = URLEncoder.encode(config.token(), StandardCharsets.UTF_8);
            String wsUrl = server + "/worker/ws?name=" + nameEncoded + "&token=" + tokenEncoded;

            URI uri = URI.create(wsUrl);
            // Determine Origin header
            String scheme = uri.getScheme();
            String originScheme = switch (scheme) {
                case "wss" -> "https";
                case "ws" -> "http";
                default -> "https";
            };
            String host = uri.getHost();
            int port = uri.getPort();
            String origin = originScheme + "://" + host;
            if (port > 0 && port != 80 && port != 443) origin += ":" + port;

            WebSocket.Builder wsBuilder = httpClient.newWebSocketBuilder()
                .header("User-Agent", USER_AGENT)
                .header("Origin", origin)
                .header("Authorization", "Bearer " + config.token());

            if (config.cfClientId() != null && config.cfClientSecret() != null) {
                wsBuilder.header("CF-Access-Client-Id", config.cfClientId());
                wsBuilder.header("CF-Access-Client-Secret", config.cfClientSecret());
            }

            // The java.net.http WebSocket uses a Listener callback model
            var messageBuffer = new StringBuilder();

            try {
                WebSocket ws = wsBuilder.buildAsync(uri, new WebSocket.Listener() {
                    @Override
                    public void onOpen(WebSocket webSocket) {
                        log("Connected to " + server);
                        reconnectDelay = 1.0;
                        lastPong.set(System.currentTimeMillis());
                        wsRef.set(webSocket);
                        register();
                        startHeartbeat();
                        webSocket.request(1);
                    }

                    @Override
                    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                        messageBuffer.append(data);
                        if (last) {
                            String msg = messageBuffer.toString();
                            messageBuffer.setLength(0);
                            handleMessage(msg);
                        }
                        webSocket.request(1);
                        return null;
                    }

                    @Override
                    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                        log("Connection closed: " + statusCode + " " + reason);
                        stopHeartbeat();
                        wsRef.set(null);
                        scheduleReconnect();
                        return null;
                    }

                    @Override
                    public void onError(WebSocket webSocket, Throwable error) {
                        log("WebSocket error: " + error.getMessage());
                        stopHeartbeat();
                        wsRef.set(null);
                        scheduleReconnect();
                    }

                    @Override
                    public CompletionStage<?> onPing(WebSocket webSocket, java.nio.ByteBuffer message) {
                        webSocket.sendPong(message);
                        webSocket.request(1);
                        return null;
                    }

                    @Override
                    public CompletionStage<?> onPong(WebSocket webSocket, java.nio.ByteBuffer message) {
                        lastPong.set(System.currentTimeMillis());
                        webSocket.request(1);
                        return null;
                    }
                }).join(); // block until connected

            } catch (CompletionException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                log("Connection failed: " + cause.getMessage());
                scheduleReconnect();
            } catch (Exception e) {
                log("Connection failed: " + e.getMessage());
                scheduleReconnect();
            }
        }

        void register() {
            // Filter tools in read-only mode
            List<Object> tools;
            if (config.readOnly()) {
                Set<String> writeTools = Set.of("edit", "create", "bash");
                tools = toolSchemas.stream()
                    .filter(t -> {
                        if (t instanceof Map<?, ?> m) {
                            return !writeTools.contains(m.get("name"));
                        }
                        return true;
                    })
                    .collect(Collectors.toList());
            } else {
                tools = toolSchemas;
            }

            wsSend(Json.obj(
                "type", "register",
                "name", config.name(),
                "projectRoot", config.projectRoot(),
                "platform", System.getProperty("os.name"),
                "sessionId", sessionId,
                "maxConcurrent", config.maxConcurrent(),
                "tools", tools,
                "version", VERSION
            ));
        }

        void wsSend(Map<String, Object> msg) {
            WebSocket ws = wsRef.get();
            if (ws != null) {
                try {
                    ws.sendText(Json.serialize(msg), true).join();
                } catch (Exception e) {
                    // Connection may be closing; ignore
                }
            }
        }

        @SuppressWarnings("unchecked")
        void handleMessage(String raw) {
            Map<String, Object> msg;
            try {
                Object parsed = Json.parse(raw);
                if (!(parsed instanceof Map<?, ?> m)) {
                    log("Invalid message (not an object)");
                    return;
                }
                msg = (Map<String, Object>) m;
            } catch (Exception e) {
                log("Invalid JSON from server: " + e.getMessage());
                return;
            }

            String type = String.valueOf(msg.getOrDefault("type", ""));
            switch (type) {
                case "registered" -> {
                    Object err = msg.get("error");
                    if (err != null) {
                        log("Registration failed: " + err);
                    } else {
                        log("Registered successfully (session: " + sessionId + ")");
                    }
                }
                case "call" -> {
                    if (!concurrencyLimiter.tryAcquire()) {
                        wsSend(Json.obj("type", "error", "id", msg.get("id"),
                                        "error", "Max concurrent calls exceeded"));
                        return;
                    }
                    Thread.ofVirtual().start(() -> {
                        try {
                            handleToolCall(msg);
                        } finally {
                            concurrencyLimiter.release();
                        }
                    });
                }
                case "cancel" -> {
                    String callId = String.valueOf(msg.get("id"));
                    cancelledCalls.add(callId);
                    Process proc = activeProcesses.remove(callId);
                    if (proc != null && proc.isAlive()) {
                        log("Cancelling process for " + callId + " (pid=" + proc.pid() + ")");
                        killProcessTree(proc.pid());
                    }
                    wsSend(Json.obj("type", "cancelled", "id", callId));
                }
                case "ping" -> wsSend(Json.obj("type", "pong", "ts", msg.get("ts")));
                case "pong" -> lastPong.set(System.currentTimeMillis());
                case "shutdown" -> {
                    log("Server requested shutdown");
                    for (var entry : activeProcesses.entrySet()) {
                        Process p = activeProcesses.remove(entry.getKey());
                        if (p != null && p.isAlive()) killProcessTree(p.pid());
                    }
                    wsSend(Json.obj("type", "shutdown_ack"));
                    shutdown();
                }
                default -> { /* ignore unknown types */ }
            }
        }

        @SuppressWarnings("unchecked")
        void handleToolCall(Map<String, Object> msg) {
            String callId = String.valueOf(msg.getOrDefault("id", ""));
            String tool = String.valueOf(msg.getOrDefault("tool", ""));
            Map<String, Object> args = (msg.get("args") instanceof Map<?, ?> m)
                ? (Map<String, Object>) m : Map.of();

            log("Tool call: " + tool + " (id=" + callId + ")");

            try {
                Map<String, Object> result = switch (tool) {
                    case "view"   -> handleView(args, config.projectRoot());
                    case "edit"   -> handleEdit(args, config.projectRoot(), config.readOnly());
                    case "create" -> handleCreate(args, config.projectRoot(), config.readOnly());
                    case "grep"   -> handleGrep(args, config.projectRoot());
                    case "glob"   -> handleGlob(args, config.projectRoot());
                    case "bash"   -> handleBash(callId, args, config.projectRoot(), config.readOnly(), this::wsSend);
                    default       -> tool.startsWith("browser_") ? dispatchBrowserTool(tool, args) : toolError("Unknown tool: " + tool);
                };

                // Skip if cancelled
                if (!cancelledCalls.remove(callId)) {
                    wsSend(Json.obj("type", "result", "id", callId, "result", result));
                }
            } catch (Exception e) {
                log("Tool call error (" + tool + "): " + e.getMessage());
                wsSend(Json.obj("type", "error", "id", callId, "error", e.getMessage()));
            }
        }

        // -- Heartbeat --

        void startHeartbeat() {
            stopHeartbeat();
            var executor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "heartbeat");
                t.setDaemon(true);
                return t;
            });
            heartbeatExecutor = executor;
            executor.scheduleAtFixedRate(() -> {
                try {
                    wsSend(Json.obj("type", "ping", "ts", System.currentTimeMillis()));
                    if (System.currentTimeMillis() - lastPong.get() > 60_000) {
                        log("No pong received in 60s — reconnecting");
                        WebSocket ws = wsRef.get();
                        if (ws != null) {
                            try { ws.sendClose(WebSocket.NORMAL_CLOSURE, "heartbeat timeout").join(); }
                            catch (Exception ignored) {}
                        }
                    }
                } catch (Exception ignored) {}
            }, 30, 30, TimeUnit.SECONDS);
        }

        void stopHeartbeat() {
            var executor = heartbeatExecutor;
            if (executor != null) {
                executor.shutdownNow();
                heartbeatExecutor = null;
            }
        }

        // -- Reconnection --

        void scheduleReconnect() {
            if (!running.get()) return;
            double delay = Math.min(reconnectDelay, config.reconnectMax());
            log(String.format("Reconnecting in %.0fs...", delay));
            reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMax());
            Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep((long) (delay * 1000));
                } catch (InterruptedException e) {
                    return;
                }
                if (running.get()) {
                    connect();
                }
            });
        }

        // -- Shutdown --

        void shutdown() {
            running.set(false);
            stopHeartbeat();
            for (var entry : activeProcesses.entrySet()) {
                Process p = activeProcesses.remove(entry.getKey());
                if (p != null && p.isAlive()) killProcessTree(p.pid());
            }
            WebSocket ws = wsRef.get();
            if (ws != null) {
                try { ws.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown").join(); }
                catch (Exception ignored) {}
            }
            System.exit(0);
        }

        // -- Run --

        void run() {
            connect();
            // Keep main thread alive
            try {
                while (running.get()) {
                    Thread.sleep(1000);
                }
            } catch (InterruptedException ignored) {}
        }
    }

    // -----------------------------------------------------------------------
    // Main entry point
    // -----------------------------------------------------------------------

    public static void main(String[] args) {
        Config config = parseArgs(args);
        activeConfig = config;

        // Startup diagnostics
        log("Platform: " + System.getProperty("os.name") + " (" + System.getProperty("os.arch") + ")");
        log("Java: " + System.getProperty("java.version"));
        if (IS_WSL2) log("Running inside WSL2");
        if (IS_MACOS) log("macOS (case-insensitive path comparison active)");
        if (config.insecure()) log("⚠️  TLS verification DISABLED — NOT for production!");
        if (config.cfClientId() != null) log("Cloudflare Access service token configured");
        log("Project root: " + config.projectRoot());
        log("Server: " + config.server());
        log("Name: " + config.name());
        log("Read-only: " + config.readOnly());
        log("Max concurrent: " + config.maxConcurrent());

        var worker = new Worker(config);

        // Browser startup
        if (config.browser() != null) {
            var mgr = startChromeManager(config.browser());
            if (mgr != null) {
                log("Browser enabled (CDP port " + mgr.cdpPort + ")");
            } else {
                log("WARNING: Browser requested but Chrome not found");
            }
        }

        // Graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            log("Shutting down...");
            worker.running.set(false);
            worker.stopHeartbeat();
            for (var entry : activeProcesses.entrySet()) {
                Process p = activeProcesses.remove(entry.getKey());
                if (p != null && p.isAlive()) killProcessTree(p.pid());
            }
            WebSocket ws = worker.wsRef.get();
            if (ws != null) {
                try { ws.sendText(Json.serialize(Json.obj("type", "shutdown")), true).join(); }
                catch (Exception ignored) {}
                try { ws.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown").join(); }
                catch (Exception ignored) {}
            }
            if (chromeManager != null) {
                chromeManager.shutdown();
                chromeManager = null;
            }
        }));

        worker.run();
    }
}
