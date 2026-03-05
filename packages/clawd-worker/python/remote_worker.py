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
        handshake_lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
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
            raise ConnectionError(
                f"WebSocket upgrade failed: {response.split(b'\r\n')[0].decode(errors='replace')}"
            )

        # Validate Sec-WebSocket-Accept
        expected_accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-5AB5AFA5E30B").encode()
            ).digest()
        ).decode()
        for line in response.split(b"\r\n"):
            if line.lower().startswith(b"sec-websocket-accept:"):
                got = line.split(b":", 1)[1].strip().decode()
                if got != expected_accept:
                    self.sock.close()
                    raise ConnectionError("Sec-WebSocket-Accept mismatch")
                break

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
        # Allow read-only commands in read-only mode by checking for mutating patterns
        # For now, just warn — we trust the server-side to enforce this too.
        pass

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
        self.config = config
        self.ws = None  # type: Optional[StdlibWebSocket]
        self.session_id = str(uuid.uuid4())
        self.reconnect_delay = 1.0
        self.last_pong = time.time()
        self.running = True
        self._heartbeat_thread = None  # type: Optional[threading.Thread]
        self._heartbeat_stop = threading.Event()

    def connect(self):  # type: () -> None
        server = self.config.server.rstrip("/")
        name_encoded = urllib.parse.quote(self.config.name)
        url = f"{server}/ws/remote-worker?name={name_encoded}"
        headers = {"Authorization": f"Bearer {self.config.token}"}
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
            "tools": TOOL_SCHEMAS,
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
        sys.exit(0)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():  # type: () -> None
    parser = argparse.ArgumentParser(
        description="Claw'd Remote Worker — connect to a Claw'd server and execute file tools remotely",
    )
    parser.add_argument("--server", required=True, help="Claw'd server URL (ws:// or wss://)")
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

    # Startup diagnostics
    log(f"Platform: {sys.platform} ({platform.machine()})")
    if IS_WSL2:
        log("Running inside WSL2")
    if IS_MACOS:
        log("macOS (case-insensitive comparison active)")
    project_root = os.path.realpath(args.project_root)
    log(f"Project root: {project_root}")
    log(f"Server: {args.server}")
    if args.read_only:
        log("Read-only mode enabled")

    config = type("Config", (), {
        "server": args.server,
        "token": args.token,
        "project_root": project_root,
        "name": args.name,
        "read_only": args.read_only,
        "reconnect_max": args.reconnect_max,
        "ssl_context": ssl_ctx,
        "max_concurrent": args.max_concurrent,
    })()

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
