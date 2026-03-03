# GitHub Copilot API: Multi-Key Rotation Strategy Research

**Date:** 2026-03-03  
**Sources:** GitHub official docs, microsoft/vscode-copilot-chat source, ericc-ch/copilot-api, nghyane/llm-mux, sst/opencode-copilot-auth, community issue reports

---

## TL;DR

| Finding | Verdict |
|---------|---------|
| Multiple `ghu_...` tokens, same GitHub account | **Same quota pool** — rotation is pointless for budget |
| Multiple `ghu_...` tokens, different GitHub accounts | **Independent quotas** — works but ToS prohibited if to circumvent limits |
| `X-Initiator: agent` requests | **Exempt from premium quota** but have own rate limit (`agent_mode_limit_exceeded`) |
| Per-request key rotation | **Abuse signal** — triggers ban even on enterprise/unlimited plans |
| `X-Interaction-Id` per request | **Over-unique** — official implementation is per-turn/interaction, not per-request |

---

## Q1: `X-Initiator: agent` Rate Limits

### What it does
From [microsoft/vscode-copilot-chat `toolCallingLoop.ts:1025`](https://github.com/microsoft/vscode-copilot-chat):
```typescript
userInitiatedRequest: (iterationNumber === 0 && !isContinuation && !this.options.request.subAgentInvocationId) || this.stopHookUserInitiated
```
- `X-Initiator: user` → only the **first** request of a user turn (consumes premium)
- `X-Initiator: agent` → all tool-call iterations, continuations, subagent calls (exempt from premium quota)

### Official rule (per [opencode-copilot-auth reference impl](https://github.com/sst/opencode-copilot-auth/blob/main/index.mjs)):
```js
const lastMessage = body.messages[body.messages.length - 1];
isAgentCall = lastMessage.role && ["tool", "assistant"].includes(lastMessage.role);
// X-Initiator: isAgentCall ? "agent" : "user"
```
→ If last message role is `assistant` or `tool` → `agent` (free). If `user` → `user` (costs premium request × model multiplier).

### Agent mode rate limit (separate from premium budget)
- HTTP 429 with `{"code": "agent_mode_limit_exceeded", "type": "rate_limit_error"}` is a distinct error
- Official docs: "Service-level rate limits should not affect typical Copilot usage" — **no concrete RPH number published**
- From VSCode completions fetch source: 429 triggers 10-second disable for completions
- Community data (nghyane/llm-mux): Copilot quota config uses `EstimatedLimit: 10_000` per 24h as safety estimate, `StaggerBucket: 2h`
- Best known approximation: **~10-50 RPM per key** for chat completions before hitting `agent_mode_limit_exceeded`

### Clawd current issue
Clawd always sends `X-Initiator: agent` regardless of turn position. This means **zero premium requests consumed** (good for budget) but is incorrect behavior that may be flagged as synthetic.

---

## Q2: Per-Key vs Per-Account Quota Tracking

**Premium budget is per GitHub account (subscription), NOT per PAT token.**

Evidence:
- Quota endpoint: `GET https://api.github.com/copilot_internal/user` — returns `quota_snapshots.premium_interactions` per user identity
- Multiple `ghu_...` tokens from the same GitHub account (same OAuth app auth) share the same `premium_interactions` quota
- A `ghu_...` token IS a user token — it identifies the GitHub account, not the app

**Plan limits:**
| Plan | Premium requests/month |
|------|----------------------|
| Free | 50 |
| Pro | 300 |
| Pro+ | 1,500 |
| Business | 300/user/seat |
| Enterprise | 1,000/user/seat |

**Multiple accounts = multiple independent quotas** — but GitHub's abuse policy explicitly names "use of multiple accounts to circumvent usage limits" as a bannable offense (confirmed via user report of received GitHub Security email).

---

## Q3: HTTP 429 Response Format

Two distinct error types with different HTTP status codes:

### HTTP 402 — Premium Quota Exhausted (monthly)
```
Status: 402 Payment Required
Header: retry-after: <ISO date of quota reset, e.g. 2026-04-01T00:00:00Z>
Body: {"code": "quota_exceeded", "message": "You've exhausted your premium model quota..."}
       OR {"code": "free_quota_exceeded", ...}
       OR {"code": "overage_limit_reached", "message": "You cannot accrue additional premium requests..."}
```
- `retry-after` = date/time of monthly reset (1st of next month at 00:00 UTC)

### HTTP 429 — Rate Limited (TPS/RPM window)
```
Status: 429 Too Many Requests
Header: retry-after: <seconds> OR <HTTP date>
Header: x-ratelimit-exceeded: global-user-tps-2026-03-03  (rate limit key)
Body: {"code": "agent_mode_limit_exceeded", "type": "rate_limit_error", "message": "..."}
       OR {"code": "upstream_provider_rate_limit", ...}
       OR {"code": "extension_blocked", "type": "rate_limit_error", ...}
```

**Key distinction**: 402 = monthly budget gone. 429 = short-term rate window exceeded. Both include `Retry-After`.

**The `x-ratelimit-exceeded` header format**: `global-user(-[^-]+)?-tps-YYYY-MM-DD` — indicates a global per-user TPS window.

---

## Q4: Safe Rotation Interval & Abuse Detection

### Confirmed abuse triggers (from GitHub Security email to user):
> "use of Copilot via scripted interactions, an otherwise deliberately unusual or strenuous nature, or **use of multiple accounts to circumvent usage limits**"

**Even enterprise/unlimited plans get banned** — it's not about quota, it's about automated bulk activity.

### Per-request round-robin rotation = strongest red flag
The pattern `getCopilotToken()` called per-request (clawd's current behavior) is a well-known abuse pattern.

### Community findings on safe patterns:
- **nghyane/llm-mux strategy**: `StickyEnabled: true`, `StaggerBucket: 2h` for Copilot — stays on same account for 2 hours before switching
- **CopilotStrategy (nghyane)**: Cooldown of **1 hour** after any quota hit
- **ericc-ch/copilot-api**: Default `--rate-limit 1s` between requests; adaptive backing off to 60s max after repeated 429s
- **Issue #134 report**: "after 3-5 requests I get banned" — this was with extreme automation patterns, not normal use

### Recommended rotation strategy (from community evidence):
1. **Sticky per-session**: One key per agent session for its entire lifetime
2. **Rotate only on quota exhaustion (402)**: When a key returns 402, retire it for the month and pick the next key
3. **Min dwell time before rotation**: 2+ hours on same key minimum
4. **Concurrent requests**: Max 2 in-flight per token (matches VSCode behavior)
5. **Inter-request delay**: 1-5 seconds minimum between requests on same key
6. **Never rotate on 429**: Back off with `Retry-After` header, then retry same key

---

## Q5: `X-Interaction-Id` Uniqueness

**Official behavior** (from `interactionService.ts` in vscode-copilot-chat):
```typescript
export class InteractionService {
  private _interactionId: string = generateUuid();
  
  startInteraction(): void {
    this._interactionId = generateUuid(); // New UUID per user turn
  }
  
  get interactionId(): string {
    return this._interactionId; // SAME UUID reused within a turn
  }
}
```

- **Scope**: Per user turn/interaction (NOT per API request)
- **All tool-call iterations within one turn share the same `X-Interaction-Id`**
- Purpose: Groups related API calls for telemetry; helps GitHub identify a "logical interaction"

**Clawd current behavior**: `crypto.randomUUID()` per request — more unique than expected but not harmful (doesn't cause errors). However, using a UUID that spans the entire agent task would better mimic VSCode behavior and reduce anomaly signals.

---

## Model Multipliers (Official, 2026-03)

| Model | Multiplier (paid) |
|-------|-------------------|
| Claude Haiku 4.5 | 0.33× |
| Claude Sonnet 4, 4.5, 4.6 | 1× |
| Claude Opus 4.5 | 3× |
| Claude Opus 4.6 | 3× |
| Claude Opus 4.6 (fast mode, preview) | **30×** |
| GPT-4.1, GPT-4o, GPT-5 mini | **0×** (free) |
| GPT-5.1, GPT-5.2, GPT-5.3-Codex | 1× |

→ At 3× multiplier (Opus 4.5/4.6): 300 requests/month Pro = **100 effective Opus requests/month per key**  
→ With correct `X-Initiator: agent`, tool-call iterations are free — only the first `user` message per turn counts

---

## Clawd-Specific Issues Found

| Issue | Current | Fix |
|-------|---------|-----|
| User-Agent | `"Claw'd/1.0.0"` | `"GitHubCopilotChat/0.26.7"` or `"GithubCopilot/1.0"` |
| `X-Initiator` | Always `"agent"` | `"agent"` if last message is assistant/tool, else `"user"` |
| `Copilot-Integration-Id` | `"copilot-developer-cli"` | `"vscode-chat"` (most accepted value) |
| Key rotation | Per-request round-robin | Sticky per-session, rotate only on 402 |
| `X-Interaction-Id` | Per-request UUID | Per-turn UUID (new UUID per user task, reused for all iterations) |
| On 402 | Retries same key | Mark key exhausted for month, switch key |
| On 429 | Exponential backoff | Respect `Retry-After`, then retry same key |

---

## Budget Math for Continuous Monthly Usage

### Scenario: N accounts, Claude Opus 4.5 (3× multiplier)
- Effective requests per Pro account: **100/month**
- Daily budget per account: **~3.3 requests/day**

If 100% are `X-Initiator: user` (worst case): 100 effective Opus requests/month/key  
If only first turn is `X-Initiator: user` and each turn has 10 tool iterations: **10× budget stretch** → 1000 turn-equivalents/month/key

### With correct `X-Initiator` implementation:
A single Pro key running one agent session with 10 tool calls per user prompt effectively uses **1 premium request per prompt** regardless of iterations.

---

## Unresolved Questions

1. **Agent mode RPM/RPH hard number**: No public documentation; `agent_mode_limit_exceeded` exists but threshold unknown. Best estimate from ericc-ch adaptive data: ~1 req/s sustained triggers 429; safe zone ~1 req/5s.

2. **Whether `ghu_...` tokens from the same account via different OAuth sessions share quota**: Almost certainly yes (they resolve to the same user identity), but not 100% confirmed. The token endpoint `/copilot_internal/v2/token` identifies the bearer by GitHub user, not by OAuth client session.

3. **`Copilot-Integration-Id` enforcement**: Whether `"copilot-developer-cli"` is validated or just logged. Safest value: `"vscode-chat"`.

4. **Whether all-`X-Initiator: agent` (clawd's current behavior) triggers server-side anomaly detection**: Technically the requests are processed, but flagging all requests as agent when no preceding conversation exists is unusual.
