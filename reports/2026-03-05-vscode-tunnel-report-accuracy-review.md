# Accuracy Review: VS Code Remote Tunnel Research Report

**Date:** 2026-03-05
**Reviewed:** `vscode-remote-tunnel-research.md`
**Methodology:** Claims verified against official Microsoft docs, source code on GitHub, and live URL testing

---

## Issues Found

### 🔴 CRITICAL #1 — "Completely independent of SSH" is factually wrong

**Report claim (§1, §2):** "All communication uses HTTPS/WebSockets, NOT SSH" and "completely independent of SSH."

**Reality:** The official VS Code documentation explicitly states:

> "Once you connect from a remote VS Code instance, **an SSH connection is created over the tunnel** in order to provide end-to-end encryption. The current preferred cipher for this encryption is AES 256 in CTR mode."
> — [VS Code Tunnel Docs](https://code.visualstudio.com/docs/remote/tunnels)

DeepWiki and Red Siege also confirm: *"Connection security is enforced through SSH protocol implementation that runs over WebSocket transport."*

**What's actually happening:** The transport is HTTPS/WebSocket, but SSH protocol runs *inside* the tunnel for E2E encryption. The CLI doesn't require an external OpenSSH installation (it bundles its own SSH implementation), but saying it's "completely independent of SSH" is wrong — SSH is a core protocol component.

**Fix:** Say "No external OpenSSH client/server required" instead of "not SSH protocol." Acknowledge that SSH is used internally over WebSocket for E2E encryption.

---

### 🔴 CRITICAL #2 — Linux x64 download URL returns 404

**Report claim (§3, §4):** `https://code.visualstudio.com/sha/download?build=stable&os=cli-linux-x64`

**Reality:** Live test returns **HTTP 404**. The working alternative is:
```
https://update.code.visualstudio.com/latest/cli-linux-x64/stable
```

All other URLs in the table (win32, darwin, alpine) work via `sha/download`. Only `cli-linux-x64` is broken on that endpoint. The `update.code.visualstudio.com` endpoint works for all platforms.

**Verified downloads (working):**
| Platform | Working URL |
|---|---|
| Windows x64 | `sha/download?build=stable&os=cli-win32-x64` ✅ (302) |
| macOS x64 | `sha/download?build=stable&os=cli-darwin-x64` ✅ (302) |
| macOS ARM64 | `sha/download?build=stable&os=cli-darwin-arm64` ✅ (302) |
| **Linux x64** | **`sha/download?build=stable&os=cli-linux-x64` ❌ (404)** |
| Linux ARM64 | `sha/download?build=stable&os=cli-linux-arm64` — not tested |
| Alpine x64 | `sha/download?build=stable&os=cli-alpine-x64` ✅ (302) |

**Fix:** Use `https://update.code.visualstudio.com/latest/cli-linux-x64/stable` for Linux x64, or use the `update` API for all platforms for consistency.

---

### 🔴 CRITICAL #3 — "Enterprise: 10 tunnels, 5 GB bandwidth" is wrong; these are UNIVERSAL limits

**Report claim (§6):** Presents 10 tunnels / 5 GB bandwidth as "Enterprise Account" limits, sourced from InfoWorld.

**Reality:** The official Microsoft documentation ([azure-docs/dev-tunnels-service-limits.md](https://github.com/MicrosoftDocs/azure-docs/blob/main/includes/dev-tunnels/dev-tunnels-service-limits.md)) states these limits apply to **ALL users** — no tiers mentioned:

| Resource | Limit |
|---|---|
| Bandwidth | **5 GB per user** |
| Tunnels | **10 per user** |
| Active connections | 1000 per port |
| Ports | 10 per tunnel |
| HTTP request rate | 1500/min per port |
| Data transfer rate | Up to 20 MB/s per tunnel |
| Max web-forwarding HTTP request body size | 16 MB |

The VS Code tunnel docs also confirm: *"right now you can have 10 tunnels registered for your account."*

The report's table says free accounts have "No hard public limit (soft 'fair use')" — this is wrong. Free/individual accounts have the SAME 10 tunnel / 5 GB limits. There are no separate tiers in the documentation.

**Fix:** Replace the entire limits table with the official limits. Remove the Free vs. Enterprise distinction, which is fabricated. Also remove the `Ctrl+Shift+P → "Show Usage Limits"` claim — this command doesn't appear in official docs.

---

### 🔴 CRITICAL #4 — "No native C/C++ libraries needed" is wrong for Linux (glibc)

**Report claim (§2):** "CLI is a self-contained binary with bundled runtime" / "Native C/C++ libraries: NO"

**Reality:** Binary analysis of the actual downloaded Linux x64 CLI (`code`) reveals:

```
code: ELF 64-bit LSB pie executable, x86-64, dynamically linked,
      interpreter /lib64/ld-linux-x86-64.so.2

NEEDED: libgcc_s.so.1, librt.so.1, libpthread.so.0, libm.so.6,
        libdl.so.2, libc.so.6, ld-linux-x86-64.so.2
```

The **Linux x64 binary dynamically links to glibc** (7 shared libraries). It WILL NOT run on Alpine Linux (musl libc) — hence the separate `cli-alpine-x64` build which IS statically linked.

The Alpine binary is truly self-contained (statically linked, no NEEDED libs). The Linux glibc binary is NOT.

**Fix:** Change to: "No additional native libraries beyond standard system libc (glibc). Alpine-specific build is fully static." Acknowledge glibc as a runtime dependency for the standard Linux build.

---

### 🟡 WARNING #1 — "AES-256 encrypted" is technically imprecise

**Report claim (§1, §7):** "Traffic is AES-256 encrypted" and "Encryption: AES-256 over HTTPS"

**Reality:** Two layers of encryption exist:
1. **TLS** (HTTPS transport) — TLS 1.2 minimum, TLS 1.3 preferred (per Microsoft security docs). Cipher negotiated by TLS, not necessarily AES-256.
2. **SSH E2E** — AES-256-CTR is the *preferred* cipher for the SSH connection inside the tunnel.

Saying "AES-256 over HTTPS" conflates these layers. The HTTPS layer uses whatever TLS cipher is negotiated. The E2E encryption inside the tunnel uses AES-256-CTR via SSH.

**Source:** VS Code docs: *"The current preferred cipher for this encryption is AES 256 in CTR mode"* — note "preferred," not guaranteed.

**Fix:** "Transport encrypted via TLS (HTTPS); end-to-end encrypted via SSH tunnel using AES-256-CTR (preferred cipher)."

---

### 🟡 WARNING #2 — "Only one tunnel per machine name" is misleading

**Report claim (§9.6):** "Single active tunnel: Only one tunnel per machine name is active at a time"

**Reality:** The official docs say you can have **10 tunnels per account**. The constraint is that the `code tunnel` CLI associates one tunnel with a machine name, and if you exceed 10, it auto-deletes a random unused one. But:
- Using `devtunnel` CLI, you can create multiple tunnels from the same machine
- The "one per machine name" constraint is a VS Code CLI convenience, not a fundamental limitation
- Multiple ports (up to 10) can be forwarded through a single tunnel

**Fix:** Clarify: "The `code tunnel` CLI registers one tunnel per machine name. Up to 10 tunnels per account; exceeding this auto-deletes a random unused one."

---

### 🟡 WARNING #3 — "No admin/root access needed" contradicts the report itself

**Report claim (§2 table):** "Admin/root access: **NO**" with note "(service install needs admin)"

**Reality:**
- **Linux:** Report shows `sudo ./code tunnel service install` — this IS root
- **macOS:** Known bug (GitHub issue #10675) — `launchctl` service install has issues even with proper permissions
- **Windows:** GitHub issue #167741 reveals service install requires username/password and has known reliability issues

Running the tunnel interactively doesn't need admin. But the report's own example contradicts the "NO" in the table.

**Fix:** Split into two rows: "Run interactively: No admin needed" and "Install as service: Requires admin/root (Linux sudo, Windows credentials, macOS launchd permissions)"

---

### 🟡 WARNING #4 — "Remote SSH: Often blocked" is editorialized

**Report claim (§8):** Comparison table says SSH is "Often blocked"

**Reality:** SSH (port 22) is blocked in *some* corporate/enterprise networks, not "often" in general. Many cloud providers, hosting companies, and organizations use SSH as a primary access method. The phrasing overstates the issue.

**Fix:** "Blocked in some corporate/restrictive networks" — more accurate and less editorialized.

---

### 🟢 MINOR #1 — Missing official limits that are now documented

The report misses several documented limits:
- **Active connections:** 1000 per port
- **Ports:** 10 per tunnel  
- **HTTP request rate:** 1500/min per port
- **Data transfer rate:** Up to 20 MB/s per tunnel
- **Max HTTP body size:** 16 MB
- **Limits reset monthly**

These are all from the official limits doc and are relevant for production planning.

---

### 🟢 MINOR #2 — `devtunnel` macOS install command is wrong

**Report claim (§5):** `brew install --cask devtunnel`

**Reality:** It's typically `brew install devtunnel` (formula, not cask). The `--cask` flag is for GUI applications. Should be verified against current Homebrew.

---

### 🟢 MINOR #3 — Security model section is incomplete

The security docs page reveals additional important details not mentioned:
- TLS termination happens at service ingress (Microsoft sees unencrypted HTTP at relay level before the SSH E2E kicks in for VS Code connections)
- Anti-phishing interstitial page exists for web-forwarded URLs
- Tunnel access tokens (4 types) exist for programmatic access
- Tunnels auto-expire after 30 days of inactivity

---

## Summary

| Severity | Count | Impact |
|----------|-------|--------|
| 🔴 Critical | 4 | Factual errors that would mislead implementation decisions or break setup |
| 🟡 Warning | 4 | Technically imprecise claims that could cause confusion |
| 🟢 Minor | 3 | Missing information and nitpicks |

**Most impactful finding:** The report's core thesis — "completely independent of SSH" — is contradicted by Microsoft's own documentation. SSH protocol IS used inside the tunnel for E2E encryption. The correct claim is "no external OpenSSH installation required."

**Second most impactful:** The usage limits table is fabricated (Free vs. Enterprise tiers don't exist in official docs). The actual limits (10 tunnels, 5GB bandwidth) apply to ALL users.

---

## Sources Used for Verification

1. [VS Code Official Tunnel Docs](https://code.visualstudio.com/docs/remote/tunnels) — confirmed AES-256-CTR via SSH, 10 tunnel limit
2. [Microsoft Dev Tunnels Service Limits](https://github.com/MicrosoftDocs/azure-docs/blob/main/includes/dev-tunnels/dev-tunnels-service-limits.md) — official universal limits
3. [Microsoft Dev Tunnels Security Docs](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security) — TLS details, access controls
4. [Microsoft Dev Tunnels Overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview) — architecture terminology
5. Live URL testing of all download endpoints — confirmed 404 for `cli-linux-x64` via `sha/download`
6. Binary analysis via `ldd`/`readelf` of actual downloaded CLI — confirmed glibc dynamic linking
7. [GitHub #167741](https://github.com/microsoft/vscode/issues/167741) — Windows service install issues
8. [GitHub #10675](https://github.com/microsoft/vscode-remote-release/issues/10675) — macOS service install bug
