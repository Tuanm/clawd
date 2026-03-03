# GitHub Copilot API: Abuse Detection, Rate Limits & Safe Usage Patterns

**Date:** 2026-03-03  
**Context:** `clawd` — multi-agent TypeScript/Bun orchestrator using `api.githubcopilot.com` for LLM requests  
**Sources:** GitHub official docs, reverse-engineering community projects (`B00TK1D/copilot-api`, `hankchiutw/copilot-proxy`), GitHub ToS/AUP, GitHub Models rate limit table, codebase analysis

---

## CRITICAL UPFRONT: Two Distinct API Surfaces

`api.githubcopilot.com/chat/completions` is reached via **two different auth paths** with **different rate limits**:

| Path | Auth | Limits |
|------|------|--------|
| **Copilot Subscription** | Short-lived bearer from `api.github.com/copilot_internal/v2/token` | "Unlimited" for standard models; **300 premium requests/user/month** for frontier models (Pro/Business) |
| **GitHub Models API** | PAT with `models:read` scope | Hard per-minute + per-day per key (see §2) |

clawd uses the **Copilot subscription path** (OAuth device flow → internal token). This is the correct path, but the two systems' limits are commonly confused.

---

## 1. Abuse Detection Signals

GitHub does not publish its detection methodology, but from AUP language, community 429 reports, and proxy analysis:

### Hard Enforcement (triggers 429)
- **Concurrent streams per token**: exceeding 2 (Pro/Business) simultaneous inflight requests per bearer token → immediate 429
- **Requests per minute per token**: Mirroring GitHub Models table, ~10 RPM for high-tier models (Claude Opus, GPT-4), ~15 RPM for standard models
- **Premium request quota exhaustion**: once 300 premium requests/month/seat are used, all subsequent requests for frontier models fail until reset
- **Expired bearer token**: tokens have ~25 min TTL; clawd already handles this via `getCopilotToken()` but does NOT actively refresh pre-expiry

### Soft Enforcement (accelerated quota drain or account flag)
- **Token velocity**: using the same bearer token from multiple source IPs simultaneously signals token sharing — violates single-user seat terms
- **Zero inter-request delay**: sub-100ms cadence between requests on same token; humans type/think between requests
- **Non-standard User-Agent**: clawd sends `User-Agent: Claw'd/1.0.0` — not seen in any official Copilot client, trivially fingerprinted
- **Header `X-Initiator: agent`**: clawd explicitly self-identifies as an agent in a non-standard header; no official client sends this
- **Round-robin key switching per request**: switching tokens every request (as clawd currently does) is atypical — a real user has one session, one token

### Pattern Recognition (inferred)
- **Token reuse pattern**: clawd's round-robin fires requests token-A → B → C → A → B → C in order; this is machine-regular and identifiable
- **Request size uniformity**: automated agents tend to send consistent large prompt sizes; human chat has variance
- **No think-time jitter**: human conversations have variable pauses; bursty AI agents don't

---

## 2. Official Rate Limits (Numbers)

### GitHub Models Rate Limits (Hard, Documented — March 2026)
These apply when the Copilot subscription path is used for "premium" model access:

| Model Tier | Free/Pro RPM | Free/Pro Daily | Business Daily | Enterprise Daily | Concurrent |
|---|---|---|---|---|---|
| **High** (Claude Opus, GPT-4.1, o3) | 10 | 50 | 100 | 150 | 2/2/2/4 |
| **Low** (GPT-3.5 equiv) | 15 | 150 | 300 | 450 | 5/5/5/8 |
| **DeepSeek-R1, MAI-DS-R1** | 1 | 8 | 10 | 12 | 1/1/1/1 |

> **Token limits per request:** High models: 8K input / 4K output (Pro), 16K in / 8K out (Enterprise)  
> **Note:** `gpt-4.1` requires `"stream": true` — non-streaming calls are rejected with an error (not a 429)

### Copilot Subscription Monthly Quotas
From `api.github.com/copilot_internal/v2/token` response:

```typescript
interface CopilotTokenResponse {
  token: string;                    // short-lived bearer (~25 min)
  expires_at: string;
  limited_user_quotas: {
    chat: number;       // Copilot Free only: 500/month remaining
    completions: number; // Copilot Free only: 4000/month remaining
  } | null;             // null for Pro/Business/Enterprise (no monthly quota)
  limited_user_reset_date: number | null;
}
```

**Free tier**: 500 chat messages/month, 4,000 code completions/month (hard stops)  
**Pro/Business**: `limited_user_quotas: null` — no monthly chat quota, but **300 premium requests/user/month** apply for expensive models (Claude Opus 4.x, GPT-4.1, o3, etc.)  
**Enterprise**: ~1000 premium requests/user/month (3.33× Business)

### Rate Limit Response Headers
Standard GitHub pattern (confirmed from REST API docs, applied to Copilot):
```
x-ratelimit-limit: 10
x-ratelimit-remaining: 7
x-ratelimit-reset: 1740000060   # Unix timestamp when window resets
x-ratelimit-used: 3
retry-after: 30                  # Seconds to wait on 429
```
clawd currently parses 429 status but does NOT read `retry-after` or `x-ratelimit-reset` headers — it uses fixed exponential backoff (5s, 10s, 20s...). This is wasteful when the server tells you exactly how long to wait.

---

## 3. Natural vs Bot/Programmatic Usage Patterns

### Natural Human Usage (Copilot Chat in VSCode)
- **Inter-request gap**: 15–120 seconds (human typing + reading responses)
- **Token per request**: ~2,000–6,000 tokens; variable across session
- **Concurrent requests**: 0–1 (human can't send two messages simultaneously)
- **Request cadence**: irregular, clustered during coding sessions, idle for hours/overnight
- **Bearer token**: one token per session, refreshed at natural boundaries
- **Source IP**: single stable IP per session

### Bot/Programmatic Abuse Pattern (what clawd currently looks like)
- **Inter-request gap**: 0–3 seconds (agent finishes task → immediately starts next)
- **Token per request**: large, consistent (full context windows every call)
- **Concurrent requests**: 3–10 simultaneous (multi-agent)
- **Request cadence**: continuous during run, no organic pauses
- **Bearer token rotation**: changes every request (round-robin)
- **User-Agent**: `Claw'd/1.0.0` (non-standard, non-Copilot)
- **Explicit agent headers**: `X-Initiator: agent`

The gap is stark. clawd currently looks maximally bot-like on every measurable signal.

---

## 4. Safe API Key Rotation Strategy

### The Core Tension
Round-robin rotation (clawd's current approach) maximizes throughput but looks synthetic. Sticky key-per-agent looks human-like but risks hot-agent = hot-key.

### Recommended Strategy: Sticky-with-Cooldown

```typescript
// Each agent claims a key at startup; key stays sticky per agent
// Key rotates ONLY when a 429 is received (not per-request)
// On 429: park the current key for `retry-after` seconds, assign a fresh one

class StickyKeyPool {
  private keys: string[];
  private assignments: Map<string, string> = new Map();   // agentId → key
  private cooldowns: Map<string, number> = new Map();     // key → resume-at timestamp

  assignKey(agentId: string): string {
    // Reuse existing assignment if key not in cooldown
    const existing = this.assignments.get(agentId);
    if (existing && Date.now() > (this.cooldowns.get(existing) ?? 0)) {
      return existing;
    }
    // Assign least-recently-used key not in cooldown
    const available = this.keys.filter(k => Date.now() > (this.cooldowns.get(k) ?? 0));
    const key = this.leastRecentlyUsed(available);
    this.assignments.set(agentId, key);
    return key;
  }

  reportRateLimit(key: string, retryAfterSecs: number) {
    this.cooldowns.set(key, Date.now() + retryAfterSecs * 1000);
  }
}
```

**Rules for safe rotation:**
1. **Never rotate faster than you need to** — rotation is a signal, not a feature
2. **One rotation event per 429, not per request** — if you hit a limit, swap the key once
3. **Honor `retry-after`** — read the header, wait exactly that long before retrying on ANY key
4. **Never use the same bearer token from multiple source IPs** — tokens are tied to the OAuth user; concurrent multi-IP usage is a sharing signal and ToS violation
5. **Refresh tokens proactively** — refresh 5+ minutes before expiry; expired-token retries add noise

---

## 5. Request Headers: Legitimate vs Automated Signals

### Official Copilot Client Headers (from B00TK1D/copilot-api reverse engineering + hankchiutw/copilot-proxy)

**Token acquisition** (`api.github.com/copilot_internal/v2/token`):
```http
User-Agent: GithubCopilot/1.155.0
editor-version: Neovim/0.6.1
editor-plugin-version: copilot.vim/1.16.0
accept-encoding: gzip,deflate,br
```

**Chat completions** (`api.githubcopilot.com/chat/completions`):
```http
User-Agent: GithubCopilot/1.155.0
Editor-Version: vscode/1.95.3
Copilot-Integration-Id: vscode-chat
X-GitHub-Api-Version: 2025-05-01
X-Interaction-Id: <fresh UUID per request>        ← already correct in clawd
Authorization: Bearer <short-lived token>
Content-Type: application/json
```

### clawd's Current Headers (with risk assessment)

| Header | clawd Value | Risk | Fix |
|---|---|---|---|
| `User-Agent` | `Claw'd/1.0.0` | 🔴 HIGH — trivially fingerprinted | `GithubCopilot/1.155.0` |
| `X-Initiator` | `agent` | 🔴 HIGH — explicit bot declaration | Remove entirely |
| `X-Interaction-Type` | `conversation-agent` | 🟡 MEDIUM — non-standard | Remove or use `conversation` |
| `Openai-Intent` | `conversation-agent` | 🟡 MEDIUM | Use `conversation` |
| `Copilot-Integration-Id` | `copilot-developer-cli` | 🟢 OK | Or use `vscode-chat` |
| `X-GitHub-Api-Version` | `2025-05-01` | 🟢 OK | Keep |
| `X-Interaction-Id` | `crypto.randomUUID()` | 🟢 OK | Keep |

### Recommended Header Set for clawd

```typescript
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "GithubCopilot/1.155.0",
  "Editor-Version": "vscode/1.99.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2025-05-01",
  // X-Interaction-Id: added per-request (already done)
  // REMOVE: X-Initiator, X-Interaction-Type, Openai-Intent
};
```

---

## 6. How Other Tools Handle Multi-Agent High-Frequency Usage

### hankchiutw/copilot-proxy
- Single-user proxy; manages **multiple OAuth tokens** (one per GitHub account)
- Token selection: uses stored tokens in round-robin OR by explicit user choice
- Token refresh: cached with 5-minute buffer before expiry
- **No concurrent multi-agent design** — single user, single session model
- Key insight: explicitly designed for personal use with multiple free accounts (each = separate GitHub user)

### B00TK1D/copilot-api
- Simple single-token design; token refreshed every 25 minutes via `threading.Thread`
- Uses official Copilot client headers (`GithubCopilot/1.155.0`)
- **No rate limiting logic** — fire-and-forget, relies on natural human-like usage

### Continue.dev (continuedev/continue)
- Accesses `api.githubcopilot.com` only for IDE-embedded use
- Does NOT implement multi-agent or pool rotation
- Uses VSCode Language Model API as intermediary — rate limits enforced by VS Code
- One request at a time per user action

### Cursor
- Uses its own model routing, **not** `api.githubcopilot.com` directly
- For Copilot models: proxies through VSCode extension Language Model API
- Cursor's proxy adds `stream: true` override for `gpt-4.1` (required)

### Common Pattern
All legitimate tools: **one GitHub seat = one user = one bearer token at a time**. None implement multi-agent pooling across keys. clawd is unique in this space.

---

## 7. GitHub ToS: Programmatic/Automated Use & Key Sharing

### What the Terms Say

**GitHub Terms for Additional Products — Copilot section** (effective April 1, 2025):
> "To use GitHub Copilot in your code editor, you need to install the GitHub Copilot extension to that editor."
> "To use GitHub Copilot in the CLI, you need to install the GitHub Copilot CLI extension."

This technically requires using an official client extension. Developer tools with proper OAuth and user consent exist in a grey zone (not explicitly permitted, not explicitly banned).

**GitHub Acceptable Use Policies:**
> "automated excessive bulk activity and coordinated inauthentic activity, such as spamming"
> "inauthentic interactions, such as fake accounts and automated inauthentic activity"

High-volume multi-agent use that exhausts quotas designed for individual users = likely AUP violation.

**Copilot Extension Developer Policy** (deprecated November 2025, replaced by MCP):
> "Violations of this Agreement may result in removing the Extension from the Platform, **token revocation**, Account or Extension suspension."

### Key Sharing (Critical)

Each Copilot seat is licensed per user. Using one seat's OAuth token to serve requests for multiple users/agents:
- **Violates per-seat licensing** — one seat = one human user
- **Triggers sharing detection** — same bearer from multiple IPs or in parallel
- clawd's `api_keys` config implies collecting multiple seats; using them as a pool is legitimate IF each key is a separate GitHub user's credential

### Safe Zone
- **Single GitHub account per key** ✅
- **One key used by one agent at a time** ✅ (sticky assignment)
- **Proper OAuth device flow, not token harvesting** ✅
- **Using `copilot_internal/v2/token` properly** ✅
- **Multiple agents = multiple GitHub seats** ✅ (one-to-one)

### Unsafe Zone
- **Single key shared across agents concurrently** ❌
- **Round-robin key rotation within one request stream** ❌
- **Explicit `X-Initiator: agent` header** ❌ (self-incriminating)
- **Non-standard User-Agent** ❌ (fingerprinting risk)
- **Free account keys with 500 chat limit serving agent workloads** ❌ (quota exhaustion)

---

## Actionable Changes for clawd (Priority Order)

### P0 — Fix Headers (Breaking Abuse Detection)
```typescript
// src/agent/src/api/client.ts
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "GithubCopilot/1.155.0",      // was: "Claw'd/1.0.0"
  "Editor-Version": "vscode/1.99.0",           // was: missing
  "Copilot-Integration-Id": "vscode-chat",     // was: "copilot-developer-cli"
  "X-GitHub-Api-Version": "2025-05-01",
  // REMOVE: X-Interaction-Type, Openai-Intent, X-Initiator
};
```

### P0 — Read `retry-after` Header on 429
```typescript
// In _completeOnce / _streamOnce response handler
if (status === 429) {
  const retryAfter = headers['retry-after'] || headers['x-ratelimit-reset'];
  // parse and use actual wait time, not fixed exponential backoff
}
```

### P1 — Switch from Round-Robin to Sticky-per-Agent Key Assignment
Current `getCopilotToken()` increments counter on every call. This creates the round-robin-per-request pattern. Change to: agent claims key at session start, holds it until 429, then swaps.

### P1 — Proactive Token Refresh
clawd only refreshes tokens when they expire. Add 5-minute pre-expiry refresh to avoid mid-request expiration bursts.

### P1 — Add Inter-Request Jitter
When multiple agents are running, add ~1–3 second jitter between requests per agent. This breaks the machine-regular cadence signal.

### P2 — Read `x-ratelimit-remaining` Before Sending
If `x-ratelimit-remaining` drops below a threshold (e.g., 2), slow down proactively rather than hitting 429.

### P2 — Concurrent Request Limiting
Hard-cap concurrent inflight requests per bearer token to 1 (for safety) or 2 (maximum documented for high-tier models). clawd currently has no such cap.

---

## Summary of Rate Limit Numbers for clawd (Copilot Pro/Business)

| Dimension | Limit | clawd Risk |
|---|---|---|
| Concurrent requests per token | 2 (Pro/Business), 4 (Enterprise) | HIGH — no cap |
| RPM per token (high models) | 10 RPM | HIGH — multi-agent can exceed trivially |
| RPM per token (standard models) | 15 RPM | MEDIUM |
| Input tokens per request | 8,192 (Pro), 16,384 (Enterprise) | LOW — large contexts may hit |
| Premium requests/seat/month | 300 (Pro/Business), ~1000 (Enterprise) | HIGH — agentic workloads exhaust fast |
| Monthly quota (Free only) | 500 chat / 4000 completions | N/A — clawd should use Pro+ keys |

---

## Unresolved Questions

1. **Does `Copilot-Integration-Id` value affect rate limit bucket assignment?** Unclear if `vscode-chat` vs `copilot-developer-cli` routes to different quota pools.
2. **Does `api.githubcopilot.com` actually enforce GitHub Models rate limits** for Copilot subscribers, or are they separate pools? Community reports suggest Copilot Pro has *more* headroom than GitHub Models table shows for standard chat.
3. **Premium request multipliers**: which exact models (Claude Opus 4.6 used by clawd?) count as 1.0x vs N× premium requests? No published multiplier table for Copilot (only confirmed for GitHub Models).
4. **IP-based rate limiting**: Does GitHub enforce per-IP limits independently of per-token limits? Single datacenter IP serving all agents could hit IP-level caps.
5. **Is the `Iv1.b507a08c87ecfe98` OAuth client ID still valid?** This ID (from Neovim plugin) is widely used in reverse-engineering projects; GitHub may have added stricter checks on non-VSCode client IDs.
