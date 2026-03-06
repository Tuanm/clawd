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
                if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
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
        String cfClientSecret
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
                           reconnectMax, insecure, caCert, maxConcurrent, cfClientId, cfClientSecret);
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
        // Try Git Bash
        for (String base : List.of(
                System.getenv("ProgramFiles"), System.getenv("ProgramFiles(x86)"),
                System.getenv("LOCALAPPDATA") != null ? System.getenv("LOCALAPPDATA") + "\\Programs" : null)) {
            if (base == null) continue;
            Path p = Path.of(base, "Git", "bin", "bash.exe");
            if (Files.isRegularFile(p)) return new ShellCmd(p.toString(), List.of("-c", command));
        }
        // Try bash on PATH
        try {
            var which = new ProcessBuilder("where", "bash.exe").redirectErrorStream(true).start();
            String out = new String(which.getInputStream().readAllBytes()).trim();
            which.waitFor(5, TimeUnit.SECONDS);
            if (!out.isEmpty() && Files.isRegularFile(Path.of(out.lines().findFirst().orElse("")))) {
                return new ShellCmd(out.lines().findFirst().orElse("bash"), List.of("-c", command));
            }
        } catch (Exception ignored) {}
        // Try PowerShell
        for (String ps : List.of("pwsh.exe", "powershell.exe")) {
            try {
                var which = new ProcessBuilder("where", ps).redirectErrorStream(true).start();
                which.waitFor(5, TimeUnit.SECONDS);
                if (which.exitValue() == 0) {
                    return new ShellCmd(ps, List.of("-NoProfile", "-NonInteractive", "-Command", command));
                }
            } catch (Exception ignored) {}
        }
        return new ShellCmd("cmd.exe", List.of("/c", command));
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

    // -----------------------------------------------------------------------
    // Utility helpers
    // -----------------------------------------------------------------------

    static Map<String, Object> toolOk(String output) {
        return Json.obj("success", true, "output", output, "error", null);
    }

    static Map<String, Object> toolError(String error) {
        return Json.obj("success", false, "output", "", "error", error);
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
            this.toolSchemas = buildToolSchemas();

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
                    default       -> toolError("Unknown tool: " + tool);
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
        }));

        worker.run();
    }
}
