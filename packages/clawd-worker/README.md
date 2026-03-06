# Claw'd Remote Worker

Run a remote worker on any machine to let Claw'd agents execute file tools (`view`, `edit`, `create`, `grep`, `glob`, `bash`) there via a WebSocket reverse tunnel.

Two implementations:
- **TypeScript** — for environments with Bun or Node.js 22.4+
- **Python** — zero-dependency stdlib-only, for restricted/VDI environments (Python 3.8+)

Both speak the same protocol and offer identical functionality.

## Quick Start

### TypeScript

```bash
# Using Bun (recommended)
CLAWD_WORKER_TOKEN=your-token bun packages/clawd-worker/typescript/remote-worker.ts \
  --server wss://your-clawd-server.example.com

# Using Node.js 22.4+ (with tsx)
CLAWD_WORKER_TOKEN=your-token npx tsx packages/clawd-worker/typescript/remote-worker.ts \
  --server wss://your-clawd-server.example.com
```

### Python

```bash
CLAWD_WORKER_TOKEN=your-token python3 packages/clawd-worker/python/remote_worker.py \
  --server wss://your-clawd-server.example.com
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--server <url>` | (required) | Claw'd server WebSocket URL |
| `--token <token>` | `$CLAWD_WORKER_TOKEN` | Authentication token |
| `--project-root <path>` | cwd | Root directory for file operations |
| `--name <name>` | hostname | Worker display name |
| `--read-only` | false | Disable `edit`, `create`, `bash` tools |
| `--timeout <ms>` | 30000 | Default tool timeout (bash uses 300s) |
| `--max-concurrent <n>` | 4 | Max parallel tool calls |
| `--reconnect-max <s>` | 300 | Max reconnect backoff delay |
| `--insecure` | false | Disable TLS certificate verification (dev only) |
| `--ca-cert <path>` | — | Custom CA certificate file |

**Token precedence**: `--token` flag > `CLAWD_WORKER_TOKEN` env var.

Use env var for tokens — CLI arguments are visible in `ps aux`.

## Server Configuration

Add `worker` to `~/.clawd/config.json`:

```json
{
  "worker": true
}
```

Or for channel-specific tokens:

```json
{
  "worker": {
    "dev-team": ["wkr_abc123", "wkr_def456"],
    "staging": ["wkr_staging_789"]
  }
}
```

- `true` — accept any non-empty token on all channels
- `{ channel: [tokens] }` — only listed tokens accepted per channel

Config changes are hot-reloaded within 5 seconds.

## Agent ↔ Worker Binding

In the Agents dialog, set the **Worker** field to the same token the worker uses. The agent will then execute file tools on that remote worker instead of locally.

## Platform Notes

### Windows

- Requires Git for Windows (for bash shell) or falls back to PowerShell/cmd.exe
- Path validation is case-insensitive (NTFS)
- Windows reserved filenames (CON, NUL, PRN, etc.) are blocked
- Process tree kill uses `taskkill /PID /T /F`

### macOS

- Path validation is case-insensitive (APFS default)
- `/tmp` resolves to `/private/tmp` automatically
- Low `ulimit` warning at startup — run `ulimit -n 10240` for better performance
- If SSL fails: run `/Applications/Python 3.x/Install Certificates.command`

### WSL2

- Detected via `/proc/version` containing "microsoft"
- DrvFs paths (`/mnt/c/...`) use case-insensitive comparison
- `chmod` is a no-op on DrvFs — use native Linux paths when possible
- Connect to `wss://localhost:PORT` (WSL2 shares host network)

### Corporate / VDI

- Python worker is preferred — `.py` files are rarely blocked by AppLocker
- Use `--ca-cert` for corporate proxy CAs, or set `SSL_CERT_FILE` env var
- For Node.js: set `NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem`
- `--insecure` disables TLS verification (development only, prints loud warning)

## Security

- All file paths validated against project root (symlink-resolved)
- Sensitive files blocked: `.env*`, `.pem`, `.key`, SSH keys, credentials
- Bash commands screened for `.env` access patterns
- Output secrets redacted (API keys, tokens, private keys)
- Output truncated at 50KB
- Subprocess output decoded with `errors="replace"` (no crashes on binary)
- Token transmitted via `Authorization` header (not query string)

## Running as a Service

### systemd (Linux)

```ini
[Unit]
Description=Clawd Remote Worker
After=network.target

[Service]
Type=simple
User=deploy
Environment=CLAWD_WORKER_TOKEN=your-token
ExecStart=/usr/bin/python3 /opt/clawd-worker/remote_worker.py --server wss://clawd.example.com --project-root /home/deploy/project
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### launchd (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clawd.remote-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/opt/clawd-worker/remote_worker.py</string>
    <string>--server</string>
    <string>wss://clawd.example.com</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAWD_WORKER_TOKEN</key>
    <string>your-token</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```
