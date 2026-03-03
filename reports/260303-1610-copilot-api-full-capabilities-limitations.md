# Research Report: GitHub Copilot API — Full Capabilities & Limitations

**Date:** 2026-03-03 16:10 UTC  
**Scope:** Complete analysis of `api.githubcopilot.com` — endpoints, models, multimodal, image gen, auth, limitations  
**Sources:** 6 prior clawd reports (260303 series), codebase analysis (`client.ts`, `factory.ts`, `multimodal.ts`, `COPILOT-API.md`, `research-notes.md`), GitHub official docs, ericc-ch/copilot-api, nghyane/llm-mux, caozhiyuan/copilot-api, CopilotX proxy, Copilot Extensions SDK, GitHub Models REST API docs  
**Method:** Cross-referencing existing internal research + codebase reverse-engineering + official documentation

---

## Executive Summary

The GitHub Copilot API (`api.githubcopilot.com`) is an **OpenAI-compatible chat completions API** that provides access to ~25 text/code models from OpenAI, Anthropic, Google, xAI, and Microsoft. It supports **vision input** (sending images to models) but has **zero image generation capability** — no DALL-E, no GPT-Image-1, no Imagen, no image output endpoints. The API exposes primarily `/chat/completions` with undocumented `/responses` and `/v1/messages` paths. There is no `/images`, `/embeddings`, or `/models` endpoint on `api.githubcopilot.com`. Image generation in the clawd codebase routes through Gemini direct API or CPA — never through Copilot.

---

## 1. Endpoints

### Confirmed Endpoints on `api.githubcopilot.com`

| Endpoint | Method | Status | Evidence |
|----------|--------|--------|----------|
| `/chat/completions` | POST | ✅ **Primary, confirmed** | All community projects + clawd codebase + official Extensions SDK |
| `/responses` | POST | ⚠️ **Undocumented, exists** | CopilotX proxy docs mention "Responses API" auto-detection; quota mechanics report references it |
| `/v1/messages` | POST | ⚠️ **Undocumented, exists** | `X-Initiator` sent to this path per quota mechanics report; Anthropic-compatible format |

### NOT Available on `api.githubcopilot.com`

| Endpoint | Status | Evidence |
|----------|--------|----------|
| `/models` | ❌ **Not available** | No community project queries this; model list comes from GitHub docs/UI only |
| `/images/generations` | ❌ **Not available** | Zero evidence anywhere — no community project, no docs, no code references |
| `/images/edits` | ❌ **Not available** | Same as above |
| `/embeddings` | ❌ **Not available** | Not referenced anywhere in any source |
| `/audio/speech` | ❌ **Not available** | Not referenced |
| `/audio/transcriptions` | ❌ **Not available** | Not referenced |

### Alternative API Surface: `models.github.ai`

| Endpoint | Status |
|----------|--------|
| `models.github.ai/inference/chat/completions` | ✅ Official, documented |
| `models.github.ai/inference/` | ✅ Official REST API |

**Key difference:** `models.github.ai` uses a GitHub PAT with `models:read` scope. `api.githubcopilot.com` uses ephemeral Copilot bearer tokens from `api.github.com/copilot_internal/v2/token`. They serve the same models but have different auth, rate limits, and documentation levels.

### Internal/Supporting Endpoints (on `api.github.com`)

| Endpoint | Purpose |
|----------|---------|
| `api.github.com/copilot_internal/v2/token` | Exchange OAuth token for short-lived Copilot bearer (~25min TTL) |
| `api.github.com/copilot_internal/user` | Get premium quota usage, plan info, remaining requests |

---

## 2. Available Models (Complete List)

From official GitHub docs + codebase + community verification (as of March 2026):

### OpenAI Models
| Model ID | Type | Multiplier (paid) | Vision | Notes |
|----------|------|-------------------|--------|-------|
| `gpt-4o` | Chat | 0× (free) | ✅ Yes | First model with Copilot vision support (Apr 2025) |
| `gpt-4.1` | Chat | 0× (free) | ✅ Yes | Default free-tier workhorse |
| `gpt-5-mini` | Chat | 0× (free) | ✅ Yes | Lightweight, free |
| `gpt-5.1` | Chat | 1× | ✅ Yes | |
| `gpt-5.2` | Chat | 1× | ✅ Yes | |
| `gpt-5.1-codex` | Code | 1× | ⚠️ Likely | Coding-optimized |
| `gpt-5.1-codex-mini` | Code | 0.33× | ⚠️ Likely | Economy coding |
| `gpt-5.1-codex-max` | Code | 1× | ⚠️ Likely | Premium coding |
| `gpt-5.2-codex` | Code | 1× | ⚠️ Likely | |
| `gpt-5.3-codex` | Code | 1× | ⚠️ Likely | |

### Anthropic (Claude) Models
| Model ID | Type | Multiplier (paid) | Vision | Notes |
|----------|------|-------------------|--------|-------|
| `claude-haiku-4.5` | Chat | 0.33× | ✅ Yes | Best budget premium model |
| `claude-sonnet-4` | Chat | 1× | ✅ Yes | |
| `claude-sonnet-4.5` | Chat | 1× | ✅ Yes | |
| `claude-sonnet-4.6` | Chat | 1× (may change) | ✅ Yes | |
| `claude-opus-4.5` | Chat | 3× | ✅ Yes | |
| `claude-opus-4.6` | Chat | 3× | ✅ Yes | |
| `claude-opus-4.6` (fast mode) | Chat | **30×** | ✅ Yes | Preview — extreme cost |

### Google (Gemini) Models
| Model ID | Type | Multiplier (paid) | Vision | Notes |
|----------|------|-------------------|--------|-------|
| `gemini-2.5-pro` | Chat | 1× | ✅ Yes | |
| `gemini-3-flash` | Chat | 0.33× | ✅ Yes | |
| `gemini-3-pro` | Chat | 1× | ✅ Yes | |
| `gemini-3.1-pro` | Chat | 1× | ✅ Yes | |

### xAI (Grok) Models
| Model ID | Type | Multiplier (paid) | Vision | Notes |
|----------|------|-------------------|--------|-------|
| `grok-code-fast-1` | Code | 0.25× | ⚠️ Unknown | Code-focused variant |

### Microsoft/Other Models
| Model ID | Type | Multiplier (paid) | Vision | Notes |
|----------|------|-------------------|--------|-------|
| `raptor-mini` | Chat | 0× (free) | ⚠️ Unknown | Preview; free on paid plans |
| `goldeneye` | Chat | N/A (Free plan only) | ⚠️ Unknown | Copilot Free tier only |

### Models NOT in Copilot Catalog

| Model | Status | Notes |
|-------|--------|-------|
| `o1-preview`, `o1-mini` | ❌ Not available | OpenAI reasoning models — not in Copilot catalog |
| `o3`, `o3-mini`, `o4-mini` | ❌ Not available | Not in Copilot model list |
| `deepseek-r1`, `MAI-DS-R1` | ❌ Not in Copilot | Available on GitHub Models (`models.github.ai`) only |
| `dall-e-2`, `dall-e-3` | ❌ Not available | Image generation — not in Copilot |
| `gpt-image-1` | ❌ Not available | Image generation — not in Copilot |
| `imagen-3`, `imagen-4` | ❌ Not available | Google image generation — not in Copilot |
| `stable-diffusion-*` | ❌ Not available | Not in any GitHub API |
| `mistral-*` | ❌ Not in Copilot | Some Mistral on GitHub Models, not Copilot |

---

## 3. Multimodal Capabilities

### Vision Input (Sending Images TO Models) — ✅ SUPPORTED

**Format:** OpenAI-compatible `image_url` content array in messages:
```json
{
  "model": "gpt-4.1",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What's in this image?" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,<base64>" } }
    ]
  }]
}
```

**Evidence:**
- Feature flags in github.com source: `copilot_chat_vision_in_claude`, `copilot_chat_vision_preview_gate`, `copilot_chat_attach_multiple_images`
- Copilot Extensions Preview SDK shows `image_url` in message content
- CopilotX proxy confirms vision works via `api.githubcopilot.com`
- clawd codebase `multimodal.ts:527-586` implements Copilot vision analysis successfully using `image_url` content type
- Both base64 and URL-referenced images expected to work (per OpenAI compatibility)

**Supported models for vision input:**
- ✅ GPT-4o, GPT-4.1, GPT-5 series (all natively multimodal)
- ✅ Claude Sonnet 4.x, Claude Opus 4.x, Claude Haiku 4.5 (all have vision)
- ✅ Gemini 2.5 Pro, Gemini 3.x series (natively multimodal)
- ⚠️ Grok Code Fast 1 — unknown
- ⚠️ Raptor mini, Goldeneye — unknown

### Image Output (Generating Images FROM Models) — ❌ NOT SUPPORTED

**No image generation capability exists on the Copilot API. Period.**

- No `/images/generations` endpoint
- No `/images/edits` endpoint
- No model in the catalog produces images
- Gemini models accessed through Copilot lose their native image generation capability (Copilot proxies only the chat completions interface, not Gemini's `generateContent` with `responseModalities: ["IMAGE"]`)
- No DALL-E, GPT-Image-1, or Imagen model is available

**This is the single most important limitation vs direct provider access.**

### Content Types Supported

| Direction | Type | Supported |
|-----------|------|-----------|
| Input → Model | Text | ✅ |
| Input → Model | Image (base64) | ✅ |
| Input → Model | Image (URL) | ⚠️ Likely (per OpenAI compat) |
| Input → Model | Audio | ❌ |
| Input → Model | Video | ❌ |
| Model → Output | Text | ✅ |
| Model → Output | Tool calls | ✅ |
| Model → Output | Image | ❌ |
| Model → Output | Audio | ❌ |

---

## 4. Limitations vs Direct Provider Access

### Critical Capability Gaps

| Capability | Direct Provider | Via Copilot API | Gap |
|-----------|----------------|-----------------|-----|
| **Image generation** (DALL-E, Imagen) | ✅ OpenAI `/images`, Gemini `generateContent` | ❌ None | **Total gap** |
| **Native Gemini image gen** (Gemini 2.0 Flash+) | ✅ `responseModalities: ["IMAGE"]` | ❌ Only text output | Copilot strips image output capability |
| **GPT-Image-1** | ✅ OpenAI Images API | ❌ Not in catalog | Not available |
| **Audio input/output** | ✅ OpenAI Whisper, TTS, Gemini audio | ❌ None | Not available |
| **Embeddings** | ✅ OpenAI/Google embeddings APIs | ❌ No endpoint | Not available |
| **o1/o3/o4 reasoning** | ✅ Direct OpenAI API | ❌ Not in catalog | Not available through Copilot |
| **DeepSeek-R1** | ⚠️ GitHub Models only | ❌ Not in Copilot | Only on `models.github.ai` |
| **Fine-tuning** | ✅ Provider APIs | ❌ None | Not available |
| **Batch API** | ✅ OpenAI Batch API | ❌ None | Not available |
| **Custom max_tokens** | ✅ Provider-defined | ⚠️ Capped (8K in/4K out on Pro) | Reduced context on some tiers |

### What Copilot Adds (vs direct)

| Feature | Benefit |
|---------|---------|
| Single API for multiple providers | Access Claude, GPT, Gemini through one endpoint |
| Included models (0× cost) | GPT-4.1, GPT-5 mini, GPT-4o = unlimited on paid plans |
| Unified billing | One subscription covers all models |
| Tool calling | Consistent OpenAI-format tool calling across all providers |

---

## 5. Authentication & Headers

### Token Acquisition Flow

```
1. GitHub OAuth token (ghu_*/gho_*/github_pat_*) with `copilot` scope
   ↓
2. POST api.github.com/copilot_internal/v2/token
   Authorization: Bearer <oauth_token>
   ↓
3. Receive short-lived Copilot JWT (~25 min TTL)
   ↓
4. Use JWT for api.githubcopilot.com requests
   Authorization: Bearer <copilot_jwt>
```

### Required Headers

```http
POST /chat/completions HTTP/2
Host: api.githubcopilot.com
Authorization: Bearer <copilot_jwt_token>
Content-Type: application/json
Accept: application/json
Copilot-Integration-Id: vscode-chat          # or copilot-developer-cli
X-GitHub-Api-Version: 2025-05-01
X-Interaction-Id: <UUID per turn>
User-Agent: GitHubCopilotChat/0.26.7         # mimic official client
```

### Optional/Proprietary Headers

| Header | Values | Effect |
|--------|--------|--------|
| `X-Initiator` | `user` / `agent` | `user` = counts premium request; `agent` = free (tool continuations) |
| `Editor-Version` | `vscode/1.99.0` | Fingerprinting — use realistic value |
| `Openai-Intent` | `conversation-panel` | Used by official client |
| `vscode-machineid` | 64 hex chars | Session identifier; aids fingerprint matching |
| `vscode-sessionid` | UUID+timestamp | VSCode session; aids fingerprint matching |

### Token Types

| Prefix | Type | Copilot API |
|--------|------|-------------|
| `gho_*` | OAuth token | ✅ Works |
| `ghu_*` | User token | ✅ Works |
| `github_pat_*` | Fine-grained PAT | ✅ Works |
| `ghp_*` | Classic PAT | ❌ Not supported |

---

## 6. Undocumented/Beta Features

### Confirmed Undocumented

| Feature | Status | Evidence |
|---------|--------|----------|
| `/responses` endpoint | ⚠️ Exists, undocumented | Referenced in quota mechanics report; CopilotX uses it |
| `/v1/messages` endpoint | ⚠️ Exists, undocumented | Referenced in X-Initiator docs; Anthropic-format path |
| `X-Initiator: agent` = 0 premium cost | ✅ Confirmed, undocumented publicly | GitHub docs repo source + community verification |
| Vision in Claude models | ✅ Works, feature-flagged | `copilot_chat_vision_in_claude` flag |
| Multiple image attachments | ✅ Works, feature-flagged | `copilot_chat_attach_multiple_images` flag |
| Agent mode rate limit error code | ⚠️ `agent_mode_limit_exceeded` | Distinct from quota exhaustion |

### NOT Found (Despite Investigation)

| Feature | Status |
|---------|--------|
| Image generation beta | ❌ No evidence of any beta/preview |
| Imagen integration | ❌ Not referenced anywhere |
| DALL-E/GPT-Image-1 integration | ❌ Not referenced anywhere |
| Audio/video processing | ❌ Not referenced anywhere |
| Streaming images in responses | ❌ Not referenced anywhere |

---

## 7. Premium Requests & Model Economics

### Plan Allowances

| Plan | Price | Premium/Month |
|------|-------|---------------|
| Free | $0 | 50 |
| Pro | $10/mo | 300 |
| Pro+ | $39/mo | 1,500 |
| Business | $19/seat/mo | 300/user |
| Enterprise | $39/seat/mo | 1,000/user |

### Multiplier Tiers

| Tier | Multiplier | Models | Effective requests (Pro 300) |
|------|-----------|--------|------------------------------|
| Free | 0× | GPT-4.1, GPT-4o, GPT-5 mini, Raptor mini | ∞ (unlimited) |
| Economy | 0.25-0.33× | Claude Haiku 4.5, Gemini 3 Flash, Grok Code Fast 1 | ~900-1,200 |
| Standard | 1× | Claude Sonnet 4.x, Gemini 2.5/3 Pro, GPT-5.x | 300 |
| Premium | 3× | Claude Opus 4.5/4.6 | 100 |
| Ultra | 30× | Claude Opus 4.6 fast mode (preview) | 10 |

### Overage: $0.04/request at 1× multiplier

---

## 8. Can You Access Imagen 3 or DALL-E Through Copilot?

**No. Definitively no.**

- **DALL-E 2/3**: Not in Copilot model catalog. Not available on `api.githubcopilot.com`. Would require OpenAI's dedicated `/images/generations` endpoint which Copilot doesn't expose.
- **GPT-Image-1**: Not in Copilot model catalog. Same issue.
- **Imagen 3/4**: Not in Copilot catalog. Google's image generation requires Gemini API's `generateContent` with `responseModalities: ["IMAGE"]` or dedicated Imagen endpoint — neither is proxied by Copilot.
- **Via Gemini models in Copilot**: Gemini 2.5 Pro, 3 Flash, 3 Pro are available in Copilot for TEXT completion. Their image generation capabilities are NOT exposed because Copilot only proxies the chat completions interface (text in → text out).

**For image generation in clawd:** The codebase correctly uses direct Gemini API (`generativelanguage.googleapis.com`) or CPA fallback — never Copilot.

---

## 9. Relationship: Copilot API vs GitHub Models API

| Dimension | `api.githubcopilot.com` | `models.github.ai` |
|-----------|------------------------|---------------------|
| Auth | Copilot JWT (ephemeral, from token exchange) | GitHub PAT (`models:read`) |
| Documentation | Undocumented (internal/Extensions only) | Officially documented REST API |
| Model catalog | ~25 text/code models | Larger — includes DeepSeek, Mistral, etc. |
| Image gen models | ❌ None | ❌ None (also no image gen) |
| Rate limits | Premium requests/month + service-level | Per-minute + per-day hard caps |
| Billing | Copilot subscription (included models free) | Free tier + paid tiers |
| Use case | IDE plugins, Copilot Chat, CLI, Extensions | Developer apps, prototyping |
| Format | OpenAI-compatible | OpenAI-compatible |
| Responses API | ⚠️ Exists undocumented | Not documented |

**Neither API has image generation.** GitHub Models (`models.github.ai`) also does not expose DALL-E, Imagen, or any image generation endpoint.

---

## Summary: What's Actually Available NOW

| Capability | Status |
|-----------|--------|
| Text chat completions | ✅ Full support, 25+ models |
| Streaming SSE | ✅ Full support |
| Tool/function calling | ✅ OpenAI-compatible format |
| Vision input (images → model) | ✅ Works on GPT-4o+, Claude 4.x+, Gemini |
| Multiple image attachments | ✅ Feature-flagged, works |
| Image GENERATION | ❌ **Not available at all** |
| Image editing | ❌ Not available |
| Audio processing | ❌ Not available |
| Video processing | ❌ Not available |
| Embeddings | ❌ Not available |
| Reasoning models (o1/o3/o4) | ❌ Not in Copilot catalog |

---

## Unresolved Questions

1. **Does `models.github.ai` accept `image_url` content arrays?** Official docs show `string`-only content, but underlying models support vision. Needs empirical test with PAT.
2. **Does Copilot support image URLs (not just base64)?** CopilotX mentions "auto-detected" but unclear for `/chat/completions` path.
3. **Will GitHub add image generation models?** No public roadmap. Microsoft Copilot (consumer) has DALL-E via Bing; GitHub Copilot doesn't share that integration.
4. **Exact behavior of `/responses` endpoint?** Undocumented; likely mirrors OpenAI's Responses API format. No detailed testing available.
5. **Grok Code Fast 1 vision support?** xAI Grok 3 has vision, but the "Code Fast" variant's multimodal status is not documented by GitHub.
6. **Raptor mini and Goldeneye capabilities?** No public documentation on these Microsoft models' multimodal support.
