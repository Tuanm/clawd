# GitHub Copilot API: Premium Request Quota Mechanics

**Date:** 2026-03-03  
**Research scope:** X-Initiator header semantics, non-premium rate limits, abuse detection, monthly budgets, key rotation  
**Sources:** GitHub docs (github/docs repo, direct YAML/MD), ericc-ch/copilot-api issues (issues #47, #68, #77, #85, #134, #171, #201), caozhiyuan/copilot-api fork source, anomalyco/opencode-copilot-auth, sst/opencode#595, nghyane/llm-mux source, mitmproxy reverse-engineering reports

---

## 1. X-Initiator Header: `agent` vs `user`

### What it is

`X-Initiator` is a **GitHub-proprietary request header** sent to `api.githubcopilot.com/chat/completions` (and `/v1/messages`, `/responses`). It signals whether the request was triggered by a human user typing a prompt, or by the AI agent itself as a follow-up action.

**Values observed in the wild:**
- `X-Initiator: user` — user typed a prompt; counts against premium quota
- `X-Initiator: agent` — AI-initiated follow-up (tool call, continuation); does NOT count against premium quota

### Does `agent` = 0 premium requests consumed?

**Yes, confirmed.** GitHub's own docs say:
> "Copilot may take several follow-up actions to complete your task, but these follow-up actions do **not** count toward your premium request usage. Only the prompts you enter are billed — tool calls or background steps taken by the agent are not charged."  
> — `data/reusables/copilot/copilot-edits/agent-mode-requests.md` (github/docs repo)

Community verification (ericc-ch/copilot-api issue #68):
> "i sent quite a few messages in claude code... copilot api correctly set the header as user for each message i sent... but then i checked my quota, it did not go down"  
> — Comment from @cuipengfei (2025-08-xx), after X-Initiator fix was deployed

The explanation: GitHub's Copilot billing model treats an entire "agent session" as a single premium request from the user's perspective. The underlying LLM calls made by the agent during that session are `agent`-initiated and are free.

### Correct detection logic

The community iterated through **two implementations**; both are in production:

| Version | Logic | Problem |
|---------|-------|---------|
| **v1 (naive)** — ericc-ch original | `isAgentCall = messages.some(m => ["assistant","tool"].includes(m.role))` | Marks multi-turn conversations as "agent" after first response → **never charges user past turn 1** |
| **v2 (corrected)** — opencode PR#10 / caozhiyuan fork | `isAgentCall = messages.at(-1).role !== "user"` | Charges for each user message; agent for tool/assistant continuations |

The **v1 approach** under-charges (vs VSCode Copilot behavior) and is what multiple proxy tools used until early Jan 2026. ericc-ch v0.7.0 still had v1 logic as of Feb 2026, prompting issue #201 ("this repo doesn't use the copilot subscription well").

caozhiyuan fork (`all` branch, PR #170) fixed this to match VSCode behavior exactly.

**Authoritative v2 logic** (from caozhiyuan's `create-messages.ts`):
```typescript
// Premium is charged if last message is from user (not tool_result-only)
let isInitiateRequest = false;
const lastMessage = payload.messages.at(-1);
if (lastMessage?.role === "user") {
  isInitiateRequest =
    Array.isArray(lastMessage.content) ?
      lastMessage.content.some(block => block.type !== "tool_result")
    : true;
}
const initiator = options?.initiator ?? (isInitiateRequest ? "user" : "agent");
// header: "X-Initiator": initiator
```

**Key edge case:** A message with `role: "user"` but content = `[{type: "tool_result"}]` only is treated as `agent` because it's the AI feeding back tool results, not an actual user message.

### Where the header is NOT set

`nghyane/llm-mux` (322 ⭐) does NOT set `X-Initiator` in its copilot executor (as of March 2026 — `internal/runtime/executor/providers/copilot.go`). It only sets `Editor-Version`, `Editor-Plugin-Version`, `Openai-Intent`, `Copilot-Integration-Id`, `X-Request-Id`. Omitting X-Initiator likely defaults to GitHub billing every request as premium.

---

## 2. Non-Premium (Agent) Request Rate Limits

### What GitHub says

GitHub's rate-limits doc (`content/copilot/concepts/rate-limits.md`) is **deliberately vague**:
> "Service-level rate limits should not affect typical Copilot usage. However, if you're heavily using preview models, you may encounter rate limits more frequently."
> "Certain requests may experience rate limits to accommodate high demand."

**No specific numbers are published for agent-initiated (non-premium) requests.**

### Community-observed thresholds

From `ericc-ch/copilot-api` issues and nghyane/llm-mux source:

| Limit type | Observed value | Source |
|------------|---------------|--------|
| Soft service rate limit | Unknown; 429s reported with no specific threshold | Community reports |
| Default rate limit in nghyane (conservative estimate) | ~10,000 req/24h, burst 100 per key | `strategy_copilot.go` hardcoded estimate |
| ericc-ch adaptive rate limiter default | 1 second between requests | PR #162 "smart 1s default" |
| Concurrent streams per token | 2 (community observation, aligns with GitHub Models docs) | Various issues |

**Critical distinction:** Agent requests still hit **service-level** rate limits even though they don't consume the monthly premium quota. A 429 on an agent request is a throughput limit, not a quota limit.

### Headers on 429 responses
GitHub returns standard rate-limit headers:
```
x-ratelimit-limit: N
x-ratelimit-remaining: N
x-ratelimit-reset: <unix timestamp>
retry-after: <seconds>
```
Most proxy implementations (including ericc-ch before PR #162) use fixed backoff instead of reading `retry-after`. PR #162 added adaptive rate limiting that reads these headers.

---

## 3. Abuse Detection: What Triggers Review or Ban

### Confirmed ban cases

From issue #134 (ericc-ch, Oct 2025):
> "it immediately triggers warning from github and it results in automated github copilot ban. it happens instantly regardless of the token usage too little or too big — after 3-5 requests i get banned."

Community response: bans appear **rare but real**, triggered immediately by specific patterns, not usage volume.

### Confirmed risk signals (ranked by severity)

**🔴 HIGH RISK — Immediate fingerprinting:**

| Signal | Why it triggers | Fix |
|--------|----------------|-----|
| Non-standard `User-Agent` | `Claw'd/1.0.0`, `copilot-api/1.0` are trivially fingerprintable | Use `GithubCopilot/1.0` or `GitHubCopilotChat/0.23.2` |
| Wrong `Copilot-Integration-Id` | `copilot-developer-cli` not seen in VSCode traffic | Use `vscode-chat` |
| Missing standard headers | `vscode-machineid`, `vscode-sessionid` absent | Add realistic mock values |

Issue #9 from ericc-ch (complete header set required):
```http
authorization: Bearer <token>
copilot-integration-id: vscode-chat
editor-plugin-version: copilot-chat/0.23.2
editor-version: vscode/1.98.0
openai-intent: conversation-panel
openai-organization: github-copilot
user-agent: GitHubCopilotChat/0.23.2
vscode-machineid: <64 hex chars>
vscode-sessionid: <UUID>+<13 digits>
x-github-api-version: 2024-12-15
x-request-id: <UUID per request>
```

**🟡 MEDIUM RISK — Pattern-based detection:**

| Signal | Risk |
|--------|------|
| Sub-second request cadence | Automated-looking burst pattern |
| Round-robin key rotation per-request | Machine-regular switching unnatural |
| Same bearer token from multiple IPs | Token sharing → ToS violation |
| Explicit `X-Initiator: agent` on ALL requests | Over-using agent path; GitHub may validate session context |

**🟢 LOWER RISK (community consensus "mostly fine"):**

Using copilot-api proxies with proper headers and human-like cadence. Multiple people with issue #134 pattern successfully running cline/roocode through copilot-api for extended periods without bans.

### X-Initiator: agent — suspicious by itself?

Based on community evidence: **not suspicious if used correctly.** The header is part of the official protocol; VSCode Copilot itself sends it. What's suspicious is sending `agent` when the last message is from the user (i.e., fraud), or using it with entirely wrong other headers.

The caozhiyuan developer explicitly warns (PR #85 comments):
> "The current X-Initiator configuration rule [naive any-message check] is potentially fraudulent. GitHub Copilot Chat in VS Code charges for all non-tool-call requests."

So the risk is: **incorrect `agent` classification is a billing violation**, not that `agent` itself is suspicious.

### What does NOT trigger bans (community-verified)

- Heavy usage of ericc-ch/copilot-api with `--rate-limit 180 --wait` option
- Running cline/roocode through proxy for weeks at a time
- Multiple agents if each agent has its own GitHub account/key

---

## 4. Monthly Premium Budget: Confirmed Numbers

From `data/reusables/copilot/differences-cfi-cfb-table.md` (official GitHub docs source, current as of March 2026):

| Plan | Monthly Premium Requests | Additional rate |
|------|------------------------|-----------------|
| **Free** | 50/month | Not purchasable |
| **Pro** ($10/mo) | **300/month** | $0.04/request |
| **Pro+** ($39/mo) | **1,500/month** | $0.04/request |
| **Business** ($19/user/mo) | **300/user/month** | $0.04/request |
| **Enterprise** ($39/user/mo) | **1,000/user/month** | $0.04/request |

Billing for premium requests began **June 18, 2025** (paid plans) and **August 1, 2025** (enterprise data residency).  
Quotas reset on the **1st of each month at 00:00:00 UTC**.  
Unused requests do **not** carry over.

### What happens when quota runs out?

**Graceful degradation, NOT hard block** (from official docs):
> "If you're on a paid plan and use all of your premium requests, you can still use Copilot with one of the included models for the rest of the month."

Included models (0x multiplier, always free on paid plans):
- **GPT-5 mini** (0x)
- **GPT-4.1** (0x)
- **GPT-4o** (0x)
- **Raptor mini** (0x, preview)

So at quota exhaustion: premium model requests fail, but 0x models continue to work. You can also purchase overages.

### Model Multipliers (confirmed from `data/tables/copilot/model-multipliers.yml`):

| Model | Paid plan multiplier | Free plan multiplier |
|-------|---------------------|---------------------|
| GPT-5 mini, GPT-4.1, GPT-4o, Raptor mini | **0x** | 1x |
| Claude Haiku 4.5 | **0.33x** | 1x |
| Gemini 3 Flash | **0.33x** | N/A |
| GPT-5.1-Codex-Mini, Grok Code Fast 1 | **0.25-0.33x** | N/A |
| Claude Sonnet 4/4.5/4.6 | **1x** | N/A |
| Gemini 2.5 Pro, 3 Pro | **1x** | N/A |
| GPT-5.1, GPT-5.2, GPT-5.3-Codex | **1x** | N/A |
| Claude Opus 4.5 | **3x** | N/A |
| Claude Opus 4.6 | **3x** | N/A |
| Claude Opus 4.6 fast mode (preview) | **30x** | N/A |

**Implications for clawd:**  
Using Claude Opus 4.6 = 3x multiplier → 300 Pro requests = effectively **100 Opus interactions/month**.  
Using GPT-5 mini = 0x → **unlimited on paid plan** (subject to service rate limits only).

### Usage tracking API

The quota is visible via:
```
GET api.github.com/copilot_internal/user
```
Response includes `quota_snapshots.premium_interactions`:
```typescript
interface QuotaDetail {
  entitlement: number;          // total monthly allowance
  remaining: number;            // remaining this month
  percent_remaining: number;
  overage_count: number;        // requests beyond allowance
  overage_permitted: boolean;
  unlimited: boolean;           // true for included models
}
```

---

## 5. Key Rotation Strategies: Community Findings

### What actually works

**Strategy A: Per-account sticky assignment (dominant approach)**  
Each GitHub account = 1 key = 1 agent. Keys never rotate per-request. This is the only approach consistent with ToS (one seat = one user). Used by ericc-ch/copilot-api, B00TK1D/copilot-api, nghyane/llm-mux.

**Strategy B: Adaptive rate limiting with wait queuing**  
ericc-ch PR #162 implements bidirectional adaptive rate limiting:
- Default: 1 second between requests
- On 429: backs off, reads `retry-after`, waits
- On success: gradually speeds up
- Verdict: works well for single-account usage

**Strategy C: Model-based quota conservation (caozhiyuan)**  
Use `gpt-5-mini` (0x) as the sub-agent/haiku model:
```json
{
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
  "CLAUDE_CODE_SUBAGENT_MODEL": "gpt-5-mini"
}
```
This routes all sub-agent exploration tasks to the 0x model, saving premium quota for main-model interactions.

**Strategy D: Suppress non-essential traffic**  
```
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```
Claude Code 2.x makes warmup/summary requests on session start; these consume premium if pointed at Opus.

### What gets you banned (community-verified fast)

1. **Wrong/missing fingerprint headers** — bans in 3-5 requests (issue #134)
2. **Token velocity anomalies** — same token from multiple IPs simultaneously
3. **Non-human cadence** — sub-100ms request bursts (theoretical; no confirmed bans specifically)

### Observed safe operating parameters

Based on ericc-ch PR #162 and community comments:
- **1–3 second inter-request spacing** per key: safe zone
- **Multiple agents with separate keys**: fine, common pattern
- **Using ericc-ch/copilot-api with proper headers for months**: no bans reported
- **ericc-ch rate-limit flag**: `--rate-limit 180` = 180 second wait on 429 (very conservative, but safe)

---

## 6. The "One Billing Session" Mechanic (Important)

GitHub's internal billing groups requests into "sessions" for the coding agent:

> "Each coding agent session consumes one premium request. A session begins when you ask Copilot to create a pull request or make one or more changes."

For interactive chat (non-coding-agent): each user-initiated message = 1 premium request × multiplier. No session bundling.

The naive `X-Initiator` trick (v1, any-message check) incorrectly bundled entire multi-turn conversations into 1 premium request. VSCode Copilot doesn't do this — it charges per user message. The v1 approach essentially exploits a billing quirk and is considered a gray area.

---

## Summary Table

| Question | Answer |
|----------|--------|
| Does `X-Initiator: agent` = 0 premium consumed? | **Yes** — confirmed by GitHub docs and mitmproxy testing |
| Correct rule for setting `agent` | Last message role is NOT "user" (or is user-only-tool-results) |
| Non-premium rate limits (agent requests) | Not published; service-level 429s apply; ~1s spacing is safe |
| Rate limit on 429 | Read `retry-after` header; don't use fixed backoff |
| Pro monthly quota | **300 premium requests** (confirmed from docs source) |
| Business quota | **300/user/month** |
| Enterprise quota | **1,000/user/month** |
| At quota exhaustion | Graceful: included models (0x) still work; premium models blocked |
| Included (0x) models | GPT-5 mini, GPT-4.1, GPT-4o, Raptor mini |
| Claude Opus multiplier | **3x** (Opus 4.5/4.6); **30x** for Opus 4.6 fast-mode |
| Abuse trigger: bans | Wrong headers (instant, 3-5 requests); normal use with good headers: fine |
| Safe key rotation | Sticky per-account, rotate only on 429, honor retry-after |

---

## Unresolved Questions

1. **Does GitHub validate X-Initiator semantically?** I.e., does it cross-check the header against actual message history, or does it trust the client? No evidence of server-side validation; the header appears to be trusted as-is (billing is honor-based).

2. **Service rate limits for agent (non-premium) requests — exact numbers?** GitHub hasn't published these. Community reports suggest they're significantly more permissive than the monthly premium quota, but no hard numbers.

3. **IP-level rate limits?** Unknown. Single-datacenter IP serving many agents could hit IP-level caps independent of per-key limits. No documented cases.

4. **Does `Copilot-Integration-Id` value affect quota pool assignment?** Using `vscode-chat` vs `copilot-developer-cli` may route to different billing buckets. Unconfirmed.

5. **How long does a "ban" last?** Issue #134 describes instant bans; unclear if temporary (hours/days) or permanent account suspension. No follow-up data in the thread.

6. **Claude Sonnet 4.6 multiplier stability note**: GitHub docs explicitly say "The multiplier for Claude Sonnet 4.6 may be subject to change" — it's 1x currently but could move.
