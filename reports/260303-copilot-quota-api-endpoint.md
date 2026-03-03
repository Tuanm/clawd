# GitHub Copilot Premium Quota API Endpoint

**Date**: 2026-03-03  
**Status**: Confirmed via multiple independent implementations

---

## The Endpoint

```
GET https://api.github.com/copilot_internal/user
```

**Status**: Undocumented / internal — not in the official GitHub REST OpenAPI spec. Discovered via VS Code Copilot extension network traffic and used by multiple open-source tools.

---

## Auth Headers

Two equivalent forms (both accepted by GitHub's API for OAuth tokens):

```http
Authorization: token ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
or
```http
Authorization: Bearer ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Additional headers (recommended to avoid flagging)

```http
User-Agent: GitHub-Copilot-Usage-Tray
Accept: application/json
Content-Type: application/json
X-GitHub-Api-Version: 2025-04-01
```

The `ghu_` token is the **GitHub OAuth access token** — the same one obtained via device flow (`client_id: Iv1.b507a08c87ecfe98`). No Copilot bearer token needed for this endpoint (use the raw OAuth token, not the short-lived `copilot_internal/v2/token` bearer).

---

## Full Response Structure

**Business plan example** (real response, from LiteLLM issue #18242 / VS Code network inspection):

```json
{
  "access_type_sku": "copilot_standalone_seat_quota",
  "analytics_tracking_id": "ba3512a3a67ed982fef702231ac88430",
  "assigned_date": "2025-10-17T08:51:52+02:00",
  "can_signup_for_limited": false,
  "chat_enabled": true,
  "copilot_plan": "business",
  "organization_login_list": [],
  "organization_list": [],
  "quota_reset_date": "2026-01-01",
  "quota_reset_date_utc": "2026-01-01T00:00:00.000Z",
  "quota_snapshots": {
    "chat": {
      "entitlement": 0,
      "overage_count": 0,
      "overage_permitted": false,
      "percent_remaining": 100.0,
      "quota_id": "chat",
      "quota_remaining": 0.0,
      "remaining": 0,
      "unlimited": true,
      "timestamp_utc": "2025-12-19T10:48:12.942Z"
    },
    "completions": {
      "entitlement": 0,
      "overage_count": 0,
      "overage_permitted": false,
      "percent_remaining": 100.0,
      "quota_id": "completions",
      "quota_remaining": 0.0,
      "remaining": 0,
      "unlimited": true,
      "timestamp_utc": "2025-12-19T10:48:12.942Z"
    },
    "premium_interactions": {
      "entitlement": 300,
      "overage_count": 0,
      "overage_permitted": true,
      "percent_remaining": 31.166666666666664,
      "quota_id": "premium_interactions",
      "quota_remaining": 93.5,
      "remaining": 93,
      "unlimited": false,
      "timestamp_utc": "2025-12-19T10:48:12.942Z"
    }
  }
}
```

### Key quota fields

| Field | Meaning |
|---|---|
| `quota_snapshots.premium_interactions.entitlement` | Monthly allowance (e.g. 300 for Business) |
| `quota_snapshots.premium_interactions.remaining` | Integer requests left |
| `quota_snapshots.premium_interactions.quota_remaining` | Float version (fractional for multiplier models) |
| `quota_snapshots.premium_interactions.percent_remaining` | Float 0–100 |
| `quota_snapshots.premium_interactions.overage_count` | Requests used beyond entitlement |
| `quota_snapshots.premium_interactions.overage_permitted` | Whether overage is enabled for this account |
| `quota_snapshots.premium_interactions.unlimited` | `true` only for Enterprise with unlimited policy |
| `quota_snapshots.premium_interactions.timestamp_utc` | When the snapshot was captured |
| `quota_reset_date` | `YYYY-MM-DD` of next billing cycle reset |
| `quota_reset_date_utc` | ISO 8601 of reset |
| `copilot_plan` | `"free"` / `"pro"` / `"pro_plus"` / `"business"` / `"enterprise"` |

### Free plan variant
- `premium_interactions.entitlement: 50`, `unlimited: false`
- `completions.unlimited: true` (unlimited inline completions on Free)
- `chat.unlimited: true`

### Note on `quota_remaining` vs `remaining`
- `remaining` (int) = floor of requests left, used for display
- `quota_remaining` (float) = fractional remainder; relevant because models with multipliers (e.g. Claude Opus = 3×) can leave fractional units

---

## Does `copilot_internal/v2/token` Include Quota? 

**No.** The token endpoint returns only:
```json
{ "expires_at": 1700000000, "refresh_in": 1500, "token": "ghu_..." }
```
No quota fields. Use `/copilot_internal/user` instead.

---

## Response Headers

No quota-specific headers documented. The endpoint uses standard GitHub API rate limiting:
- `X-RateLimit-Limit: 5000` (requests per hour per authenticated user)
- `X-RateLimit-Remaining: 4999`
- `X-RateLimit-Reset: <unix timestamp>`

No `X-Copilot-Quota-*` or similar headers observed.

---

## Polling Rate

**Safe interval: 5 minutes** (confirmed by [estruyf/github-copilot-usage-tauri](https://github.com/estruyf/github-copilot-usage-tauri) — uses `setInterval(() => loadUsage(token), 5 * 60 * 1000)`).

**oh-my-posh** uses a 5-minute session cache for the same endpoint.

The quota values only update after a request consumes quota — polling faster than 1/min has no benefit and wastes standard API rate limit budget. The `timestamp_utc` field on each snapshot shows when it was last updated server-side.

---

## Minimal Working Call

```bash
curl -s https://api.github.com/copilot_internal/user \
  -H "Authorization: token ghu_YOUR_TOKEN_HERE" \
  -H "Accept: application/json" \
  -H "User-Agent: GitHub-Copilot-Usage-Tray" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
p = d['quota_snapshots']['premium_interactions']
print(f\"Plan: {d['copilot_plan']}\")
print(f\"Premium: {p['entitlement'] - p['remaining']}/{p['entitlement']} used ({100 - p['percent_remaining']:.1f}%)\")
print(f\"Resets: {d['quota_reset_date']}\")
"
```

---

## Sources

| Source | Type | Reliability |
|---|---|---|
| [estruyf/github-copilot-usage-tauri](https://github.com/estruyf/github-copilot-usage-tauri) `src-tauri/src/lib.rs` | Reference app with real calls | High |
| [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) `src/services/github/get-copilot-usage.ts` | Production proxy, 2680⭐ | High |
| [BerriAI/litellm#18242](https://github.com/BerriAI/litellm/issues/18242) | Real response body pasted from VS Code DevTools | High (primary source) |
| [JanDeDobbeleer/oh-my-posh#6997](https://github.com/JanDeDobbeleer/oh-my-posh/pull/6997) `src/segments/copilot.go` | Production segment implementation | High |
| GitHub OpenAPI spec (`github/rest-api-description`) | Official | Confirms endpoint is **NOT** in public spec |

---

## Unresolved Questions

1. **Free plan `copilot_plan` value**: Likely `"free"` but no confirmed real example found. The `entitlement: 50` is documented.
2. **Rate limit on the endpoint itself**: No evidence of a dedicated rate limit separate from standard 5000/hr. Unknown if aggressive polling triggers a separate quota.
3. **`access_type_sku` values**: Only `"copilot_standalone_seat_quota"` observed. Unknown what Free/Pro values look like.
4. **`organization_list` structure**: Always empty in observed examples; unclear what it contains for org-assigned seats.
