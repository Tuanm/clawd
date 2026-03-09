#!/usr/bin/env python3
"""Claw'd Remote Worker — stdlib-only Python client that connects to a
Claw'd server via WebSocket and executes file tools on the remote machine.

Requires Python 3.8+. Zero external dependencies.
"""
import sys

if sys.version_info < (3, 8):
    print(
        f"Error: Python 3.8+ required (found {sys.version})",
        file=sys.stderr,
    )
    print("  Ubuntu 18.04: sudo apt install python3.8", file=sys.stderr)
    sys.exit(1)

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg):  # type: (str) -> None
    print(f"[worker] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
IS_WSL2 = False
if sys.platform == "linux":
    try:
        IS_WSL2 = "microsoft" in open("/proc/version").read().lower()
    except OSError:
        pass

REAL_TMP = os.path.realpath(tempfile.gettempdir())
WIN_RESERVED = re.compile(
    r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$", re.IGNORECASE
)


def is_drvfs(p):  # type: (str) -> bool
    """Return True when *p* lives on a Windows drive mounted via drvfs in WSL2."""
    return IS_WSL2 and bool(re.match(r"^/mnt/[a-z]/", p, re.IGNORECASE))


# ---------------------------------------------------------------------------
# StdlibWebSocket — RFC 6455 client, stdlib only
# ---------------------------------------------------------------------------

class StdlibWebSocket:
    """Minimal RFC 6455 WebSocket client built on the stdlib."""

    MAX_FRAME_SIZE = 16 * 1024 * 1024  # 16 MB

    def __init__(
        self,
        url,            # type: str
        headers=None,   # type: Optional[Dict[str, str]]
        ssl_context=None,  # type: Optional[ssl.SSLContext]
    ):
        self.url = url
        self.headers = headers or {}
        self.ssl_context = ssl_context
        self.sock = None   # type: Optional[socket.socket]
        self._closed = False
        self._send_lock = threading.Lock()
        self._recv_buf = b""
        self._last_fin = False

    # -- connection ----------------------------------------------------------

    def connect(self):  # type: () -> None
        parsed = urllib.parse.urlparse(self.url)
        is_secure = parsed.scheme in ("wss", "https")
        host = parsed.hostname or "localhost"
        port = parsed.port or (443 if is_secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw_sock = socket.create_connection((host, port), timeout=30)

        if is_secure:
            ctx = self.ssl_context or ssl.create_default_context()
            try:
                self.sock = ctx.wrap_socket(raw_sock, server_hostname=host)
            except ssl.SSLError as exc:
                raw_sock.close()
                self._emit_ssl_help(exc)
                raise
        else:
            self.sock = raw_sock

        # --- HTTP upgrade handshake ---
        key = base64.b64encode(os.urandom(16)).decode()
        origin = f"{'https' if is_secure else 'http'}://{host}" if port in (80, 443) else f"{'https' if is_secure else 'http'}://{host}:{port}"
        host_hdr = host if port in (80, 443) else f"{host}:{port}"
        handshake_lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host_hdr}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            f"Origin: {origin}",
            "User-Agent: Clawd-RemoteWorker/0.1",
        ]
        for hdr_name, hdr_val in self.headers.items():
            handshake_lines.append(f"{hdr_name}: {hdr_val}")
        handshake_lines.append("")
        handshake_lines.append("")
        self.sock.sendall("\r\n".join(handshake_lines).encode())

        # Read response
        response = self._recv_until(b"\r\n\r\n")
        if b"101" not in response.split(b"\r\n")[0]:
            self.sock.close()
            status_line = response.split(b"\r\n")[0].decode(errors="replace")
            # Print full response headers for debugging
            resp_text = response.decode(errors="replace").strip()
            raise ConnectionError(
                "WebSocket upgrade failed: %s\n  Response headers:\n  %s"
                % (status_line, "\n  ".join(resp_text.split("\r\n")))
            )

        # Validate Sec-WebSocket-Accept (warn on mismatch — proxies like
        # Cloudflare may re-terminate the WS and produce a different accept key)
        expected_accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-5AB5AFA5E30B").encode()
            ).digest()
        ).decode()
        accept_found = False
        for line in response.split(b"\r\n"):
            if line.lower().startswith(b"sec-websocket-accept:"):
                got = line.split(b":", 1)[1].strip().decode()
                accept_found = True
                if got != expected_accept:
                    log("Warning: Sec-WebSocket-Accept mismatch (proxy may have re-terminated WS)")
                break
        if not accept_found:
            log("Warning: No Sec-WebSocket-Accept header in response (proxy may strip it)")

        self.sock.settimeout(90)
        self._closed = False

    # -- send ----------------------------------------------------------------

    def send(self, data):  # type: (str) -> None
        """Send a UTF-8 text frame (masked, per RFC 6455 client requirement)."""
        payload = data.encode("utf-8")
        mask_key = os.urandom(4)

        # Build header
        header = bytearray()
        header.append(0x81)  # FIN + text opcode

        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))

        header.extend(mask_key)

        # Mask payload
        masked = bytearray(length)
        for i in range(length):
            masked[i] = payload[i] ^ mask_key[i % 4]

        with self._send_lock:
            if self._closed:
                return
            self.sock.sendall(bytes(header) + bytes(masked))

    # -- recv ----------------------------------------------------------------

    def recv(self):  # type: () -> Optional[str]
        """Read the next text message; returns None on close."""
        fragments = []  # type: List[bytes]
        while True:
            opcode, payload = self._read_frame()
            if opcode is None:
                return None

            if opcode == 0x8:
                # Close frame
                self._closed = True
                return None
            elif opcode == 0x9:
                # Ping → pong
                self._send_pong(payload)
                continue
            elif opcode == 0xA:
                # Pong → ignore
                continue
            elif opcode == 0x1 or opcode == 0x0:
                # Text or continuation
                fragments.append(payload)
                # Check if FIN was set (indicated by _last_fin)
                if self._last_fin:
                    return b"".join(fragments).decode("utf-8", errors="replace")
            elif opcode == 0x2:
                # Binary — treat as text
                fragments.append(payload)
                if self._last_fin:
                    return b"".join(fragments).decode("utf-8", errors="replace")

    def _read_frame(self):  # type: () -> Tuple[Optional[int], bytes]
        """Read one WebSocket frame.  Returns (opcode, payload) or (None, b'')."""
        try:
            b0 = self._recv_exact(1)
            b1 = self._recv_exact(1)
        except (ConnectionError, OSError):
            return None, b""

        fin = b0[0] & 0x80
        opcode = b0[0] & 0x0F
        masked = b1[0] & 0x80
        length = b1[0] & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]

        if length > self.MAX_FRAME_SIZE:
            raise ConnectionError(f"Frame too large: {length} bytes")

        if masked:
            mask_key = self._recv_exact(4)
            raw = bytearray(self._recv_exact(length))
            for i in range(length):
                raw[i] ^= mask_key[i % 4]
            payload = bytes(raw)
        else:
            payload = self._recv_exact(length)

        self._last_fin = bool(fin)
        return opcode, payload

    # -- close ---------------------------------------------------------------

    def close(self):  # type: () -> None
        if self._closed:
            return
        self._closed = True
        try:
            # Send close frame with status 1000 (normal closure)
            status = struct.pack("!H", 1000)
            mask_key = os.urandom(4)
            masked = bytearray(2)
            for i in range(2):
                masked[i] = status[i] ^ mask_key[i % 4]
            header = bytearray([0x88, 0x82])  # FIN + close, masked, len=2
            header.extend(mask_key)
            header.extend(masked)
            with self._send_lock:
                self.sock.sendall(bytes(header))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    # -- helpers -------------------------------------------------------------

    def _send_pong(self, payload):  # type: (bytes) -> None
        mask_key = os.urandom(4)
        length = len(payload)
        header = bytearray()
        header.append(0x8A)  # FIN + pong
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask_key)
        masked = bytearray(length)
        for i in range(length):
            masked[i] = payload[i] ^ mask_key[i % 4]
        with self._send_lock:
            if not self._closed:
                try:
                    self.sock.sendall(bytes(header) + bytes(masked))
                except OSError:
                    pass

    def _recv_exact(self, n):  # type: (int) -> bytes
        """Read exactly *n* bytes from socket + internal buffer."""
        while len(self._recv_buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed while reading")
            self._recv_buf += chunk
        data = self._recv_buf[:n]
        self._recv_buf = self._recv_buf[n:]
        return data

    def _recv_until(self, delimiter, max_size=8192):  # type: (bytes, int) -> bytes
        """Buffered read until *delimiter* is found (used for HTTP handshake)."""
        while delimiter not in self._recv_buf:
            if len(self._recv_buf) > max_size:
                raise ConnectionError("Handshake response too large")
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed during handshake")
            self._recv_buf += chunk
        idx = self._recv_buf.index(delimiter) + len(delimiter)
        data = self._recv_buf[:idx]
        self._recv_buf = self._recv_buf[idx:]
        return data

    @staticmethod
    def _emit_ssl_help(exc):  # type: (ssl.SSLError) -> None
        log(f"SSL error: {exc}")
        if IS_MACOS:
            ver = f"{sys.version_info.major}.{sys.version_info.minor}"
            log(
                f"  Hint: Run /Applications/Python {ver}/Install Certificates.command"
            )
        elif IS_WINDOWS:
            log("  Hint: Certificates are managed by the Windows cert store")
        else:
            log("  Hint: apt install ca-certificates")


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

def normalize_for_comparison(p):  # type: (str) -> str
    normalized = p.replace("\\", "/")
    case_insensitive = IS_WINDOWS or IS_MACOS or is_drvfs(p)
    return normalized.lower() if case_insensitive else normalized


def validate_path(target, root):  # type: (str, str) -> Dict[str, Any]
    """Resolve *target* and check it lives inside *root* (or REAL_TMP).

    Returns ``{"ok": True, "resolved": str}`` or ``{"ok": False, "error": str}``.
    """
    if not target:
        return {"ok": False, "error": "Empty path"}

    # Normalise on Windows
    target = os.path.expanduser(target)
    if IS_WINDOWS:
        # Convert MSYS/Git Bash paths like /d/foo → D:\foo before slash replacement
        import re as _re
        m = _re.match(r'^/([a-zA-Z])(/.*)?$', target)
        if m:
            target = m.group(1).upper() + ":" + (m.group(2) or "\\")
        target = target.replace("/", "\\")

    # Resolve
    if os.path.exists(target):
        resolved = os.path.realpath(target)
    else:
        parent = os.path.dirname(target) or "."
        if os.path.exists(parent):
            resolved = os.path.join(os.path.realpath(parent), os.path.basename(target))
        else:
            return {"ok": False, "error": f"Parent directory does not exist: {parent}"}

    # Windows reserved names
    if IS_WINDOWS and WIN_RESERVED.match(os.path.basename(resolved)):
        return {"ok": False, "error": f"Reserved filename: {os.path.basename(resolved)}"}

    # Sensitive file check
    if is_sensitive_file(resolved):
        return {"ok": False, "error": f"Access to sensitive file denied: {os.path.basename(resolved)}"}

    # Containment check — must be under root OR temp dir
    norm_resolved = normalize_for_comparison(resolved)
    norm_root = normalize_for_comparison(root)
    norm_tmp = normalize_for_comparison(REAL_TMP)

    if not (
        norm_resolved.startswith(norm_root + "/")
        or norm_resolved == norm_root
        or norm_resolved.startswith(norm_tmp + "/")
        or norm_resolved == norm_tmp
    ):
        return {
            "ok": False,
            "error": f"Path escapes project root: {resolved}",
        }

    return {"ok": True, "resolved": resolved}


def is_sensitive_file(target):  # type: (str) -> bool
    name = os.path.basename(target)
    lower = name.lower()
    # Exact matches (but allow .env.example, .env.local.example etc.)
    if lower == ".env" or (lower.startswith(".env.") and "example" not in lower):
        return True
    sensitive_prefixes = (".secret",)
    sensitive_exact = {
        ".pem", ".key", "id_rsa", "id_ed25519",
        ".npmrc", ".pypirc", ".netrc", "credentials",
    }
    for pfx in sensitive_prefixes:
        if lower.startswith(pfx):
            return True
    if lower in sensitive_exact:
        return True
    return False


def truncate_output(s, max_len=50000):  # type: (str, int) -> str
    if len(s) <= max_len:
        return s
    return s[:max_len] + "\n[output truncated]"


def sanitize_secrets(output):  # type: (str) -> str
    patterns = [
        (r"(?:API_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*\S+", "[REDACTED]"),
        (r"ghp_[a-zA-Z0-9]{36}", "[REDACTED]"),
        (r"sk-[a-zA-Z0-9]{32,}", "[REDACTED]"),
        (r"AKIA[A-Z0-9]{16}", "[REDACTED]"),
        (r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END", "[REDACTED]"),
        (r"eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}", "[REDACTED]"),
    ]
    for pat, repl in patterns:
        output = re.sub(pat, repl, output, flags=re.IGNORECASE)
    return output


# ---------------------------------------------------------------------------
# Shell resolution (NO shell=True ever)
# ---------------------------------------------------------------------------

def resolve_shell(command):  # type: (str) -> Tuple[str, List[str]]
    """Return ``(exe, args)`` to execute *command* without ``shell=True``."""
    if not IS_WINDOWS:
        return ("bash", ["-c", command])

    # Try Git Bash first (most common on Windows dev machines)
    git_bash_paths = [
        os.path.join(
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            "Git", "bin", "bash.exe",
        ),
        os.path.join(
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            "Git", "bin", "bash.exe",
        ),
        os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            "Programs", "Git", "bin", "bash.exe",
        ),
    ]
    for p in git_bash_paths:
        if os.path.isfile(p):
            return (p, ["-c", command])

    bash = shutil.which("bash")
    if bash:
        return (bash, ["-c", command])

    for ps in ("pwsh", "powershell"):
        found = shutil.which(ps)
        if found:
            return (found, ["-NoProfile", "-NonInteractive", "-Command", command])

    return ("cmd.exe", ["/c", command])


# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

active_processes = {}  # type: Dict[str, subprocess.Popen]


def kill_process_tree(pid):  # type: (int) -> None
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except OSError:
            pass
        time.sleep(3)
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except OSError:
            pass


def get_spawn_kwargs(cwd):  # type: (str) -> Dict[str, Any]
    kwargs = {
        "cwd": cwd,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "stdin": subprocess.DEVNULL,
    }  # type: Dict[str, Any]
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return kwargs


# ---------------------------------------------------------------------------
# Helper: run a simple command, capture output
# ---------------------------------------------------------------------------

def run_command(cmd, args, cwd=None, timeout=60):
    # type: (str, List[str], Optional[str], int) -> Tuple[int, str, str]
    """Run ``[cmd] + args``, return ``(returncode, stdout, stderr)``."""
    try:
        proc = subprocess.run(
            [cmd] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            cwd=cwd,
            timeout=timeout,
        )
        return (
            proc.returncode,
            proc.stdout.decode("utf-8", errors="replace"),
            proc.stderr.decode("utf-8", errors="replace"),
        )
    except FileNotFoundError:
        return (127, "", f"Command not found: {cmd}")
    except subprocess.TimeoutExpired:
        return (124, "", f"Command timed out after {timeout}s")


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def handle_view(args, project_root):
    # type: (Dict[str, Any], str) -> Dict[str, Any]
    path = args.get("path", "")
    vr = validate_path(path, project_root)
    if not vr["ok"]:
        return {"success": False, "output": "", "error": vr["error"]}
    resolved = vr["resolved"]

    # Directory listing
    if os.path.isdir(resolved):
        try:
            entries = sorted(os.listdir(resolved))
            output_lines = []
            for entry in entries:
                if entry.startswith("."):
                    continue
                full = os.path.join(resolved, entry)
                suffix = "/" if os.path.isdir(full) else ""
                output_lines.append(f"{entry}{suffix}")
            return {"success": True, "output": "\n".join(output_lines), "error": None}
        except OSError as exc:
            return {"success": False, "output": "", "error": str(exc)}

    # File reading
    if not os.path.isfile(resolved):
        return {"success": False, "output": "", "error": f"Not a file or directory: {resolved}"}

    # Size check (10 MB)
    try:
        sz = os.path.getsize(resolved)
    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}
    if sz > 10 * 1024 * 1024:
        return {"success": False, "output": "", "error": f"File too large: {sz} bytes (max 10MB)"}

    try:
        with open(resolved, "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}

    lines = content.splitlines()
    start_line = args.get("start_line") or args.get("view_range", [None])[0] if isinstance(args.get("view_range"), list) else args.get("start_line")
    end_line = args.get("end_line") or (args.get("view_range", [None, None])[1] if isinstance(args.get("view_range"), list) and len(args.get("view_range", [])) > 1 else None)

    # Normalise to ints
    if start_line is not None:
        start_line = int(start_line)
    if end_line is not None:
        end_line = int(end_line)

    if start_line is not None:
        start_idx = max(start_line - 1, 0)
    else:
        start_idx = 0
    if end_line is not None and end_line != -1:
        end_idx = min(end_line, len(lines))
    else:
        end_idx = len(lines)

    numbered = []
    for i in range(start_idx, end_idx):
        numbered.append(f"{i + 1}. {lines[i]}")
    output = "\n".join(numbered)

    return {"success": True, "output": sanitize_secrets(truncate_output(output)), "error": None}


def handle_edit(args, project_root, read_only):
    # type: (Dict[str, Any], str, bool) -> Dict[str, Any]
    if read_only:
        return {"success": False, "output": "", "error": "Worker is in read-only mode"}

    path = args.get("path", "")
    old_str = args.get("old_str", "")
    new_str = args.get("new_str", "")

    if not old_str:
        return {"success": False, "output": "", "error": "old_str is required"}

    vr = validate_path(path, project_root)
    if not vr["ok"]:
        return {"success": False, "output": "", "error": vr["error"]}
    resolved = vr["resolved"]

    if not os.path.isfile(resolved):
        return {"success": False, "output": "", "error": f"File not found: {resolved}"}

    try:
        with open(resolved, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}

    content = raw.decode("utf-8", errors="replace")

    # Try exact match first
    count = content.count(old_str)
    if count == 1:
        try:
            with open(resolved, "wb") as fh:
                # Preserve original line ending style
                match_start = content.index(old_str)
                match_region = content[match_start:match_start + len(old_str)]
                replacement = new_str
                if "\r\n" in match_region and "\r\n" not in new_str:
                    replacement = new_str.replace("\n", "\r\n")
                new_content = content.replace(old_str, replacement, 1)
                fh.write(new_content.encode("utf-8"))
            return {"success": True, "output": "Edit applied successfully", "error": None}
        except OSError as exc:
            return {"success": False, "output": "", "error": str(exc)}
    elif count > 1:
        return {
            "success": False,
            "output": "",
            "error": f"old_str matches {count} locations — must be unique (add more context)",
        }

    # Try CRLF-normalised match: normalise both old_str and content to LF
    content_lf = content.replace("\r\n", "\n")
    old_str_lf = old_str.replace("\r\n", "\n")
    count_lf = content_lf.count(old_str_lf)
    if count_lf == 1:
        # Determine line endings in the region being replaced
        # Find the region in the original content
        idx = content_lf.index(old_str_lf)
        # Count how many \r\n exist in the original up to and within this region
        region_start_bytes = len(content_lf[:idx].encode("utf-8"))

        # Determine dominant line ending in original file
        crlf_count = raw.count(b"\r\n")
        lf_only_count = raw.count(b"\n") - crlf_count
        uses_crlf = crlf_count > lf_only_count

        # Normalise new_str to match the file's dominant line ending
        new_str_normalised = new_str.replace("\r\n", "\n")
        if uses_crlf:
            new_str_normalised = new_str_normalised.replace("\n", "\r\n")

        new_content_lf = content_lf.replace(old_str_lf, new_str_normalised, 1)
        # If file used CRLF, restore that
        if uses_crlf:
            # new_content_lf already has CRLF in the replacement, but the rest
            # of the file is LF-only (we normalised). Restore CRLF everywhere.
            new_content_lf = new_content_lf.replace("\r\n", "\n")  # flatten
            new_content_lf = new_content_lf.replace("\n", "\r\n")  # restore

        try:
            with open(resolved, "wb") as fh:
                fh.write(new_content_lf.encode("utf-8"))
            return {"success": True, "output": "Edit applied successfully (CRLF normalised)", "error": None}
        except OSError as exc:
            return {"success": False, "output": "", "error": str(exc)}
    elif count_lf > 1:
        return {
            "success": False,
            "output": "",
            "error": f"old_str matches {count_lf} locations — must be unique (add more context)",
        }

    return {"success": False, "output": "", "error": "old_str not found in file"}


def handle_create(args, project_root, read_only):
    # type: (Dict[str, Any], str, bool) -> Dict[str, Any]
    if read_only:
        return {"success": False, "output": "", "error": "Worker is in read-only mode"}

    path = args.get("path", "")
    file_text = args.get("file_text", "")

    vr = validate_path(path, project_root)
    if not vr["ok"]:
        return {"success": False, "output": "", "error": vr["error"]}
    resolved = vr["resolved"]

    if os.path.exists(resolved):
        return {"success": False, "output": "", "error": f"File already exists: {resolved}"}

    parent = os.path.dirname(resolved)
    if not os.path.isdir(parent):
        return {"success": False, "output": "", "error": f"Parent directory does not exist: {parent}"}

    # Verify parent is within root
    parent_vr = validate_path(parent, project_root)
    if not parent_vr["ok"]:
        return {"success": False, "output": "", "error": parent_vr["error"]}

    try:
        with open(resolved, "w", encoding="utf-8") as fh:
            fh.write(file_text)
        return {"success": True, "output": f"Created {resolved}", "error": None}
    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}


def handle_grep(args, project_root):
    # type: (Dict[str, Any], str) -> Dict[str, Any]
    pattern = args.get("pattern", "")
    if not pattern:
        return {"success": False, "output": "", "error": "pattern is required"}

    search_path = args.get("path", project_root)
    vr = validate_path(search_path, project_root)
    if not vr["ok"]:
        return {"success": False, "output": "", "error": vr["error"]}
    resolved_path = vr["resolved"]

    glob_filter = args.get("glob")
    include_flag = args.get("include")
    case_insensitive = args.get("-i", False)
    show_lines = args.get("-n", True)
    context_after = args.get("-A")
    context_before = args.get("-B")
    context_both = args.get("-C")
    output_mode = args.get("output_mode", "content")
    head_limit = args.get("head_limit")

    # Try ripgrep first
    rg = shutil.which("rg")
    if rg:
        cmd_args = ["--no-follow", "--color=never"]  # type: List[str]
        if case_insensitive:
            cmd_args.append("-i")
        if output_mode == "files_with_matches":
            cmd_args.append("-l")
        elif output_mode == "count":
            cmd_args.append("-c")
        else:
            if show_lines:
                cmd_args.append("-n")
        if context_both is not None:
            cmd_args.extend(["-C", str(context_both)])
        else:
            if context_after is not None:
                cmd_args.extend(["-A", str(context_after)])
            if context_before is not None:
                cmd_args.extend(["-B", str(context_before)])
        if glob_filter:
            cmd_args.extend(["-g", glob_filter])
        if include_flag:
            cmd_args.extend(["-g", include_flag])
        if head_limit:
            cmd_args.extend(["-m", str(head_limit)])
        cmd_args.append(pattern)
        cmd_args.append(resolved_path)

        rc, stdout, stderr = run_command(rg, cmd_args, cwd=project_root)
        output = stdout.strip()
        if rc == 0 or rc == 1:
            return {
                "success": True,
                "output": sanitize_secrets(truncate_output(output)),
                "error": None,
            }
        return {"success": False, "output": output, "error": stderr.strip() or "rg failed"}

    # Fallback: grep (Unix) or findstr (Windows)
    if IS_WINDOWS:
        cmd_args = ["/s", "/n", "/r"]
        if case_insensitive:
            cmd_args.append("/i")
        cmd_args.append(pattern)
        cmd_args.append(os.path.join(resolved_path, "*") if os.path.isdir(resolved_path) else resolved_path)
        rc, stdout, stderr = run_command("findstr", cmd_args, cwd=project_root)
    else:
        grep_bin = shutil.which("grep") or "grep"
        cmd_args = ["-rn"]
        if case_insensitive:
            cmd_args.append("-i")
        if output_mode == "files_with_matches":
            cmd_args.append("-l")
        elif output_mode == "count":
            cmd_args.append("-c")
        if context_both is not None:
            cmd_args.extend(["-C", str(context_both)])
        else:
            if context_after is not None:
                cmd_args.extend(["-A", str(context_after)])
            if context_before is not None:
                cmd_args.extend(["-B", str(context_before)])
        if include_flag:
            cmd_args.extend(["--include", include_flag])
        if glob_filter:
            cmd_args.extend(["--include", glob_filter])
        if head_limit:
            cmd_args.extend(["-m", str(head_limit)])
        cmd_args.append(pattern)
        cmd_args.append(resolved_path)
        rc, stdout, stderr = run_command(grep_bin, cmd_args, cwd=project_root)

    output = stdout.strip()
    if rc in (0, 1):
        return {
            "success": True,
            "output": sanitize_secrets(truncate_output(output)),
            "error": None,
        }
    return {"success": False, "output": output, "error": stderr.strip() or "grep failed"}


def handle_glob(args, project_root):
    # type: (Dict[str, Any], str) -> Dict[str, Any]
    pattern = args.get("pattern", "")
    if not pattern:
        return {"success": False, "output": "", "error": "pattern is required"}

    search_path = args.get("path", project_root)
    vr = validate_path(search_path, project_root)
    if not vr["ok"]:
        return {"success": False, "output": "", "error": vr["error"]}
    base = vr["resolved"]

    results = []  # type: List[str]
    limit = 1000

    # Handle ** (recursive) vs simple patterns
    uses_globstar = "**" in pattern

    try:
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            # Skip symlinks that escape root
            real_dir = os.path.realpath(dirpath)
            norm_real = normalize_for_comparison(real_dir)
            norm_root = normalize_for_comparison(project_root)
            if not (norm_real.startswith(norm_root + "/") or norm_real == norm_root):
                dirnames.clear()
                continue

            # Skip hidden directories
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]

            for name in filenames:
                if name.startswith("."):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, base)

                if uses_globstar:
                    # Match against the relative path using fnmatch
                    # fnmatch doesn't handle ** properly, so split the pattern
                    # For simplicity, convert **/ to a "match anything" approach
                    if _glob_match(rel, pattern):
                        results.append(rel)
                else:
                    # Simple fnmatch on filename only
                    if fnmatch.fnmatch(name, pattern):
                        results.append(rel)

                if len(results) >= limit:
                    break
            if len(results) >= limit:
                break

            # If no globstar, only look in top-level for simple patterns
            if not uses_globstar:
                # Still walk subdirs for directory glob segments
                pass

    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}

    results.sort()
    output = "\n".join(results)
    if len(results) >= limit:
        output += f"\n[results limited to {limit}]"
    return {"success": True, "output": output, "error": None}


def _glob_match(path, pattern):
    # type: (str, str) -> bool
    """Match a relative path against a glob pattern with ** support."""
    # Normalise separators
    path = path.replace("\\", "/")
    pattern = pattern.replace("\\", "/")

    # Convert glob to regex
    regex_parts = []
    i = 0
    n = len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                # **
                if i + 2 < n and pattern[i + 2] == "/":
                    regex_parts.append("(?:.+/)?")
                    i += 3
                    continue
                else:
                    regex_parts.append(".*")
                    i += 2
                    continue
            else:
                regex_parts.append("[^/]*")
        elif c == "?":
            regex_parts.append("[^/]")
        elif c == "{":
            # Brace expansion
            j = pattern.index("}", i) if "}" in pattern[i:] else -1
            if j == -1:
                regex_parts.append(re.escape(c))
            else:
                inner = pattern[i + 1:i + (j - i)]  # content between braces
                # Recalculate: find } relative to i
                end = pattern.index("}", i)
                inner = pattern[i + 1:end]
                alts = inner.split(",")
                regex_parts.append("(?:" + "|".join(re.escape(a) for a in alts) + ")")
                i = end + 1
                continue
        elif c == "[":
            # Character class — pass through
            j = pattern.index("]", i) if "]" in pattern[i:] else -1
            if j == -1:
                regex_parts.append(re.escape(c))
            else:
                regex_parts.append(pattern[i:j + 1])
                i = j + 1
                continue
        else:
            regex_parts.append(re.escape(c))
        i += 1

    regex = "^" + "".join(regex_parts) + "$"
    try:
        return bool(re.match(regex, path))
    except re.error:
        return fnmatch.fnmatch(path, pattern)


def handle_bash(request_id, args, project_root, read_only, ws_send_func):
    # type: (str, Dict[str, Any], str, bool, Any) -> Dict[str, Any]
    command = args.get("command", "")
    if not command:
        return {"success": False, "output": "", "error": "command is required"}

    if read_only:
        return {"success": False, "output": "", "error": "Worker is in read-only mode"}

    description = args.get("description", "")
    timeout_secs = args.get("timeout", 120)
    cwd = args.get("cwd", project_root)

    # Validate cwd
    cwd_vr = validate_path(cwd, project_root)
    if not cwd_vr["ok"]:
        return {"success": False, "output": "", "error": f"Invalid cwd: {cwd_vr['error']}"}
    cwd_resolved = cwd_vr["resolved"]

    exe, shell_args = resolve_shell(command)
    spawn_kwargs = get_spawn_kwargs(cwd_resolved)

    try:
        proc = subprocess.Popen([exe] + shell_args, **spawn_kwargs)
    except FileNotFoundError:
        return {"success": False, "output": "", "error": f"Shell not found: {exe}"}
    except OSError as exc:
        return {"success": False, "output": "", "error": str(exc)}

    active_processes[request_id] = proc

    stdout_chunks = []  # type: List[str]
    stderr_chunks = []  # type: List[str]

    def read_stream(stream, target_list, stream_name):
        # type: (Any, List[str], str) -> None
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                decoded = chunk.decode("utf-8", errors="replace")
                target_list.append(decoded)
                # Stream intermediate output to server
                try:
                    ws_send_func({
                        "type": stream_name,
                        "id": request_id,
                        "data": decoded,
                    })
                except Exception:
                    pass
        except (OSError, ValueError):
            pass

    stdout_thread = threading.Thread(
        target=read_stream, args=(proc.stdout, stdout_chunks, "stdout"), daemon=True
    )
    stderr_thread = threading.Thread(
        target=read_stream, args=(proc.stderr, stderr_chunks, "stderr"), daemon=True
    )
    stdout_thread.start()
    stderr_thread.start()

    try:
        proc.wait(timeout=timeout_secs)
    except subprocess.TimeoutExpired:
        kill_process_tree(proc.pid)
        proc.wait(timeout=10)

    stdout_thread.join(timeout=10)
    stderr_thread.join(timeout=10)

    # Signal end of streaming before sending final result
    try:
        ws_send_func({"type": "stream_end", "id": request_id})
    except Exception:
        pass

    active_processes.pop(request_id, None)

    stdout_text = "".join(stdout_chunks)
    stderr_text = "".join(stderr_chunks)

    combined = stdout_text
    if stderr_text:
        combined = combined + ("\n" if combined else "") + stderr_text

    combined = sanitize_secrets(truncate_output(combined))

    return {
        "success": proc.returncode == 0,
        "output": combined,
        "error": None if proc.returncode == 0 else f"Exit code: {proc.returncode}",
        "exitCode": proc.returncode,
    }


# ---------------------------------------------------------------------------
# Browser CDP support
# ---------------------------------------------------------------------------

chrome_manager = None  # type: Optional['ChromeManager']
_script_store = {}  # type: Dict[str, Dict[str, str]]  # key -> {"code": str, "description": str}
_STORE_MAX_SCRIPTS = 100
_STORE_MAX_SCRIPT_SIZE = 1_000_000  # 1MB
_STORE_MAX_KEY_LEN = 256
_worker_config = None  # type: Optional[Any]
_browser_lock = threading.Lock()


def detect_default_browser():  # type: () -> Optional[str]
    """Detect system default browser: returns 'edge', 'chrome', or None."""
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["reg", "query",
                 r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
                 "/v", "ProgId"],
                capture_output=True, text=True, timeout=5
            )
            output = result.stdout.lower()
            if "chromehtml" in output:
                return "chrome"
            if "msedgehtm" in output:
                return "edge"
        elif sys.platform == "darwin":
            result = subprocess.run(
                ["/usr/bin/open", "-Ra", "http://example.com"],
                capture_output=True, text=True, timeout=5
            )
            output = result.stdout.lower()
            if "microsoft edge" in output:
                return "edge"
            if "google chrome" in output:
                return "chrome"
    except Exception:
        pass
    return None


def find_chrome_binary():  # type: () -> Optional[str]
    """Find Chrome/Chromium/Edge binary on the system, respecting system default."""
    default_browser = detect_default_browser()
    candidates = []
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        # If default is Chrome, move it first
        if default_browser == "chrome":
            chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            if chrome_path in candidates:
                candidates.remove(chrome_path)
                candidates.insert(0, chrome_path)
    elif sys.platform == "win32":
        prefer_edge = (default_browser == "edge")
        for env_var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env_var, "")
            if base:
                chrome = os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
                edge = os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
                if prefer_edge:
                    candidates.extend([edge, chrome])
                else:
                    candidates.extend([chrome, edge])
    else:  # Linux
        candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
        ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    # Fallback: which
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge"):
        path = shutil.which(name)
        if path:
            return path
    return None


class CDPClient:
    """Minimal Chrome DevTools Protocol client over raw WebSocket."""

    def __init__(self, ws_url):  # type: (str) -> None
        self.ws = StdlibWebSocket(ws_url)
        self.ws.connect()
        self._next_id = 1
        self._lock = threading.Lock()
        self._pending = {}  # type: Dict[int, threading.Event]
        self._results = {}  # type: Dict[int, Any]
        self._event_listeners = {}  # type: Dict[str, List[Any]]
        self._running = True
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

    def _reader_loop(self):  # type: () -> None
        try:
            while self._running:
                try:
                    raw = self.ws.recv()
                    if raw is None:
                        break
                    msg = json.loads(raw)
                    msg_id = msg.get("id")
                    if msg_id is not None and msg_id in self._pending:
                        self._results[msg_id] = msg
                        self._pending[msg_id].set()
                    elif "method" in msg:
                        method = msg["method"]
                        with self._lock:
                            listeners = list(self._event_listeners.get(method, []))
                        for cb in listeners:
                            try:
                                cb(msg.get("params", {}))
                            except Exception:
                                pass
                except Exception:
                    if self._running:
                        break
        finally:
            # Complete all pending requests so callers don't hang
            with self._lock:
                for msg_id, evt in list(self._pending.items()):
                    if msg_id not in self._results:
                        self._results[msg_id] = {"error": {"message": "CDP connection closed"}}
                    evt.set()

    def send(self, method, params=None, session_id=None, timeout=30):
        # type: (str, Optional[Dict], Optional[str], int) -> Dict
        with self._lock:
            msg_id = self._next_id
            self._next_id += 1
            evt = threading.Event()
            self._pending[msg_id] = evt
        msg = {"id": msg_id, "method": method}  # type: Dict[str, Any]
        if params:
            msg["params"] = params
        if session_id:
            msg["sessionId"] = session_id
        self.ws.send(json.dumps(msg))
        if not evt.wait(timeout):
            self._pending.pop(msg_id, None)
            raise TimeoutError(f"CDP timeout: {method}")
        self._pending.pop(msg_id, None)
        result = self._results.pop(msg_id, {})
        if "error" in result:
            raise RuntimeError(f"CDP error: {result['error'].get('message', str(result['error']))}")
        return result.get("result", {})

    def on(self, event, callback):  # type: (str, Any) -> None
        with self._lock:
            self._event_listeners.setdefault(event, []).append(callback)

    def close(self):  # type: () -> None
        self._running = False
        try:
            self.ws.close()
        except Exception:
            pass


class ChromeManager:
    """Manages Chrome browser process and CDP sessions."""

    def __init__(self, chrome_path, profile):
        # type: (str, Optional[str]) -> None
        self.chrome_path = chrome_path
        self.profile = profile
        self.process = None  # type: Optional[subprocess.Popen]
        self.cdp = None  # type: Optional[CDPClient]
        self.cdp_port = 9222 + (os.getpid() % 1000)
        self._page_session = None  # type: Optional[str]
        self._dialog_queue = []  # type: List[Dict]
        self._dialog_lock = threading.Lock()
        self._auth_queue = []  # type: List[Dict]
        self._auth_lock = threading.Lock()
        self._downloads = []  # type: List[Dict]
        self._download_lock = threading.Lock()
        self._download_path = tempfile.mkdtemp(prefix="clawd-downloads-")

        # Profile directory
        if profile:
            self._profile_dir = os.path.join(
                os.path.expanduser("~"), ".clawd", "browser-profiles", profile
            )
            os.makedirs(self._profile_dir, exist_ok=True)
            self._temp_dir = None
        else:
            self._temp_dir = tempfile.mkdtemp(prefix=f"clawd-browser-{os.getpid()}-")
            self._profile_dir = self._temp_dir

    def launch(self):  # type: () -> None
        has_display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY") or sys.platform == "darwin" or sys.platform == "win32")
        chrome_args = [
            self.chrome_path,
            f"--remote-debugging-port={self.cdp_port}",
            f"--user-data-dir={self._profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--no-sandbox",
            "--disable-default-apps",
            "--disable-features=TranslateUI",
        ]
        if not has_display:
            chrome_args.append("--headless=new")
        self.process = subprocess.Popen(
            chrome_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for CDP
        for attempt in range(30):
            time.sleep(0.5)
            try:
                conn = socket.create_connection(("127.0.0.1", self.cdp_port), timeout=1)
                conn.close()
                break
            except (ConnectionRefusedError, OSError):
                if attempt == 29:
                    raise RuntimeError("Chrome CDP port not available after 15s")

        # Get WebSocket URL
        import urllib.request
        ws_url = None
        for _ in range(10):
            try:
                resp = urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json/version", timeout=2)
                data = json.loads(resp.read())
                ws_url = data.get("webSocketDebuggerUrl")
                if ws_url:
                    break
            except Exception:
                time.sleep(0.3)
        if not ws_url:
            raise RuntimeError("Could not get CDP WebSocket URL")

        self.cdp = CDPClient(ws_url)
        # Attach to first page
        targets = self.cdp.send("Target.getTargets")
        page_targets = [t for t in targets.get("targetInfos", []) if t.get("type") == "page"]
        if not page_targets:
            # Create a page
            result = self.cdp.send("Target.createTarget", {"url": "about:blank"})
            target_id = result["targetId"]
        else:
            target_id = page_targets[0]["targetId"]
        attach = self.cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        self._page_session = attach.get("sessionId")
        # Enable domains
        for domain in ("Page", "DOM", "Runtime", "Network"):
            self.cdp.send(f"{domain}.enable", session_id=self._page_session)
        # Dialog listener
        self.cdp.on("Page.javascriptDialogOpening", self._on_dialog)
        # Register Fetch handlers BEFORE enabling to avoid race condition
        self.cdp.on("Fetch.authRequired", self._on_auth_required)
        self.cdp.on("Fetch.requestPaused", self._on_request_paused)
        # Enable Fetch for HTTP auth interception (after handlers registered)
        try:
            self.cdp.send("Fetch.enable", {"handleAuthRequests": True}, session_id=self._page_session)
        except Exception:
            pass
        # Configure downloads
        os.makedirs(self._download_path, exist_ok=True)
        self.cdp.send("Browser.setDownloadBehavior", {
            "behavior": "allowAndName",
            "downloadPath": self._download_path,
            "eventsEnabled": True,
        })
        self.cdp.on("Browser.downloadWillBegin", self._on_download_begin)
        self.cdp.on("Browser.downloadProgress", self._on_download_progress)

    def _on_dialog(self, params):  # type: (Dict) -> None
        with self._dialog_lock:
            self._dialog_queue.append(params)

    def pop_dialog(self):  # type: () -> Optional[Dict]
        with self._dialog_lock:
            return self._dialog_queue.pop(0) if self._dialog_queue else None

    def _on_auth_required(self, params):  # type: (Dict) -> None
        with self._auth_lock:
            self._auth_queue.append({
                "requestId": params.get("requestId", ""),
                "url": params.get("request", {}).get("url", ""),
                "scheme": params.get("authChallenge", {}).get("scheme", ""),
                "realm": params.get("authChallenge", {}).get("realm", ""),
            })

    def _on_request_paused(self, params):  # type: (Dict) -> None
        # Continue non-auth paused requests transparently
        try:
            self.cdp.send("Fetch.continueRequest", {"requestId": params.get("requestId")}, session_id=self._page_session)
        except Exception:
            pass

    def pop_auth(self):  # type: () -> Optional[Dict]
        with self._auth_lock:
            return self._auth_queue.pop(0) if self._auth_queue else None

    def peek_auth(self):  # type: () -> Optional[Dict]
        with self._auth_lock:
            return self._auth_queue[0] if self._auth_queue else None

    @property
    def download_path(self):  # type: () -> str
        return self._download_path

    def set_download_path(self, path):  # type: (str) -> None
        with self._download_lock:
            self._download_path = path

    def get_downloads(self):  # type: () -> List[Dict]
        with self._download_lock:
            return [dict(d) for d in self._downloads]

    def _on_download_begin(self, params):  # type: (Dict) -> None
        with self._download_lock:
            self._downloads.append({
                "guid": params.get("guid", ""),
                "url": params.get("url", ""),
                "filename": params.get("suggestedFilename", ""),
                "state": "inProgress",
                "totalBytes": 0,
                "receivedBytes": 0,
            })
            # Cap at 100 entries
            if len(self._downloads) > 100:
                self._downloads = self._downloads[-100:]

    def _on_download_progress(self, params):  # type: (Dict) -> None
        with self._download_lock:
            for dl in self._downloads:
                if dl["guid"] == params.get("guid"):
                    dl["state"] = params.get("state", dl["state"])
                    dl["totalBytes"] = params.get("totalBytes", dl["totalBytes"])
                    dl["receivedBytes"] = params.get("receivedBytes", dl["receivedBytes"])
                    if dl["state"] == "completed":
                        safe_name = os.path.basename(dl["filename"]).replace("/", "_").replace("\\", "_") or "download"
                        dl["path"] = os.path.join(self._download_path, safe_name)
                    break

    @property
    def session(self):  # type: () -> Optional[str]
        return self._page_session

    def switch_to_target(self, target_id):  # type: (str) -> None
        if self._page_session:
            try:
                self.cdp.send("Target.detachFromTarget", {"sessionId": self._page_session})
            except Exception:
                pass
        attach = self.cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        self._page_session = attach.get("sessionId")
        for domain in ("Page", "DOM", "Runtime", "Network"):
            self.cdp.send(f"{domain}.enable", session_id=self._page_session)
        try:
            self.cdp.send("Fetch.enable", {"handleAuthRequests": True}, session_id=self._page_session)
        except Exception:
            pass

    def shutdown(self):  # type: () -> None
        if self.cdp:
            try:
                self.cdp.send("Browser.close", timeout=3)
            except Exception:
                pass
            self.cdp.close()
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                try:
                    self.process.kill()
                    self.process.wait(timeout=2)
                except Exception:
                    pass
        if self._temp_dir and os.path.isdir(self._temp_dir):
            try:
                shutil.rmtree(self._temp_dir, ignore_errors=True)
            except Exception:
                pass


def start_chrome_manager(profile_arg):  # type: (str) -> Optional[ChromeManager]
    """Start Chrome with CDP and return a ChromeManager, or None if Chrome not found."""
    global chrome_manager
    chrome_path = find_chrome_binary()
    if not chrome_path:
        return None
    mgr = ChromeManager(chrome_path, profile_arg if profile_arg else None)
    try:
        mgr.launch()
    except Exception as exc:
        log(f"Failed to launch Chrome: {exc}")
        return None
    chrome_manager = mgr
    return mgr


def ensure_browser():  # type: () -> ChromeManager
    """Thread-safe health check + lazy restart. Returns healthy ChromeManager."""
    global chrome_manager
    with _browser_lock:
        if chrome_manager and chrome_manager.cdp:
            try:
                chrome_manager.cdp.send("Browser.getVersion", timeout=3)
                return chrome_manager
            except Exception:
                log("Browser CDP connection lost, restarting...")
                try:
                    chrome_manager.shutdown()
                except Exception:
                    pass
                chrome_manager = None
        if not _worker_config or not getattr(_worker_config, "browser", None):
            raise RuntimeError("Browser not enabled. Start worker with --browser flag.")
        mgr = start_chrome_manager(_worker_config.browser)
        if not mgr:
            raise RuntimeError("Failed to start browser. Ensure Chrome or Edge is installed.")
        chrome_manager = mgr
        return mgr


def _js_str(s):  # type: (str) -> str
    """Escape string for safe embedding in JavaScript using JSON serialization."""
    return json.dumps(s)


def cdp_evaluate(expression, session_id):  # type: (str, str) -> Any
    """Evaluate JS in page context via CDP."""
    if not chrome_manager or not chrome_manager.cdp:
        raise RuntimeError("Browser not available")
    result = chrome_manager.cdp.send(
        "Runtime.evaluate",
        {"expression": expression, "returnByValue": True, "awaitPromise": True},
        session_id=session_id,
    )
    ex = result.get("exceptionDetails")
    if ex:
        text = ex.get("text", "")
        exc_obj = ex.get("exception", {})
        desc = exc_obj.get("description", exc_obj.get("value", ""))
        raise RuntimeError(f"JS error: {text} {desc}".strip())
    return result.get("result", {}).get("value")


def resolve_selector(selector, session_id):
    # type: (str, str) -> Dict
    """Resolve a CSS selector to center coordinates via CDP."""
    if not chrome_manager or not chrome_manager.cdp:
        raise RuntimeError("Browser not available")
    cdp = chrome_manager.cdp
    doc = cdp.send("DOM.getDocument", {"depth": 0}, session_id=session_id)
    node_id = cdp.send(
        "DOM.querySelector",
        {"nodeId": doc["root"]["nodeId"], "selector": selector},
        session_id=session_id,
    ).get("nodeId", 0)
    if not node_id:
        raise RuntimeError(f"Element not found: {selector}")
    box = cdp.send("DOM.getBoxModel", {"nodeId": node_id}, session_id=session_id)
    content = box["model"]["content"]
    # content is [x1,y1, x2,y2, x3,y3, x4,y4]
    cx = (content[0] + content[2] + content[4] + content[6]) / 4
    cy = (content[1] + content[3] + content[5] + content[7]) / 4
    return {"x": cx, "y": cy, "nodeId": node_id}


# ---------------------------------------------------------------------------
# Browser tool handlers
# ---------------------------------------------------------------------------

def handle_browser_status(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        url = cdp_evaluate("window.location.href", chrome_manager.session)
        title = cdp_evaluate("document.title", chrome_manager.session)
        return {"success": True, "output": json.dumps({"url": url, "title": title})}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_navigate(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    url = args.get("url", "")
    if not url:
        return {"success": False, "output": "", "error": "url required"}
    if url.lower().startswith("file://"):
        return {"success": False, "output": "", "error": "file:// URLs are not allowed"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        cdp.send("Page.navigate", {"url": url}, session_id=sid)
        deadline = time.time() + 30
        loaded = False
        while time.time() < deadline:
            try:
                state = cdp_evaluate("document.readyState", sid)
                if state == "complete":
                    loaded = True
                    break
            except Exception:
                pass
            time.sleep(0.3)
        title = cdp_evaluate("document.title", sid)
        final_url = cdp_evaluate("window.location.href", sid)
        result = {"url": final_url, "title": title}
        if not loaded:
            result["warning"] = "Page did not fully load within 30s"
        return {"success": True, "output": json.dumps(result)}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_screenshot(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        params = {"format": "jpeg", "quality": args.get("quality", 80)}  # type: Dict[str, Any]
        if args.get("selector"):
            pos = resolve_selector(args["selector"], chrome_manager.session)
            # Use clip for the element
            cdp = chrome_manager.cdp
            box = cdp.send("DOM.getBoxModel", {"nodeId": pos["nodeId"]}, session_id=chrome_manager.session)
            content = box["model"]["content"]
            min_x = min(content[0], content[2], content[4], content[6])
            min_y = min(content[1], content[3], content[5], content[7])
            max_x = max(content[0], content[2], content[4], content[6])
            max_y = max(content[1], content[3], content[5], content[7])
            params["clip"] = {"x": min_x, "y": min_y, "width": max_x - min_x, "height": max_y - min_y, "scale": 1}
        result = chrome_manager.cdp.send("Page.captureScreenshot", params, session_id=chrome_manager.session)
        return {"success": True, "output": result.get("data", ""), "mimeType": "image/jpeg", "isBase64": True}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_click(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        if args.get("selector"):
            pos = resolve_selector(args["selector"], sid)
            x, y = pos["x"], pos["y"]
        elif args.get("x") is not None and args.get("y") is not None:
            x, y = float(args["x"]), float(args["y"])
        else:
            return {"success": False, "output": "", "error": "selector or x,y required"}
        btn = args.get("button", "left")
        click_count = 2 if args.get("double") else 1
        # Move mouse to target first (triggers hover states, mouseenter events)
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y,
        }, session_id=sid)
        for event_type in ("mousePressed", "mouseReleased"):
            cdp.send("Input.dispatchMouseEvent", {
                "type": event_type, "x": x, "y": y,
                "button": btn, "clickCount": click_count,
            }, session_id=sid)
        return {"success": True, "output": f"Clicked at ({x:.0f}, {y:.0f})"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_type(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        text = args.get("text", "")
        if args.get("selector"):
            pos = resolve_selector(args["selector"], sid)
            for evt in ("mousePressed", "mouseReleased"):
                cdp.send("Input.dispatchMouseEvent", {
                    "type": evt, "x": pos["x"], "y": pos["y"],
                    "button": "left", "clickCount": 1,
                }, session_id=sid)
        if args.get("clear"):
            # Select all + delete
            for key_code in [("a", 2), ("Backspace", 0)]:
                cdp.send("Input.dispatchKeyEvent", {
                    "type": "keyDown", "key": key_code[0], "modifiers": key_code[1],
                }, session_id=sid)
                cdp.send("Input.dispatchKeyEvent", {
                    "type": "keyUp", "key": key_code[0], "modifiers": key_code[1],
                }, session_id=sid)
        cdp.send("Input.insertText", {"text": text}, session_id=sid)
        if args.get("submit"):
            cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter"}, session_id=sid)
            cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter"}, session_id=sid)
        return {"success": True, "output": f"Typed {len(text)} characters"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_extract(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        sid = chrome_manager.session
        mode = args.get("mode", "text")
        selector = args.get("selector")
        expressions = {
            "text": "document.body.innerText",
            "html": "document.documentElement.outerHTML",
            "links": "JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(a=>({text:a.textContent.trim(),href:a.href})).filter(l=>l.text||l.href))",
            "forms": "JSON.stringify(Array.from(document.querySelectorAll('form')).map(f=>({action:f.action,method:f.method,inputs:Array.from(f.querySelectorAll('input,select,textarea')).map(i=>({name:i.name,type:i.type,value:i.value}))})))",
            "tables": "JSON.stringify(Array.from(document.querySelectorAll('table')).map(t=>({headers:Array.from(t.querySelectorAll('th')).map(th=>th.textContent.trim()),rows:Array.from(t.querySelectorAll('tbody tr')).map(tr=>Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim()))})))",
            "accessibility": "JSON.stringify({title:document.title,lang:document.documentElement.lang,headings:Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h=>({level:h.tagName,text:h.textContent.trim()})),landmarks:Array.from(document.querySelectorAll('[role]')).map(e=>({role:e.getAttribute('role'),label:e.getAttribute('aria-label')||''}))})",
        }
        if selector:
            base_expr = f"document.querySelector({_js_str(selector)})"
            if mode == "text":
                expr = f"({base_expr})?.innerText || ''"
            elif mode == "html":
                expr = f"({base_expr})?.outerHTML || ''"
            else:
                expr = expressions.get(mode, expressions["text"])
        else:
            expr = expressions.get(mode, expressions["text"])
        result = cdp_evaluate(expr, sid)
        output = result if isinstance(result, str) else json.dumps(result)
        # Truncate
        if len(output) > 100000:
            output = output[:100000] + "\n... (truncated)"
        return {"success": True, "output": output}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_tabs(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        action = args.get("action", "list")
        if action == "list":
            targets = cdp.send("Target.getTargets")
            pages = [t for t in targets.get("targetInfos", []) if t.get("type") == "page"]
            return {"success": True, "output": json.dumps([{"id": p["targetId"], "url": p.get("url", ""), "title": p.get("title", "")} for p in pages])}
        elif action == "new":
            url = args.get("url", "about:blank")
            result = cdp.send("Target.createTarget", {"url": url})
            target_id = result["targetId"]
            chrome_manager.switch_to_target(target_id)
            return {"success": True, "output": json.dumps({"targetId": target_id})}
        elif action == "close":
            target_id = args.get("targetId", "")
            if not target_id:
                return {"success": False, "output": "", "error": "targetId required"}
            cdp.send("Target.closeTarget", {"targetId": target_id})
            return {"success": True, "output": f"Closed tab {target_id}"}
        elif action == "switch":
            target_id = args.get("targetId", "")
            if not target_id:
                return {"success": False, "output": "", "error": "targetId required"}
            cdp.send("Target.activateTarget", {"targetId": target_id})
            chrome_manager.switch_to_target(target_id)
            return {"success": True, "output": f"Switched to tab {target_id}"}
        else:
            return {"success": False, "output": "", "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_execute(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        code = args.get("code", "")
        script_id = args.get("script_id", "")
        if script_id:
            stored = _script_store.get(script_id)
            if not stored:
                return {"success": False, "output": "", "error": "Script '" + script_id + "' not found. Use browser_store action=set first."}
            args_json = json.dumps(args.get("script_args", {}))
            wrapped = "(async function(){const __args=" + args_json + ";" + stored["code"] + "})()"
        else:
            if not code:
                return {"success": False, "output": "", "error": "Either 'code' or 'script_id' is required"}
            wrapped = "(async()=>{" + code + "})()"
        result = cdp_evaluate(wrapped, chrome_manager.session)
        output = result if isinstance(result, str) else json.dumps(result)
        return {"success": True, "output": output}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_scroll(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        direction = args.get("direction", "down")
        amount = args.get("amount", 300)
        x = args.get("x", 100)
        y = args.get("y", 100)
        if args.get("selector"):
            pos = resolve_selector(args["selector"], sid)
            x, y = pos["x"], pos["y"]
        dx, dy = 0, 0
        if direction == "down":
            dy = amount
        elif direction == "up":
            dy = -amount
        elif direction == "right":
            dx = amount
        elif direction == "left":
            dx = -amount
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy,
        }, session_id=sid)
        return {"success": True, "output": f"Scrolled {direction} by {amount}px"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


KEY_MAP = {
    "Enter": (13, "\r"), "Tab": (9, "\t"), "Escape": (27, ""),
    "Backspace": (8, "\b"), "Delete": (46, ""), "Space": (32, " "),
    "ArrowUp": (38, ""), "ArrowDown": (40, ""), "ArrowLeft": (37, ""), "ArrowRight": (39, ""),
    "Home": (36, ""), "End": (35, ""), "PageUp": (33, ""), "PageDown": (34, ""),
    "F1": (112, ""), "F2": (113, ""), "F3": (114, ""), "F4": (115, ""), "F5": (116, ""),
    "F6": (117, ""), "F7": (118, ""), "F8": (119, ""), "F9": (120, ""), "F10": (121, ""),
    "F11": (122, ""), "F12": (123, ""),
}


def handle_browser_keypress(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        key = args.get("key", "")
        if not key:
            return {"success": False, "output": "", "error": "key is required"}
        modifiers_list = args.get("modifiers", [])
        mod_flags = 0
        if "alt" in modifiers_list:
            mod_flags |= 1
        if "ctrl" in modifiers_list:
            mod_flags |= 2
        if "meta" in modifiers_list:
            mod_flags |= 4
        if "shift" in modifiers_list:
            mod_flags |= 8
        key_info = KEY_MAP.get(key)
        params = {"key": key, "modifiers": mod_flags}  # type: Dict[str, Any]
        if key_info:
            params["windowsVirtualKeyCode"] = key_info[0]
            if key_info[1]:
                params["text"] = key_info[1]
        elif len(key) == 1:
            params["text"] = key
            params["windowsVirtualKeyCode"] = ord(key.upper())
        cdp.send("Input.dispatchKeyEvent", dict(type="keyDown", **params), session_id=sid)
        cdp.send("Input.dispatchKeyEvent", dict(type="keyUp", **params), session_id=sid)
        return {"success": True, "output": f"Pressed {key}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_wait_for(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        selector = args.get("selector", "")
        if not selector:
            return {"success": False, "output": "", "error": "selector required"}
        timeout_ms = args.get("timeout", 10000)
        check_visible = args.get("visible", True)
        deadline = time.time() + timeout_ms / 1000
        sid = chrome_manager.session
        while time.time() < deadline:
            if check_visible:
                found = cdp_evaluate(
                    f"!!(function(){{var el=document.querySelector({_js_str(selector)});if(!el)return false;var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}})()",
                    sid,
                )
            else:
                found = cdp_evaluate(f"!!document.querySelector({_js_str(selector)})", sid)
            if found:
                return {"success": True, "output": f"Found: {selector}"}
            time.sleep(0.5)
        return {"success": False, "output": "", "error": f"Timeout waiting for {selector}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_select(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        selector = args.get("selector", "")
        if not selector:
            return {"success": False, "output": "", "error": "selector required"}
        sid = chrome_manager.session
        value = args.get("value")
        text = args.get("text")
        index = args.get("index")
        if value is not None:
            expr = f"(function(){{var s=document.querySelector({_js_str(selector)});s.value={_js_str(value)};s.dispatchEvent(new Event('change',{{bubbles:true}}));return s.value;}})()"
        elif text is not None:
            expr = f"(function(){{var s=document.querySelector({_js_str(selector)});var o=Array.from(s.options).find(o=>o.text==={_js_str(text)});if(o){{s.value=o.value;s.dispatchEvent(new Event('change',{{bubbles:true}}));return o.value;}}return null;}})()"
        elif index is not None:
            expr = f"(function(){{var s=document.querySelector({_js_str(selector)});s.selectedIndex={index};s.dispatchEvent(new Event('change',{{bubbles:true}}));return s.value;}})()"
        else:
            return {"success": False, "output": "", "error": "value, text, or index required"}
        result = cdp_evaluate(expr, sid)
        return {"success": True, "output": f"Selected: {result}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_hover(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        if args.get("selector"):
            pos = resolve_selector(args["selector"], sid)
            x, y = pos["x"], pos["y"]
        elif args.get("x") is not None and args.get("y") is not None:
            x, y = float(args["x"]), float(args["y"])
        else:
            return {"success": False, "output": "", "error": "selector or x,y required"}
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y,
        }, session_id=sid)
        return {"success": True, "output": f"Hovered at ({x:.0f}, {y:.0f})"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_history(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        action = args.get("action", "back")
        sid = chrome_manager.session
        history = chrome_manager.cdp.send("Page.getNavigationHistory", session_id=sid)
        idx = history.get("currentIndex", 0)
        entries = history.get("entries", [])
        if action == "back" and idx > 0:
            chrome_manager.cdp.send("Page.navigateToHistoryEntry", {"entryId": entries[idx - 1]["id"]}, session_id=sid)
            return {"success": True, "output": f"Navigated back to {entries[idx - 1].get('url', '')}"}
        elif action == "forward" and idx < len(entries) - 1:
            chrome_manager.cdp.send("Page.navigateToHistoryEntry", {"entryId": entries[idx + 1]["id"]}, session_id=sid)
            return {"success": True, "output": f"Navigated forward to {entries[idx + 1].get('url', '')}"}
        else:
            return {"success": False, "output": "", "error": f"Cannot go {action}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_dialog(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        dialog = chrome_manager.pop_dialog()
        if not dialog:
            return {"success": True, "output": json.dumps({"handled": False, "message": "No pending dialog"})}
        action = args.get("action", "accept")
        params = {"accept": action == "accept"}  # type: Dict[str, Any]
        if args.get("prompt_text") is not None:
            params["promptText"] = args["prompt_text"]
        chrome_manager.cdp.send("Page.handleJavaScriptDialog", params, session_id=chrome_manager.session)
        return {"success": True, "output": json.dumps({"type": dialog.get("type"), "message": dialog.get("message"), "action": action})}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_auth(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        action = args.get("action", "status")
        if action == "status":
            auth = chrome_manager.peek_auth()
            if not auth:
                return {"success": True, "output": json.dumps({"pending": False})}
            return {"success": True, "output": json.dumps({"pending": True, "url": auth["url"], "scheme": auth["scheme"], "realm": auth["realm"]})}
        elif action == "provide":
            auth = chrome_manager.pop_auth()
            if not auth:
                return {"success": False, "output": "", "error": "No pending auth challenge"}
            chrome_manager.cdp.send("Fetch.continueWithAuth", {
                "requestId": auth["requestId"],
                "authChallengeResponse": {"response": "ProvideCredentials", "username": args.get("username", ""), "password": args.get("password", "")},
            }, session_id=chrome_manager.session)
            return {"success": True, "output": json.dumps({"authenticated": True})}
        elif action == "cancel":
            auth = chrome_manager.pop_auth()
            if not auth:
                return {"success": False, "output": "", "error": "No pending auth challenge"}
            chrome_manager.cdp.send("Fetch.continueWithAuth", {
                "requestId": auth["requestId"],
                "authChallengeResponse": {"response": "CancelAuth"},
            }, session_id=chrome_manager.session)
            return {"success": True, "output": json.dumps({"cancelled": True})}
        return {"success": False, "output": "", "error": "Unknown action: " + action}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_permissions(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        action = args.get("action", "grant")
        perms = args.get("permissions", [])  # type: list
        origin = args.get("origin")
        perm_map = {
            "camera": "videoCapture", "microphone": "audioCapture",
            "clipboard-read": "clipboardReadWrite", "clipboard-write": "clipboardSanitizedWrite",
            "background-sync": "backgroundSync", "screen-wake-lock": "wakeLockScreen",
        }
        cdp_perms = [perm_map.get(p, p) for p in perms]
        if action == "grant":
            if not cdp_perms:
                return {"success": False, "output": "", "error": "permissions array is required"}
            params = {"permissions": cdp_perms}  # type: Dict[str, Any]
            if origin:
                params["origin"] = origin
            chrome_manager.cdp.send("Browser.grantPermissions", params)
            return {"success": True, "output": json.dumps({"granted": cdp_perms})}
        elif action == "deny":
            params = {}
            if origin:
                params["origin"] = origin
            chrome_manager.cdp.send("Browser.resetPermissions", params)
            return {"success": True, "output": json.dumps({"denied": cdp_perms, "note": "Permissions reset (CDP has no explicit deny)"})}
        elif action == "reset":
            params = {}
            if origin:
                params["origin"] = origin
            chrome_manager.cdp.send("Browser.resetPermissions", params)
            return {"success": True, "output": json.dumps({"reset": True})}
        return {"success": False, "output": "", "error": "Unknown action: " + action}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_store(args):  # type: (Dict) -> Dict
    action = args.get("action", "list")
    if action == "set":
        key = args.get("key", "")
        value = args.get("value", "")
        if not key:
            return {"success": False, "output": "", "error": "key is required"}
        if not value:
            return {"success": False, "output": "", "error": "value is required"}
        if len(key) > _STORE_MAX_KEY_LEN:
            return {"success": False, "output": "", "error": "key too long (max %d chars)" % _STORE_MAX_KEY_LEN}
        if len(value) > _STORE_MAX_SCRIPT_SIZE:
            return {"success": False, "output": "", "error": "script too large (max %d bytes)" % _STORE_MAX_SCRIPT_SIZE}
        if key not in _script_store and len(_script_store) >= _STORE_MAX_SCRIPTS:
            return {"success": False, "output": "", "error": "store full (max %d scripts)" % _STORE_MAX_SCRIPTS}
        desc = args.get("description", "")
        _script_store[key] = {"code": value, "description": desc}
        return {"success": True, "output": json.dumps({"stored": True, "key": key})}
    elif action == "get":
        key = args.get("key", "")
        if not key:
            return {"success": False, "output": "", "error": "key is required"}
        item = _script_store.get(key)
        if not item:
            return {"success": True, "output": json.dumps({"found": False})}
        return {"success": True, "output": json.dumps({"found": True, "key": key, "value": item["code"], "description": item["description"]})}
    elif action == "list":
        items = [{"key": k, "description": v["description"], "size": len(v["code"])} for k, v in _script_store.items()]
        return {"success": True, "output": json.dumps({"count": len(items), "items": items})}
    elif action == "delete":
        key = args.get("key", "")
        if not key:
            return {"success": False, "output": "", "error": "key is required"}
        deleted = key in _script_store
        _script_store.pop(key, None)
        return {"success": True, "output": json.dumps({"deleted": deleted})}
    elif action == "clear":
        count = len(_script_store)
        _script_store.clear()
        return {"success": True, "output": json.dumps({"cleared": count})}
    return {"success": False, "output": "", "error": "Unknown action: " + action}


def _get_http_base_url():  # type: () -> str
    """Convert WS URL to HTTP URL."""
    url = _worker_config.server
    if url.startswith("wss://"):
        return "https://" + url[6:]
    elif url.startswith("ws://"):
        return "http://" + url[5:]
    return url


def _download_chat_file(file_id):  # type: (str) -> str
    """Download a file from the chat server, save to temp, return path."""
    import urllib.request
    url = "%s/api/files/%s" % (_get_http_base_url(), urllib.parse.quote(file_id, safe=""))
    resp = urllib.request.urlopen(url, timeout=30)
    data = resp.read()
    # Extract filename from Content-Disposition
    disposition = resp.headers.get("Content-Disposition", "")
    name = file_id
    if "filename=" in disposition:
        m = re.search(r'filename="?([^";\r\n]+)"?', disposition)
        if m:
            name = m.group(1)
    tmp_dir = os.path.join(tempfile.gettempdir(), "clawd-chat-files")
    os.makedirs(tmp_dir, exist_ok=True)
    safe_name = name.replace("/", "_").replace("\\", "_").replace("\x00", "")
    if not safe_name or safe_name in (".", ".."):
        safe_name = file_id
    safe_name = "%s_%s" % (file_id.replace("/", "_")[:32], safe_name)
    path = os.path.join(tmp_dir, safe_name)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _upload_chat_file(file_path):  # type: (str) -> Dict
    """Upload a file to the chat server, return {id, name}."""
    import urllib.request
    import mimetypes
    name = os.path.basename(file_path)
    mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        file_data = f.read()
    boundary = "----ClawdBoundary%d" % int(time.time() * 1000)
    body = bytearray()
    body += ("--%s\r\n" % boundary).encode()
    body += ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % name.replace('"', '\\"')).encode()
    body += ("Content-Type: %s\r\n\r\n" % mime).encode()
    body += file_data
    body += ("\r\n--%s--\r\n" % boundary).encode()
    url = "%s/api/files.upload" % _get_http_base_url()
    req = urllib.request.Request(url, data=bytes(body), method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=%s" % boundary)
    resp = urllib.request.urlopen(req, timeout=60)
    result = json.loads(resp.read())
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "Upload failed"))
    return {"id": result["file"]["id"], "name": result["file"]["name"]}


def handle_browser_upload(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not available"}
    try:
        selector = args.get("selector", "")
        files = args.get("files", [])
        if not selector:
            return {"success": False, "output": "", "error": "selector is required"}
        # Validate local files
        if files and isinstance(files, list):
            for f in files:
                if not os.path.isfile(f):
                    return {"success": False, "output": "", "error": "File not found: " + f}
        # Download chat files if file_ids provided
        file_ids = args.get("file_ids", [])
        temp_files = []
        if file_ids and isinstance(file_ids, list):
            for fid in file_ids:
                temp_path = _download_chat_file(fid)
                temp_files.append(temp_path)
        all_files = list(files or []) + temp_files
        if not all_files:
            return {"success": False, "output": "", "error": "files or file_ids required"}
        sid = chrome_manager.session
        info = resolve_selector(selector, sid)
        node_id = info["nodeId"]
        chrome_manager.cdp.send("DOM.setFileInputFiles", {"files": all_files, "nodeId": node_id}, session_id=sid)
        # Dispatch change and input events
        js = "(() => { const el = document.querySelector(%s); if (el) { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); } })()" % _js_str(selector)
        chrome_manager.cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True}, session_id=sid)
        count = len(all_files)
        # Clean up temp files
        for f in temp_files:
            try:
                os.unlink(f)
            except Exception:
                pass
        return {"success": True, "output": "Uploaded %d file(s) to %s" % (count, selector)}
    except Exception as e:
        for f in temp_files:
            try:
                os.unlink(f)
            except Exception:
                pass
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_download(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not available"}
    try:
        action = args.get("action", "list")
        if action == "configure":
            path = args.get("path", "")
            if not path:
                return {"success": False, "output": "", "error": "path is required for configure"}
            resolved = os.path.realpath(os.path.expanduser(path))
            home = os.path.realpath(os.path.expanduser("~"))
            tmp = os.path.realpath(tempfile.gettempdir())
            if not (resolved.startswith(home + os.sep) or resolved == home or
                    resolved.startswith(tmp + os.sep) or resolved == tmp):
                return {"success": False, "output": "", "error": "Download path must be under home or temp directory"}
            os.makedirs(resolved, exist_ok=True)
            chrome_manager.set_download_path(resolved)
            chrome_manager.cdp.send("Browser.setDownloadBehavior", {
                "behavior": "allowAndName",
                "downloadPath": resolved,
                "eventsEnabled": True,
            })
            return {"success": True, "output": "Download directory set to " + resolved}
        elif action == "wait":
            timeout = args.get("timeout", 30000)
            deadline = time.time() + timeout / 1000.0
            all_dl = chrome_manager.get_downloads()
            start_count = len([d for d in all_dl if d["state"] == "completed"])
            start_canceled_count = len([d for d in all_dl if d["state"] == "canceled"])
            while time.time() < deadline:
                downloads = chrome_manager.get_downloads()
                completed = [d for d in downloads if d["state"] == "completed"]
                if len(completed) > start_count:
                    latest = completed[-1]
                    file_info = None
                    if args.get("upload") and latest.get("path") and os.path.isfile(latest["path"]):
                        try:
                            file_info = _upload_chat_file(latest["path"])
                        except Exception:
                            pass  # Upload failed but download succeeded
                    result = {
                        "filename": latest["filename"], "path": latest.get("path", ""),
                        "url": latest["url"], "totalBytes": latest["totalBytes"],
                    }
                    if file_info:
                        result["file_id"] = file_info["id"]
                        result["file_name"] = file_info["name"]
                    return {"success": True, "output": json.dumps(result, indent=2)}
                canceled = [d for d in downloads if d["state"] == "canceled"]
                if len(canceled) > start_canceled_count:
                    return {"success": False, "output": "", "error": "Download canceled: " + canceled[-1]["filename"]}
                time.sleep(0.5)
            return {"success": False, "output": "", "error": "No download completed within %dms" % timeout}
        elif action == "list":
            downloads = chrome_manager.get_downloads()
            result = [{"filename": d["filename"], "url": d["url"], "state": d["state"],
                        "totalBytes": d["totalBytes"], "receivedBytes": d["receivedBytes"],
                        "path": d.get("path", "")} for d in downloads]
            return {"success": True, "output": json.dumps(result, indent=2)}
        else:
            return {"success": False, "output": "", "error": "Unknown action: %s. Use 'configure', 'wait', or 'list'" % action}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_mouse_move(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        x, y = float(args["x"]), float(args["y"])
        steps = int(args.get("steps", 1))
        from_x = float(args.get("from_x", x))
        from_y = float(args.get("from_y", y))
        for i in range(1, steps + 1):
            mx = from_x + (x - from_x) * i / steps
            my = from_y + (y - from_y) * i / steps
            cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": mx, "y": my,
            }, session_id=sid)
        return {"success": True, "output": f"Mouse moved to ({x:.0f}, {y:.0f}) in {steps} step(s)"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_drag(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        # Resolve start position
        if args.get("from_selector"):
            pos = resolve_selector(args["from_selector"], sid)
            fx, fy = pos["x"], pos["y"]
        elif args.get("from_x") is not None and args.get("from_y") is not None:
            fx, fy = float(args["from_x"]), float(args["from_y"])
        else:
            return {"success": False, "output": "", "error": "from_selector or from_x,from_y required"}
        # Resolve end position
        if args.get("to_selector"):
            pos = resolve_selector(args["to_selector"], sid)
            tx, ty = pos["x"], pos["y"]
        elif args.get("to_x") is not None and args.get("to_y") is not None:
            tx, ty = float(args["to_x"]), float(args["to_y"])
        else:
            return {"success": False, "output": "", "error": "to_selector or to_x,to_y required"}
        steps = int(args.get("steps", 10))
        # Press
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": fx, "y": fy,
            "button": "left", "clickCount": 1,
        }, session_id=sid)
        # Move in steps
        for i in range(1, steps + 1):
            mx = fx + (tx - fx) * i / steps
            my = fy + (ty - fy) * i / steps
            cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": mx, "y": my,
                "button": "left",
            }, session_id=sid)
            time.sleep(0.02)
        # Release
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": tx, "y": ty,
            "button": "left", "clickCount": 1,
        }, session_id=sid)
        return {"success": True, "output": f"Dragged from ({fx:.0f}, {fy:.0f}) to ({tx:.0f}, {ty:.0f})"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_touch(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        cdp = chrome_manager.cdp
        sid = chrome_manager.session
        action = args.get("action", "tap")
        # Resolve target coordinates
        if args.get("selector"):
            pos = resolve_selector(args["selector"], sid)
            x, y = pos["x"], pos["y"]
        elif args.get("x") is not None and args.get("y") is not None:
            x, y = float(args["x"]), float(args["y"])
        else:
            return {"success": False, "output": "", "error": "selector or x,y required"}

        def _tp(px, py, tid=0):
            return {"x": px, "y": py, "id": tid, "radiusX": 1, "radiusY": 1, "force": 1}

        if action == "tap":
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchStart", "touchPoints": [_tp(x, y)],
            }, session_id=sid)
            time.sleep(0.05)
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchEnd", "touchPoints": [],
            }, session_id=sid)
            return {"success": True, "output": f"Tapped at ({x:.0f}, {y:.0f})"}

        elif action == "swipe":
            end_x = float(args.get("end_x", x))
            end_y = float(args.get("end_y", y))
            steps = 10
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchStart", "touchPoints": [_tp(x, y)],
            }, session_id=sid)
            for i in range(1, steps + 1):
                mx = x + (end_x - x) * i / steps
                my = y + (end_y - y) * i / steps
                cdp.send("Input.dispatchTouchEvent", {
                    "type": "touchMove", "touchPoints": [_tp(mx, my)],
                }, session_id=sid)
                time.sleep(0.02)
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchEnd", "touchPoints": [],
            }, session_id=sid)
            return {"success": True, "output": f"Swiped from ({x:.0f}, {y:.0f}) to ({end_x:.0f}, {end_y:.0f})"}

        elif action == "long-press":
            duration = float(args.get("duration", 500)) / 1000.0
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchStart", "touchPoints": [_tp(x, y)],
            }, session_id=sid)
            time.sleep(duration)
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchEnd", "touchPoints": [],
            }, session_id=sid)
            return {"success": True, "output": f"Long-pressed at ({x:.0f}, {y:.0f}) for {duration:.2f}s"}

        elif action == "pinch":
            scale = float(args.get("scale", 1.0))
            steps = 10
            # Two touch points starting near center
            offset = 50.0
            for i in range(steps + 1):
                t = i / float(steps)
                if scale > 1.0:
                    cur_offset = offset + (offset * (scale - 1.0)) * t
                else:
                    cur_offset = offset - (offset * (1.0 - scale)) * t
                p1 = _tp(x - cur_offset, y, 0)
                p2 = _tp(x + cur_offset, y, 1)
                if i == 0:
                    cdp.send("Input.dispatchTouchEvent", {
                        "type": "touchStart", "touchPoints": [p1, p2],
                    }, session_id=sid)
                else:
                    cdp.send("Input.dispatchTouchEvent", {
                        "type": "touchMove", "touchPoints": [p1, p2],
                    }, session_id=sid)
                time.sleep(0.02)
            cdp.send("Input.dispatchTouchEvent", {
                "type": "touchEnd", "touchPoints": [],
            }, session_id=sid)
            return {"success": True, "output": f"Pinch at ({x:.0f}, {y:.0f}) with scale {scale}"}

        else:
            return {"success": False, "output": "", "error": f"Unknown touch action: {action}"}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


def handle_browser_frames(args):  # type: (Dict) -> Dict
    if not chrome_manager or not chrome_manager.cdp:
        return {"success": False, "output": "", "error": "Browser not running"}
    try:
        tree = chrome_manager.cdp.send("Page.getFrameTree", session_id=chrome_manager.session)
        def flatten(node, depth=0):
            frames = []
            f = node.get("frame", {})
            frames.append({"id": f.get("id"), "url": f.get("url", ""), "name": f.get("name", ""), "depth": depth})
            for child in node.get("childFrames", []):
                frames.extend(flatten(child, depth + 1))
            return frames
        result = flatten(tree.get("frameTree", {}))
        return {"success": True, "output": json.dumps(result)}
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}


BROWSER_TOOL_SCHEMAS = [
    {"name": "browser_status", "description": "Get current browser page URL and title", "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "browser_navigate", "description": "Navigate to a URL", "inputSchema": {"type": "object", "properties": {"url": {"type": "string", "description": "URL to navigate to"}}, "required": ["url"]}},
    {"name": "browser_screenshot", "description": "Take a screenshot of the page or element", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string", "description": "CSS selector of element"}, "quality": {"type": "number", "description": "JPEG quality (default: 80)"}}, "required": []}},
    {"name": "browser_click", "description": "Click an element or coordinates", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string", "description": "CSS selector"}, "x": {"type": "number"}, "y": {"type": "number"}, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "double": {"type": "boolean"}}, "required": []}},
    {"name": "browser_type", "description": "Type text into an element", "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "description": "Text to type"}, "selector": {"type": "string", "description": "CSS selector"}, "clear": {"type": "boolean"}, "submit": {"type": "boolean"}}, "required": ["text"]}},
    {"name": "browser_extract", "description": "Extract content from the page", "inputSchema": {"type": "object", "properties": {"mode": {"type": "string", "enum": ["text", "html", "links", "forms", "tables", "accessibility"]}, "selector": {"type": "string"}}, "required": []}},
    {"name": "browser_tabs", "description": "Manage browser tabs", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "new", "close", "switch"]}, "url": {"type": "string"}, "targetId": {"type": "string"}}, "required": []}},
    {"name": "browser_execute", "description": "Execute JavaScript in page context", "inputSchema": {"type": "object", "properties": {"code": {"type": "string", "description": "JavaScript code"}, "script_id": {"type": "string", "description": "Key of a stored script (saved via browser_store)"}, "script_args": {"type": "object", "description": "Arguments passed to stored script as __args"}}, "required": []}},
    {"name": "browser_scroll", "description": "Scroll the page or element", "inputSchema": {"type": "object", "properties": {"direction": {"type": "string", "enum": ["up", "down", "left", "right"]}, "amount": {"type": "number"}, "selector": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}, "required": []}},
    {"name": "browser_keypress", "description": "Press a keyboard key with optional modifiers", "inputSchema": {"type": "object", "properties": {"key": {"type": "string", "description": "Key to press"}, "modifiers": {"type": "array", "items": {"type": "string"}}}, "required": ["key"]}},
    {"name": "browser_wait_for", "description": "Wait for element to appear", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "timeout": {"type": "number"}, "visible": {"type": "boolean"}}, "required": ["selector"]}},
    {"name": "browser_select", "description": "Select dropdown option", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "value": {"type": "string"}, "text": {"type": "string"}, "index": {"type": "number"}}, "required": ["selector"]}},
    {"name": "browser_hover", "description": "Hover over an element", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}, "required": []}},
    {"name": "browser_history", "description": "Navigate browser history", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["back", "forward"]}}, "required": ["action"]}},
    {"name": "browser_handle_dialog", "description": "Handle JavaScript dialog", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["accept", "dismiss"]}, "prompt_text": {"type": "string"}}, "required": []}},
    {"name": "browser_frames", "description": "List all frames in the page", "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "browser_mouse_move", "description": "Move the mouse cursor to a specific position", "inputSchema": {"type": "object", "properties": {"x": {"type": "number", "description": "Target X coordinate"}, "y": {"type": "number", "description": "Target Y coordinate"}, "steps": {"type": "number", "description": "Number of intermediate steps (default: 1)"}, "from_x": {"type": "number", "description": "Start X coordinate"}, "from_y": {"type": "number", "description": "Start Y coordinate"}}, "required": ["x", "y"]}},
    {"name": "browser_drag", "description": "Drag from one element/position to another (drag-and-drop)", "inputSchema": {"type": "object", "properties": {"from_selector": {"type": "string", "description": "CSS selector of element to drag from"}, "from_x": {"type": "number", "description": "Start X coordinate"}, "from_y": {"type": "number", "description": "Start Y coordinate"}, "to_selector": {"type": "string", "description": "CSS selector of drop target"}, "to_x": {"type": "number", "description": "End X coordinate"}, "to_y": {"type": "number", "description": "End Y coordinate"}, "steps": {"type": "number", "description": "Number of intermediate move steps (default: 10)"}}, "required": []}},
    {"name": "browser_touch", "description": "Perform touch gestures (tap, swipe, long-press, pinch)", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["tap", "swipe", "long-press", "pinch"], "description": "Touch action type"}, "selector": {"type": "string", "description": "CSS selector of target element"}, "x": {"type": "number", "description": "Start X coordinate"}, "y": {"type": "number", "description": "Start Y coordinate"}, "end_x": {"type": "number", "description": "End X for swipe"}, "end_y": {"type": "number", "description": "End Y for swipe"}, "scale": {"type": "number", "description": "Scale factor for pinch (0.5=zoom out, 2.0=zoom in)"}, "duration": {"type": "number", "description": "Hold duration in ms for long-press (default: 500)"}}, "required": []}},
    {"name": "browser_upload", "description": "Upload files to a file input element on the page", "inputSchema": {"type": "object", "properties": {"selector": {"type": "string", "description": "CSS selector of the <input type='file'> element"}, "files": {"type": "array", "items": {"type": "string"}, "description": "Array of absolute file paths on the local machine"}, "file_ids": {"type": "array", "items": {"type": "string"}, "description": "Array of chat server file IDs to download and upload"}}, "required": ["selector"]}},
    {"name": "browser_download", "description": "Manage file downloads: configure download directory, wait for downloads, or list tracked downloads", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["configure", "wait", "list"], "description": "Action to perform"}, "path": {"type": "string", "description": "Download directory path (for 'configure' action)"}, "timeout": {"type": "number", "description": "Max wait time in milliseconds (for 'wait' action, default: 30000)"}, "upload": {"type": "boolean", "description": "Upload completed download to chat server (for 'wait' action)"}}, "required": []}},
    {"name": "browser_auth", "description": "Handle HTTP Basic/Digest authentication",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["status", "provide", "cancel"]},
         "username": {"type": "string"},
         "password": {"type": "string"},
     }, "required": ["action"]}},
    {"name": "browser_permissions", "description": "Grant, deny, or reset browser permissions for a site",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["grant", "deny", "reset"]},
         "permissions": {"type": "array", "items": {"type": "string"}, "description": "Permission names: geolocation, camera, microphone, notifications, clipboard-read, clipboard-write, midi, background-sync, sensors, screen-wake-lock"},
         "origin": {"type": "string", "description": "Origin to apply permissions to"},
     }, "required": ["action"]}},
    {"name": "browser_store", "description": "Store and retrieve reusable scripts",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["set", "get", "list", "delete", "clear"]},
         "key": {"type": "string"},
         "value": {"type": "string"},
         "description": {"type": "string"},
     }, "required": ["action"]}},
]


def _dispatch_browser_tool(tool, args):  # type: (str, Dict) -> Dict
    try:
        ensure_browser()
    except Exception as e:
        return {"success": False, "output": "", "error": str(e)}
    handlers = {
        "browser_status": handle_browser_status,
        "browser_navigate": handle_browser_navigate,
        "browser_screenshot": handle_browser_screenshot,
        "browser_click": handle_browser_click,
        "browser_type": handle_browser_type,
        "browser_extract": handle_browser_extract,
        "browser_tabs": handle_browser_tabs,
        "browser_execute": handle_browser_execute,
        "browser_scroll": handle_browser_scroll,
        "browser_keypress": handle_browser_keypress,
        "browser_wait_for": handle_browser_wait_for,
        "browser_select": handle_browser_select,
        "browser_hover": handle_browser_hover,
        "browser_history": handle_browser_history,
        "browser_handle_dialog": handle_browser_dialog,
        "browser_frames": handle_browser_frames,
        "browser_mouse_move": handle_browser_mouse_move,
        "browser_drag": handle_browser_drag,
        "browser_touch": handle_browser_touch,
        "browser_upload": handle_browser_upload,
        "browser_download": handle_browser_download,
        "browser_auth": handle_browser_auth,
        "browser_permissions": handle_browser_permissions,
        "browser_store": handle_browser_store,
    }
    handler = handlers.get(tool)
    if handler:
        return handler(args)
    return {"success": False, "output": "", "error": f"Unknown browser tool: {tool}"}


# ---------------------------------------------------------------------------
# Tool schemas — MCP-style definitions
# ---------------------------------------------------------------------------

TOOL_SCHEMAS = [
    {
        "name": "view",
        "description": "View file contents with line numbers, or list directory entries.",
        "inputSchema": {
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to file or directory",
                },
                "view_range": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Optional [start_line, end_line] range (1-indexed). Use -1 for end_line to read to EOF.",
                },
            },
        },
    },
    {
        "name": "edit",
        "description": "Replace exactly one occurrence of old_str with new_str in a file.",
        "inputSchema": {
            "type": "object",
            "required": ["path", "old_str", "new_str"],
            "properties": {
                "path": {"type": "string", "description": "Absolute path to file"},
                "old_str": {
                    "type": "string",
                    "description": "Exact string to find (must match exactly one location)",
                },
                "new_str": {
                    "type": "string",
                    "description": "Replacement string",
                },
            },
        },
    },
    {
        "name": "create",
        "description": "Create a new file with the given content. Fails if file already exists.",
        "inputSchema": {
            "type": "object",
            "required": ["path", "file_text"],
            "properties": {
                "path": {"type": "string", "description": "Absolute path for the new file"},
                "file_text": {"type": "string", "description": "Content of the new file"},
            },
        },
    },
    {
        "name": "grep",
        "description": "Search file contents using ripgrep (rg) with grep fallback.",
        "inputSchema": {
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "File or directory to search in"},
                "glob": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g. '*.ts')",
                },
                "-i": {"type": "boolean", "description": "Case insensitive search"},
                "-n": {"type": "boolean", "description": "Show line numbers"},
                "-A": {"type": "number", "description": "Lines of context after match"},
                "-B": {"type": "number", "description": "Lines of context before match"},
                "-C": {"type": "number", "description": "Lines of context before and after match"},
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": "Output format",
                },
                "head_limit": {"type": "number", "description": "Limit results"},
            },
        },
    },
    {
        "name": "glob",
        "description": "Find files by name pattern using glob matching.",
        "inputSchema": {
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (e.g. '**/*.py', 'src/**/*.ts')",
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (defaults to project root)",
                },
            },
        },
    },
    {
        "name": "bash",
        "description": "Run a shell command and return output.",
        "inputSchema": {
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "description": {
                    "type": "string",
                    "description": "Short description of the command",
                },
                "timeout": {
                    "type": "number",
                    "description": "Timeout in seconds (default 120)",
                },
                "cwd": {
                    "type": "string",
                    "description": "Working directory (defaults to project root)",
                },
            },
        },
    },
]


# ---------------------------------------------------------------------------
# RemoteWorker
# ---------------------------------------------------------------------------

class RemoteWorker:
    """Manages the WebSocket connection to the Claw'd server and dispatches
    tool calls to handler functions."""

    def __init__(self, config):
        # type: (Any) -> None
        global _worker_config
        self.config = config
        _worker_config = config
        self.ws = None  # type: Optional[StdlibWebSocket]
        self.session_id = str(uuid.uuid4())
        self.reconnect_delay = 1.0
        self.last_pong = time.time()
        self.running = True
        self._heartbeat_thread = None  # type: Optional[threading.Thread]
        self._heartbeat_stop = threading.Event()
        self._call_semaphore = threading.Semaphore(config.max_concurrent)

    def connect(self):  # type: () -> None
        server = self.config.server.rstrip("/")
        name_encoded = urllib.parse.quote(self.config.name)
        url = f"{server}/worker/ws?name={name_encoded}"
        headers = {"Authorization": f"Bearer {self.config.token}"}
        # Cloudflare Access service token
        cf_id = getattr(self.config, "cf_client_id", None)
        cf_secret = getattr(self.config, "cf_client_secret", None)
        if cf_id and cf_secret:
            headers["CF-Access-Client-Id"] = cf_id
            headers["CF-Access-Client-Secret"] = cf_secret
        self.ws = StdlibWebSocket(
            url, headers=headers, ssl_context=self.config.ssl_context
        )
        self.ws.connect()
        log(f"Connected to {server}")
        self.reconnect_delay = 1.0
        self.last_pong = time.time()
        self._register()
        self._stop_heartbeat()
        self._start_heartbeat()

    def _register(self):  # type: () -> None
        self._send_json({
            "type": "register",
            "name": self.config.name,
            "projectRoot": self.config.project_root,
            "platform": sys.platform,
            "sessionId": self.session_id,
            "maxConcurrent": self.config.max_concurrent,
            "tools": TOOL_SCHEMAS + (BROWSER_TOOL_SCHEMAS if self.config.browser is not None else []),
            "version": "0.1.0",
        })

    def _send_json(self, data):  # type: (Dict[str, Any]) -> None
        if self.ws and not self.ws._closed:
            try:
                self.ws.send(json.dumps(data))
            except (OSError, ConnectionError):
                pass

    def message_loop(self):  # type: () -> None
        while self.running:
            try:
                msg = self.ws.recv()
                if msg is None:
                    log("Connection closed by server")
                    break
                self._handle_message(json.loads(msg))
            except socket.timeout:
                log("Read timeout, reconnecting...")
                break
            except (ConnectionError, OSError) as exc:
                log(f"Connection error: {exc}")
                break
            except json.JSONDecodeError as exc:
                log(f"Invalid JSON from server: {exc}")
                continue

    def _handle_message(self, msg):  # type: (Dict[str, Any]) -> None
        msg_type = msg.get("type")
        if msg_type == "registered":
            log(f"Registered: ok={msg.get('ok')}")
        elif msg_type == "call":
            t = threading.Thread(
                target=self._handle_tool_call, args=(msg,), daemon=True
            )
            t.start()
        elif msg_type == "cancel":
            self._handle_cancel(msg.get("id"))
        elif msg_type == "pong":
            self.last_pong = time.time()
        elif msg_type == "ping":
            # Server-initiated ping — respond with pong
            self._send_json({"type": "pong", "ts": msg.get("ts")})
        elif msg_type == "shutdown":
            log(f"Server shutdown: {msg.get('reason')}")
            self._shutdown()
        else:
            log(f"Unknown message type: {msg_type}")

    def _handle_tool_call(self, msg):  # type: (Dict[str, Any]) -> None
        if not self._call_semaphore.acquire(timeout=60):
            self._send_json({"type": "error", "id": msg.get("id", ""), "error": "Too many concurrent calls"})
            return
        try:
            self._handle_tool_call_inner(msg)
        finally:
            self._call_semaphore.release()

    def _handle_tool_call_inner(self, msg):  # type: (Dict[str, Any]) -> None
        call_id = msg.get("id", "")
        tool = msg.get("tool", "")
        args = msg.get("args", {})
        log(f"Tool call: {tool} (id={call_id})")
        try:
            result = None  # type: Optional[Dict[str, Any]]
            if tool == "view":
                result = handle_view(args, self.config.project_root)
            elif tool == "edit":
                result = handle_edit(args, self.config.project_root, self.config.read_only)
            elif tool == "create":
                result = handle_create(args, self.config.project_root, self.config.read_only)
            elif tool == "grep":
                result = handle_grep(args, self.config.project_root)
            elif tool == "glob":
                result = handle_glob(args, self.config.project_root)
            elif tool == "bash":
                result = handle_bash(
                    call_id, args, self.config.project_root,
                    self.config.read_only, self._send_json,
                )
            elif tool.startswith("browser_"):
                result = _dispatch_browser_tool(tool, args)
            else:
                result = {"success": False, "output": "", "error": f"Unknown tool: {tool}"}
            self._send_json({"type": "result", "id": call_id, "result": result})
        except Exception as exc:
            log(f"Tool call error ({tool}): {exc}")
            self._send_json({"type": "error", "id": call_id, "error": str(exc)})

    def _handle_cancel(self, call_id):  # type: (Optional[str]) -> None
        if not call_id:
            return
        proc = active_processes.pop(call_id, None)
        if proc and proc.pid:
            log(f"Cancelling process for {call_id} (pid={proc.pid})")
            kill_process_tree(proc.pid)
        self._send_json({"type": "cancelled", "id": call_id})

    def _start_heartbeat(self):  # type: () -> None
        self._heartbeat_stop.clear()

        def heartbeat():
            # type: () -> None
            while not self._heartbeat_stop.is_set():
                self._send_json({"type": "ping", "ts": int(time.time() * 1000)})
                self._heartbeat_stop.wait(30)
                if self._heartbeat_stop.is_set():
                    break
                if time.time() - self.last_pong > 60:
                    log("No pong received in 60s, closing connection")
                    try:
                        self.ws.close()
                    except Exception:
                        pass
                    break

        self._heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        self._heartbeat_thread.start()

    def _stop_heartbeat(self):  # type: () -> None
        self._heartbeat_stop.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=5)
            self._heartbeat_thread = None

    def reconnect(self):  # type: () -> None
        self._stop_heartbeat()
        while self.running:
            delay = min(self.reconnect_delay, self.config.reconnect_max)
            log(f"Reconnecting in {delay:.0f}s...")
            time.sleep(delay)
            self.reconnect_delay = min(self.reconnect_delay * 2, self.config.reconnect_max)
            try:
                self.connect()
                return
            except (ConnectionError, OSError, ssl.SSLError) as exc:
                log(f"Reconnect failed: {exc}")
            except Exception as exc:
                log(f"Unexpected reconnect error: {exc}")

    def run(self):  # type: () -> None
        """Top-level iterative loop: connect → message_loop → reconnect."""
        self.connect()
        while self.running:
            self.message_loop()
            if self.running:
                self.reconnect()

    def _shutdown(self):  # type: () -> None
        self.running = False
        for pid_key in list(active_processes):
            proc = active_processes.pop(pid_key, None)
            if proc and proc.pid:
                kill_process_tree(proc.pid)
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        global chrome_manager
        if chrome_manager:
            chrome_manager.shutdown()
            chrome_manager = None
        sys.exit(0)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def normalize_server_url(raw):  # type: (str) -> str
    """Normalize bare domain/host:port into a full WebSocket URL."""
    url = raw.strip().rstrip("/")
    # Strip trailing path if user included it
    if url.endswith("/worker/ws"):
        url = url[: -len("/worker/ws")]
    # Add scheme if missing
    if not re.match(r"^wss?://", url, re.IGNORECASE):
        if re.match(r"^https?://", url, re.IGNORECASE):
            url = re.sub(r"^http:", "ws:", url, flags=re.IGNORECASE)
            url = re.sub(r"^https:", "wss:", url, flags=re.IGNORECASE)
        else:
            is_local = bool(re.match(r"^(localhost|127\.|0\.0\.0\.|::1|\[::1\])(:|$)", url, re.IGNORECASE))
            url = ("ws://" if is_local else "wss://") + url
    return url


def main():  # type: () -> None
    parser = argparse.ArgumentParser(
        description="Claw'd Remote Worker — connect to a Claw'd server and execute file tools remotely",
    )
    parser.add_argument("--server", required=True, help="Claw'd server (e.g. clawd.example.com or localhost:3456)")
    parser.add_argument(
        "--token",
        default=os.environ.get("CLAWD_WORKER_TOKEN"),
        help="Auth token (or set CLAWD_WORKER_TOKEN env var)",
    )
    parser.add_argument(
        "--project-root",
        default=os.getcwd(),
        help="Project root directory (default: cwd)",
    )
    parser.add_argument(
        "--name",
        default=platform.node(),
        help="Worker name (default: hostname)",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="Reject write operations (edit, create)",
    )
    parser.add_argument(
        "--reconnect-max",
        type=float,
        default=300,
        help="Max reconnect delay in seconds (default: 300)",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification (NOT for production)",
    )
    parser.add_argument("--ca-cert", help="Path to custom CA certificate file")
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=4,
        help="Max concurrent tool calls (default: 4)",
    )
    parser.add_argument(
        "--cf-client-id",
        default=os.environ.get("CF_ACCESS_CLIENT_ID"),
        help="Cloudflare Access service token client ID (or set CF_ACCESS_CLIENT_ID)",
    )
    parser.add_argument(
        "--cf-client-secret",
        default=os.environ.get("CF_ACCESS_CLIENT_SECRET"),
        help="Cloudflare Access service token secret (or set CF_ACCESS_CLIENT_SECRET)",
    )
    parser.add_argument(
        "--browser",
        nargs="?",
        const="",
        default=None,
        help="Enable browser control via CDP. Optional profile name (default: temp profile)",
    )

    args = parser.parse_args()

    if not args.token:
        parser.error("--token or CLAWD_WORKER_TOKEN env var required")

    # SSL context
    ssl_ctx = None  # type: Optional[ssl.SSLContext]
    if args.insecure:
        log("\u26a0\ufe0f  TLS verification DISABLED \u2014 NOT for production!")
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
    elif args.ca_cert:
        ssl_ctx = ssl.create_default_context(cafile=args.ca_cert)

    server_url = normalize_server_url(args.server)

    # Startup diagnostics
    log(f"Platform: {sys.platform} ({platform.machine()})")
    log(f"Python: {sys.version.split()[0]}")
    if IS_WSL2:
        log("Running inside WSL2")
    if IS_MACOS:
        log("macOS (case-insensitive comparison active)")
    if args.cf_client_id:
        log("Cloudflare Access service token configured")
    project_root = args.project_root
    # Convert MSYS/Git Bash paths like /d/foo → D:\foo on Windows
    if IS_WINDOWS:
        import re as _re
        m = _re.match(r'^/([a-zA-Z])(/.*)?$', project_root)
        if m:
            project_root = m.group(1).upper() + ":" + (m.group(2) or "\\")
    project_root = os.path.realpath(project_root)
    log(f"Project root: {project_root}")
    log(f"Server: {server_url}")
    if args.read_only:
        log("Read-only mode enabled")

    config = type("Config", (), {
        "server": server_url,
        "token": args.token,
        "project_root": project_root,
        "name": args.name,
        "read_only": args.read_only,
        "reconnect_max": args.reconnect_max,
        "ssl_context": ssl_ctx,
        "max_concurrent": args.max_concurrent,
        "cf_client_id": args.cf_client_id,
        "cf_client_secret": args.cf_client_secret,
        "browser": args.browser,
    })()

    # Browser startup
    if config.browser is not None:
        mgr = start_chrome_manager(config.browser)
        if mgr:
            log(f"Browser enabled (CDP port {mgr.cdp_port})")
        else:
            log("WARNING: Browser requested but Chrome not found")
            config.browser = None

    worker = RemoteWorker(config)

    def sigint_handler(signum, frame):
        # type: (int, Any) -> None
        log("Shutting down...")
        worker._shutdown()

    signal.signal(signal.SIGINT, sigint_handler)
    if not IS_WINDOWS:
        signal.signal(signal.SIGTERM, sigint_handler)

    try:
        worker.run()
    except KeyboardInterrupt:
        worker._shutdown()
    except Exception as exc:
        log(f"Fatal error: {exc}")
        worker._shutdown()


if __name__ == "__main__":
    main()
