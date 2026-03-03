# GitHub Copilot Premium Request Billing & Model Multipliers

**Date:** 2026-03-03  
**Source:** Official GitHub Docs (live fetch, 2026-03-03)  
**Primary URL:** https://docs.github.com/en/copilot/concepts/billing/copilot-requests  
**Secondary URL:** https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot

---

## 1. Model Multipliers (Official, Verified)

Source: https://docs.github.com/en/copilot/concepts/billing/copilot-requests#model-multipliers

| Model | Multiplier (paid plans) | Multiplier (Copilot Free) |
|-------|------------------------|--------------------------|
| **Claude Haiku 4.5** | **0.33×** | 1× |
| **Claude Opus 4.5** | **3×** | N/A |
| **Claude Opus 4.6** | **3×** | N/A |
| Claude Opus 4.6 (fast mode) *(preview)* | **30×** | N/A |
| **Claude Sonnet 4** | **1×** | N/A |
| **Claude Sonnet 4.5** | **1×** | N/A |
| **Claude Sonnet 4.6** | **1×** ⚠️ *subject to change* | N/A |
| Gemini 2.5 Pro | 1× | N/A |
| Gemini 3 Flash | 0.33× | N/A |
| Gemini 3 Pro | 1× | N/A |
| Gemini 3.1 Pro | 1× | N/A |
| **GPT-4.1** | **0× (included)** | 1× |
| **GPT-4o** | **0× (included)** | 1× |
| **GPT-5 mini** | **0× (included)** | 1× |
| GPT-5.1 | 1× | N/A |
| GPT-5.1-Codex | 1× | N/A |
| GPT-5.1-Codex-Mini | 0.33× | N/A |
| GPT-5.1-Codex-Max | 1× | N/A |
| GPT-5.2 | 1× | N/A |
| GPT-5.2-Codex | 1× | N/A |
| GPT-5.3-Codex | 1× | N/A |
| Grok Code Fast 1 | 0.25× | N/A |
| Raptor mini | 0× (included) | 1× |
| Goldeneye | N/A | 1× |

### Key corrections from prior report
- **Claude Opus 4.6 = 3×** ✅ (prior "3x claimed" was correct)  
- There is no model named `claude-opus-4.6` in the table; it's `Claude Opus 4.6` — but yes, 3×.  
- **Claude Sonnet 4.6 = 1×** (NOT premium-cost; same as Sonnet 4 and 4.5)  
- **Claude Haiku 4.5 = 0.33×** — cheaper than a full premium request  
- **GPT-4.1 = 0×** — FREE on paid plans; does NOT consume premium requests  
- **Claude Opus 4.6 fast mode = 30×** — extreme budget-burner, avoid in automation

### Auto-model-selection discount
Paid plans using Copilot auto model selection in VS Code get a **10% multiplier discount** (e.g., Sonnet 4.6 → 0.9×). Not applicable to Free tier.

---

## 2. Plans & Premium Request Allowances

Source: https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot

| Plan | Price | Premium Requests/Month |
|------|-------|----------------------|
| **Copilot Free** | $0 | **50/month** |
| **Copilot Pro** | $10/mo or $100/yr | **300/month** |
| **Copilot Pro+** | $39/mo or $390/yr | **1,500/month** |
| **Copilot Business** | $19/seat/mo | **300/user/month** |
| **Copilot Enterprise** | $39/seat/mo | **1,000/user/month** |

**The "300 requests/month" plan is both Copilot Pro ($10/mo individual) and Copilot Business ($19/seat/mo).** Prior report was correct.

**Included models** (0× cost, unlimited on paid plans): GPT-5 mini, GPT-4.1, GPT-4o, Raptor mini.

**Additional premium requests**: $0.04/request (overage, purchasable on paid plans). Free tier cannot purchase extras.

---

## 3. What Happens After Quota Exhaustion

**Soft limit, NOT a hard block.**

From official docs:
> "If you're on a paid plan and use all of your premium requests, you can still use Copilot with one of the included models for the rest of the month."

Behavior:
1. Premium requests exhausted → falls back to included models (GPT-5 mini, GPT-4.1, GPT-4o)
2. Included models are **rate-limited** (not unlimited) and "response times may vary during high usage"
3. **No HTTP 402** unless org/enterprise has enabled "Premium request paid usage" policy AND a budget limit configured to stop on threshold
4. If overage policy enabled + no budget cap → requests to premium models continue at **$0.04/request** billed
5. If overage blocked at budget cap → then HTTP 4xx (likely 402/429) on premium model requests

**In practice for clawd**: Unless you've explicitly set a spending cap at $0 in your GitHub billing settings, hitting 300 requests does NOT hard-block you. It degrades to included models. You will NOT get a 402 on `api.githubcopilot.com` for Claude Opus just from quota exhaustion — you'll get a response from GPT-4.1 instead if the model falls back, or an error if the model is strictly requested.

**Important caveat**: GitHub docs say "This is subject to change" — the soft fallback behavior is not guaranteed.

---

## 4. X-Initiator: agent — Verdict: FOLKLORE, Not Officially Documented

**Official GitHub documentation contains ZERO mention of `X-Initiator` as a header.**

Searched:
- `docs.github.com/en/copilot/concepts/billing/copilot-requests`
- `docs.github.com/en/copilot/concepts/rate-limits`
- GitHub Copilot API extension docs
- GitHub REST API docs

**What clawd's internal docs claim** (`src/agent/docs/COPILOT-API.md`):
> `X-Initiator: agent` | Enables premium mode (no rate limits)

**What community reverse-engineering says** (in `research-notes.md`):
> `X-Initiator: agent` — PREMIUM MODE - bypasses rate limits

**Reality assessment**:
- No GitHub official documentation describes this header at all
- The claim originated in community reverse-engineering and got copied into clawd's internal docs
- The header name `X-Initiator` happens to be generic and appears in browser DevTools for unrelated network events (Playwright, Chrome inspector) — the original observer may have confused browser network initiator metadata with a Copilot API header
- There IS no documented "premium mode" or "no rate limits" behavior tied to any request header in official Copilot docs
- Rate limits are enforced server-side on the bearer token's identity, not based on client headers
- **Hypothesis**: The header may be an internal GitHub header used by official coding agent flows (the official GitHub Copilot coding agent uses agentic sessions) that routes to a different internal quota pool. But there is no public documentation that `X-Initiator: agent` from third-party callers has any billing effect.

**Risk**: Sending `X-Initiator: agent` is a self-identifying "I am a bot" signal (as noted in prior reports). It does NOT bypass premium quotas. It may trigger stricter scrutiny or different routing internally.

**Recommendation**: Remove `X-Initiator: agent` from clawd's headers. No documented benefit; documented downside.

---

## 5. ghu_... Tokens — Single-Account, Multi-IP Capability

`ghu_*` tokens are OAuth device flow tokens issued via GitHub's Device Authorization Grant. Key facts:

**What they are**:
- Tied to a single GitHub account (one user's credentials)
- Permanent until revoked (unlike the short-lived Copilot bearer tokens, which have ~25 min TTL)
- Used to exchange for Copilot bearer tokens at `api.github.com/copilot_internal/v2/token`

**Multi-IP concurrent use**:
- OAuth tokens themselves have **no documented IP restriction** — GitHub's REST API is accessible from any IP using a valid OAuth token
- **However**, GitHub's Copilot ToS restricts each seat to one user: using one `ghu_*` token from multiple IPs/agents simultaneously = one account serving multiple users = ToS violation
- GitHub's abuse detection monitors for concurrent requests from the same bearer token from different IPs (noted in prior report)
- The `ghu_*` token can technically make requests from multiple IPs; GitHub will detect this as suspicious usage and may revoke the token or throttle the account

**Summary for multi-key architecture**:
- ✅ Multiple `ghu_*` tokens = multiple distinct GitHub accounts = multiple Copilot seats = legitimate
- ❌ One `ghu_*` token shared across multiple agents/IPs = one seat serving many = ToS violation
- Each `ghu_*` should be used by exactly one agent at a time (sticky assignment)

---

## 6. Budget Math for clawd

With models and multipliers confirmed, here's the effective capacity per plan:

### Copilot Pro ($10/mo) — 300 premium requests/month

| Model | Multiplier | Effective Requests |
|-------|-----------|-------------------|
| Claude Opus 4.6 | 3× | **100 messages** |
| Claude Sonnet 4.6 | 1× | **300 messages** |
| Claude Haiku 4.5 | 0.33× | **~909 messages** |
| GPT-4.1 | 0× | **∞ (included)** |

### Copilot Pro+ ($39/mo) — 1,500 premium requests/month

| Model | Multiplier | Effective Requests |
|-------|-----------|-------------------|
| Claude Opus 4.6 | 3× | **500 messages** |
| Claude Sonnet 4.6 | 1× | **1,500 messages** |
| Claude Haiku 4.5 | 0.33× | **~4,545 messages** |

### Copilot Enterprise ($39/seat/mo) — 1,000 premium requests/user/month

| Model | Multiplier | Effective Requests |
|-------|-----------|-------------------|
| Claude Opus 4.6 | 3× | **~333 messages/user** |
| Claude Sonnet 4.6 | 1× | **1,000 messages/user** |

### Overage pricing ($0.04/request at 1× multiplier)

| Model | Cost per message |
|-------|----------------|
| Claude Opus 4.6 (3×) | $0.12/message |
| Claude Sonnet 4.6 (1×) | $0.04/message |
| Claude Haiku 4.5 (0.33×) | ~$0.013/message |

**For multi-agent agentic workloads**: Claude Haiku 4.5 (0.33×) is the most budget-efficient premium model. Claude Sonnet 4.6 (1×) gives much better quality at 3× the cost. Claude Opus 4.6 (3×) burns budget fast and should be reserved for high-value tasks only.

---

## 7. Actionable Corrections for clawd

1. **Remove `X-Initiator: agent` header** — no documented benefit, active downside as bot fingerprint
2. **Use Claude Haiku 4.5 for bulk/routine agent tasks** (0.33× = 3× the effective budget)
3. **Budget model**: Pro = 100 Opus calls OR 300 Sonnet calls OR 909 Haiku calls per seat/month
4. **Pro+ is highly efficient for heavy usage**: $39/mo → 1,500 premium requests = 500 Opus OR 4,545 Haiku messages
5. **After quota**: fallback to GPT-4.1 (free, unlimited on paid plans) — plan for graceful degradation
6. **Key assignment**: 1 `ghu_*` token per agent (sticky, not round-robin) — quota is tracked per GitHub account, not per token

---

## Unresolved Questions

1. **Does `X-Initiator: agent` affect routing** to an internal "agentic" quota pool separate from the standard premium pool? No public documentation exists; would require controlled experiment (compare quota consumption with/without the header).
2. **Alternative endpoints** (`api.individual.githubcopilot.com`, `api.business.githubcopilot.com`) — clawd's docs mention these "may have different rate limits." Not documented officially; unknown whether they route to separate quota pools.
3. **Exact HTTP error code when premium requests exhausted AND model strictly requested** (e.g., explicit `"model": "claude-opus-4.6"` with zero budget remaining) — likely 429 with a quota-exhaustion message, but not explicitly documented. The soft-fallback behavior may only apply when using auto-model-selection.
4. **Copilot coding agent premium quota** is now tracked in a **dedicated SKU** ("Copilot coding agent premium requests") separate from regular "Copilot premium requests" (as of Nov 1, 2025). Whether API calls via `api.githubcopilot.com` count against the chat quota or the coding agent quota is unclear when `X-Initiator: agent` is set.
