# Research Report: GitHub Copilot API — Image & Vision Capabilities

**Date:** 2026-03-03  
**Scope:** Programmatic use of `api.githubcopilot.com` — multimodal input, image generation/editing, model support, API format, rate limits

---

## Executive Summary

The GitHub Copilot API (`api.githubcopilot.com`) **does support multimodal vision inputs** (sending images to vision-capable models) via an OpenAI-compatible format, but this support is partially undocumented and primarily surfaces through the Extensions/agents pathway and the official GitHub Models API. **Image generation (text-to-image) and image editing are NOT available** — the Copilot catalog contains no image-generation models (no DALL·E, no GPT-Image-1). Vision/multimodal reading is supported on GPT-4o, GPT-5 series, Claude Sonnet/Opus series, and Gemini series. The official REST API schema in docs understates multimodal capability; community projects and feature flags confirm broader support.

---

## Key Findings

### 1. Vision / Multimodal Input (Sending Images to Models)

**✅ Supported — with caveats about which endpoint and format.**

**Two distinct API surfaces exist:**

| Surface | Endpoint | Status |
|---|---|---|
| **GitHub Models REST API** (official) | `https://models.github.ai/inference/chat/completions` | Documented `content` as `string` only — but underlying model capability exists |
| **Copilot Chat/Extensions API** (internal) | `https://api.githubcopilot.com/chat/completions` | Used by IDE plugins, github.com Chat, CLI — vision actively used here |

**Evidence for vision support:**

- GitHub.com source code (client-env JSON) includes feature flags `copilot_chat_vision_in_claude`, `copilot_chat_vision_preview_gate`, `copilot_chat_attach_multiple_images`, `copilot_chat_selection_attachments` — confirming vision is live in the production UI that calls `api.githubcopilot.com`.
- The **Copilot Extensions Preview SDK** (`@copilot-extensions/preview-sdk`) README shows `image_url` content type in the `prompt()` function API:
  ```js
  messages: [{
    role: "user",
    content: [
      [
        { type: "text", text: "What about this country?" },
        { type: "image_url", image_url: urlToImageOfFlagOfSpain }
      ]
    ]
  }]
  ```
  *(Source: https://github.com/copilot-extensions/preview-sdk.js README)*
- **CopilotX proxy** (community project) explicitly documents: *"Vision Support — Pass images through Responses API (auto-detected)"* and uses `api.githubcopilot.com` as the upstream. Source: https://pypi.org/project/copilotx/
- **Copilot CLI** (Oct 2025 changelog): Image recognition via `@`-mentioning image files, expanded in Nov 2025 to support paste/drag-and-drop.
- **Copilot Chat on github.com** (Apr 2025 changelog): Image upload/analysis officially launched for immersive mode, specifically named `gpt-4o` as the supported model at time of announcement.
  Source: https://github.blog/changelog/2025-04-02-copilot-chat-on-github-com-adds-support-for-images/

**Official docs acknowledged multimodal in model catalog:**
> "Some models prioritize speed and cost-efficiency, while others are optimized for accuracy, reasoning, or working with multimodal inputs (like images and code together)."
> — https://docs.github.com/en/copilot/reference/ai-models/supported-models

**Format used:**  
OpenAI-compatible `image_url` content array format in messages. Both URL-referenced images and base64-encoded images are expected to work (per OpenAI compatibility layer).

---

### 2. Image Generation (Text-to-Image)

**❌ NOT supported.**

The GitHub Copilot model catalog (as of 2026-03-03) contains **zero image-generation models**. No DALL·E 2/3, no GPT-Image-1, no Stable Diffusion, no Imagen. The full model list:

> GPT-4.1, GPT-5 mini, GPT-5.1, GPT-5.1-Codex, GPT-5.1-Codex-Mini, GPT-5.1-Codex-Max, GPT-5.2, GPT-5.2-Codex, GPT-5.3-Codex, Claude Haiku 4.5, Claude Opus 4.5/4.6, Claude Sonnet 4/4.5/4.6, Gemini 2.5 Pro, Gemini 3 Flash/Pro/3.1 Pro, Grok Code Fast 1, Raptor mini, Goldeneye

None of these generate images. Copilot is a code/text AI; image *generation* requires dedicated image generation models that GitHub has not added to the Copilot platform.

*Note: Microsoft Copilot (the consumer assistant) and Copilot Studio have image generation via Bing/Designer integration — but that is a completely different product from GitHub Copilot.*

---

### 3. Image Editing

**❌ NOT supported.**

Same reason as above — no image editing models (DALL·E edit endpoint, InstructPix2Pix, etc.) are in the catalog.

---

### 4. Vision-Capable Models Available

All major modern models in the catalog have vision capability at their underlying model level. Documented/implied support:

| Model | Vision Input | Notes |
|---|---|---|
| `gpt-4o` | ✅ Confirmed | Specifically named in Apr 2025 image launch changelog |
| GPT-5 series (5 mini, 5.1, 5.2, etc.) | ✅ (inherits OpenAI vision support) | All GPT-5 variants from OpenAI support vision |
| GPT-5.x-Codex series | ⚠️ Codex-optimized, vision likely supported but coding focus | |
| Claude Sonnet 4.5 / 4.6 | ✅ | Feature flag `copilot_chat_vision_in_claude` in github.com source |
| Claude Opus 4.5 / 4.6 | ✅ | Anthropic Claude 3+ and 4+ all have vision |
| Claude Haiku 4.5 | ✅ | Anthropic Claude Haiku 3+ has vision |
| Gemini 2.5 Pro | ✅ | Gemini natively multimodal |
| Gemini 3 Flash/Pro | ✅ | All Gemini 3 variants support vision |
| Grok Code Fast 1 | ⚠️ Unknown — xAI's Grok 2/3 have vision but "Code Fast" variant unclear | |

*Source: https://docs.github.com/en/copilot/reference/ai-models/supported-models*

---

### 5. API Format, Authentication, and Required Headers

**`api.githubcopilot.com` is OpenAI-compatible.** The Extensions SDK and community reverse-engineering confirm this.

**Chat Completions endpoint:**
```
POST https://api.githubcopilot.com/chat/completions
```

**Required headers (Extensions/programmatic use):**
```
Authorization: Bearer <copilot_jwt_token>
Content-Type: application/json
Copilot-Integration-Id: <your_extension_id>   # or "dev" for testing
```

**For GitHub Models API (official, documented):**
```
POST https://models.github.ai/inference/chat/completions
Authorization: Bearer <github_pat_with_models:read>
Content-Type: application/json
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

**Example vision request payload (OpenAI format):**
```json
{
  "model": "openai/gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "https://..." } }
      ]
    }
  ]
}
```

For base64:
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,<base64_data>"
  }
}
```

**Copilot JWT Token Acquisition:**  
The `api.githubcopilot.com` endpoint requires a short-lived Copilot JWT (not a GitHub PAT directly). The token is fetched by:
```
GET https://api.github.com/copilot_internal/v2/token
Authorization: Bearer <github_oauth_token_with_copilot_scope>
```
This is not officially documented as a public API. The GitHub Models API (models.github.ai) uses a standard GitHub PAT with `models:read` scope and is the **recommended official approach**.

---

### 6. Rate Limits

**No hard numbers published for image inputs specifically.** General Copilot rate limit structure:

- Rate limits are **service-level** and enforced dynamically — not a fixed per-hour number.
- **Premium request multipliers** per model (from docs):
  - GPT-4.1, GPT-5 mini: `0` (free, unlimited on paid plans)
  - Claude Haiku 4.5, Gemini 3 Flash: `0.33x`
  - Claude Sonnet 4.x, Gemini 2.5 Pro, GPT-5.1 series: `1x`
  - Claude Opus 4.5/4.6: `3x`
  - Claude Opus 4.6 fast mode (preview): `30x`
- Preview models have stricter limits than GA models.
- Vision requests likely count as premium requests at the model's standard multiplier — no special rate limit tier documented for images.
- No `X-RateLimit-*` headers are documented for the Copilot API (unlike GitHub REST API).

*Source: https://docs.github.com/en/copilot/reference/ai-models/supported-models, https://docs.github.com/en/copilot/concepts/rate-limits*

---

### 7. Official API vs Unofficial Access

**Two tiers of access:**

| | GitHub Models API | Copilot Extensions API |
|---|---|---|
| **Endpoint** | `models.github.ai/inference/` | `api.githubcopilot.com/` |
| **Auth** | GitHub PAT (`models:read` scope) | Copilot JWT (ephemeral token) |
| **Documentation** | Official, fully documented | Partially documented (Extensions only) |
| **Vision support** | Content schema shows `string` only in docs ⚠️ (underlying models support it) | Confirmed via feature flags + community proxy |
| **Image generation** | ❌ | ❌ |
| **Use case** | App developers building on GitHub | IDE extensions, Copilot Chat agents |
| **Responses API** | Not documented | Available (`/responses` endpoint) |

**Practical recommendation for developers**: Use the **GitHub Models REST API** (`models.github.ai`) with a PAT — it's the only officially documented and supported programmatic path. The `api.githubcopilot.com` path requires a Copilot subscription, an ephemeral token exchange, and has no official programmatic documentation outside the Extensions context.

---

## Source Summary

| Source | URL | Reliability |
|---|---|---|
| GitHub Copilot supported models | https://docs.github.com/en/copilot/reference/ai-models/supported-models | ✅ Official |
| GitHub Models REST API inference spec | https://docs.github.com/en/rest/models/inference | ✅ Official |
| Copilot rate limits | https://docs.github.com/en/copilot/concepts/rate-limits | ✅ Official |
| Copilot Chat image support launch | https://github.blog/changelog/2025-04-02-copilot-chat-on-github-com-adds-support-for-images/ | ✅ Official |
| Copilot CLI image support | https://github.blog/changelog/2025-10-03-github-copilot-cli-enhanced-model-selection-image-support-and-streamlined-ui/ | ✅ Official |
| Copilot Extensions Preview SDK (image_url example) | https://github.com/copilot-extensions/preview-sdk.js | ✅ Semi-official (GitHub org) |
| CopilotX proxy (vision confirmed on api.githubcopilot.com) | https://pypi.org/project/copilotx/ | ⚠️ Community |
| GitHub.com client-env feature flags (vision flags) | Source of github.com page | ⚠️ Observed |

---

## Unresolved Questions

1. **Does `models.github.ai` accept `image_url` content arrays despite docs only showing `string` content?** The official schema says string-only but underlying models support vision — likely a docs gap rather than a hard limitation. Needs empirical testing with a PAT.

2. **Which specific Copilot plan tiers allow vision inputs?** Image support was announced for github.com Chat (Apr 2025) but plan-level gating (Free vs Pro vs Business) not explicitly documented for programmatic use.

3. **Does `api.githubcopilot.com` support image URLs vs base64 only?** CopilotX mentions "auto-detected" via Responses API — unclear if chat completions endpoint passes image URLs to external CDNs or requires base64.

4. **Grok Code Fast 1 vision support?** xAI's Grok 3 has vision but the "Code Fast" variant's multimodal status is not documented in GitHub's docs.

5. **Any image generation models planned?** No public roadmap information found. GitHub has not announced DALL·E or GPT-Image-1 integration into the Copilot catalog.
