# Research Report: Gemini Image Generation API Capabilities

**Date:** 2026-03-03  
**Scope:** Gemini native image generation — models, API formats, proxy compatibility, costs, quality comparison

---

## Executive Summary

Google Gemini offers **two distinct image generation pathways**: (1) **Nano Banana** — native image generation via `generateContent()` endpoint on Gemini chat models (gemini-2.5-flash-image, gemini-3-pro-image-preview), and (2) **Imagen 4** — dedicated image generation via `generateImages()` endpoint. Both use the Google AI Studio REST API (`generativelanguage.googleapis.com/v1beta`). **Image generation does NOT work through OpenAI-compatible proxies** (GitHub Copilot, standard `/v1/chat/completions` proxies) because the response format (`inlineData` with base64 image bytes) is fundamentally incompatible with OpenAI's response schema, and the critical `response_modalities: ["IMAGE"]` parameter has no OpenAI equivalent. A CPA (CLIProxyAPI) proxy with explicit Gemini image support CAN work if it translates between formats.

---

## 1. Models Supporting Native Image Generation

### Nano Banana (Gemini Native — via `generateContent`)

| Model | Quality | Speed | Status | Notes |
|-------|---------|-------|--------|-------|
| `gemini-2.5-flash-image` | ⭐⭐⭐⭐ | Fast (5-10s) | Stable | **Recommended default**. Multi-turn chat support, editing |
| `gemini-3-pro-image-preview` | ⭐⭐⭐⭐⭐ | Medium | Preview | 4K text rendering, thinking mode, search grounding, up to 14 ref images |

**Legacy (deprecated):** `gemini-2.0-flash-preview-image-generation` — smaller context, superseded by 2.5 Flash Image.

### Imagen 4 (Dedicated — via `generateImages`)

| Model | Quality | Speed | Notes |
|-------|---------|-------|-------|
| `imagen-4.0-generate-001` | High | Medium (5-10s) | Standard. 1-4 images/request |
| `imagen-4.0-ultra-generate-001` | Ultra | Slow (15-25s) | Highest quality |
| `imagen-4.0-fast-generate-001` | Good | Fast (2-5s) | Bulk generation, no `imageSize` param |

### Non-Image-Generation Models

`gemini-2.5-pro`, `gemini-2.5-flash` (without `-image` suffix), `gemini-3-flash` — these are text/vision-only. They can **analyze** images but **cannot generate** them. The `-image` suffix models are specifically fine-tuned for generation.

---

## 2. API Format for Image Generation

### Path A: Nano Banana (via `generateContent`) — RECOMMENDED

**Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}`

**Request:**
```json
{
  "contents": [{ "parts": [{ "text": "A sunset over mountains" }] }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
      "aspectRatio": "16:9",
      "imageSize": "2K"
    }
  }
}
```

**Response:**
```json
{
  "candidates": [{
    "content": {
      "parts": [{
        "inlineData": {
          "mimeType": "image/png",
          "data": "<base64-encoded-PNG-bytes>"
        }
      }]
    }
  }]
}
```

**Key parameters:**
- `responseModalities`: **MUST** be `["IMAGE"]` or `["TEXT", "IMAGE"]` (uppercase required)
- `imageConfig.aspectRatio`: `"1:1"`, `"2:3"`, `"3:2"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`
- `imageConfig.imageSize`: `"1K"`, `"2K"`, `"4K"` (uppercase K required; not all models support all sizes)

### Path B: Imagen 4 (via `generateImages`) — SEPARATE ENDPOINT

**Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predict` (or via Python SDK `client.models.generate_images()`)

**Python SDK:**
```python
response = client.models.generate_images(
    model='imagen-4.0-generate-001',
    prompt='Professional product photo',
    config=types.GenerateImagesConfig(
        numberOfImages=1,      # camelCase (1-4)
        aspectRatio='16:9',    # camelCase
        imageSize='1K'         # Standard/Ultra only
    )
)
# Access: response.generated_images[0].image.image_bytes
```

**NOT** through chat completions. Completely separate API method.

---

## 3. OpenAI-Compatible Proxy Behavior — Image Generation is STRIPPED

### Why it doesn't work through standard proxies

| Issue | Detail |
|-------|--------|
| **No `responseModalities` equivalent** | OpenAI `/v1/chat/completions` has no parameter to request image output from a chat model |
| **Response format mismatch** | Gemini returns `inlineData.data` (base64 in parts array). OpenAI returns `message.content` (string). No standard translation exists. |
| **Model name mapping** | Proxies typically map `gemini-2.5-pro` → Gemini Pro, but `-image` model variants may not be exposed |
| **`generationConfig` not forwarded** | Standard OpenAI proxy format has no field for Gemini's `generationConfig.responseModalities` |

### GitHub Copilot specifically

Per prior research: **GitHub Copilot's model catalog contains zero image-generation models**. Even though it offers `gemini-2.5-pro` and `gemini-3-flash`, these are text/code models. The image-generation variants (`gemini-2.5-flash-image`, `gemini-3-pro-image-preview`) are NOT in the catalog. Image generation through `api.githubcopilot.com` is **impossible**.

### CPA (CLIProxyAPI) — WORKS with custom translation

The codebase shows a working CPA implementation that proxies image generation:

```typescript
// CPA request (OpenAI-compatible with extensions)
POST {cpa.baseUrl}/chat/completions
{
  "model": "gemini-3.1-flash-image",
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": prompt }] }],
  "modalities": ["text", "image"]  // Non-standard OpenAI extension
}
```

**CPA response format:**
```json
{
  "choices": [{
    "message": {
      "content": null,
      "images": [{                           // Non-standard extension
        "image_url": {
          "url": "data:image/png;base64,..."  // Data URI
        }
      }]
    }
  }]
}
```

This works because CPA is specifically designed to translate between Gemini's native format and an extended OpenAI-like format. Generic OpenAI proxies (LiteLLM, etc.) may or may not support this — most don't for image generation.

---

## 4. Response Format — Inline Base64

Gemini **always** returns generated images as inline base64 data. There are NO URLs.

```
candidates[0].content.parts[i].inlineData = {
  mimeType: "image/png",   // Always PNG for generated images
  data: "<base64-string>"  // Full image bytes, base64-encoded
}
```

- No CDN URL, no temporary link, no signed URL
- Images must be decoded client-side from base64
- Typical generated image: ~500KB-2MB base64 (depending on resolution)
- SynthID watermark embedded in all generated images

---

## 5. Multimodal Output — Text + Image in Same Response

**YES**, Gemini can generate both text and images in a single response.

**Request:**
```json
{
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

**Response parts array will contain mixed types:**
```json
{
  "candidates": [{
    "content": {
      "parts": [
        { "text": "Here's the mountain scene I created:" },
        { "inlineData": { "mimeType": "image/png", "data": "..." } },
        { "text": "I used warm sunset tones..." }
      ]
    }
  }]
}
```

**Multi-turn chat refinement** is supported:
```python
chat = client.chats.create(
    model='gemini-2.5-flash-image',
    config=types.GenerateContentConfig(response_modalities=['TEXT', 'IMAGE'])
)
r1 = chat.send_message('Create a logo for coffee brand "Brew"')
r2 = chat.send_message('Make the text bolder')  # Refines previous image
r3 = chat.send_message('Change to warm earth tones')
```

**Image editing** also works through this flow — send an image + instruction as input, get modified image as output.

---

## 6. Access Paths — Google AI Studio vs Vertex AI vs Proxy

| Path | Image Gen Support | Endpoint | Auth | Notes |
|------|-------------------|----------|------|-------|
| **Google AI Studio (REST)** | ✅ Full | `generativelanguage.googleapis.com/v1beta` | API key (`?key=`) | Recommended. Free tier + paid. All models. |
| **Google AI Python SDK** | ✅ Full | Same REST underneath | API key via `genai.Client(api_key=)` | Easiest DX. `generate_content()` + `generate_images()` |
| **Vertex AI** | ✅ Full | `{region}-aiplatform.googleapis.com` | OAuth2 / service account | Enterprise. Higher quotas. Same models. |
| **GitHub Copilot** | ❌ None | `api.githubcopilot.com` | Copilot JWT | No image-gen models in catalog |
| **GitHub Models** | ❌ None | `models.github.ai` | GitHub PAT | No image-gen models |
| **CPA proxy** | ✅ With translation | Custom base URL | Bearer token | Requires proxy with Gemini image support |
| **LiteLLM** | ⚠️ Partial | Custom | Varies | May support `response_format` passthrough — untested for image gen |
| **OpenRouter** | ⚠️ Partial | `openrouter.ai/api/v1` | Bearer token | Lists some Gemini models, image gen support unclear |

**Bottom line:** For image generation, use **Google AI Studio API directly** or the **Python SDK**. No standard third-party proxy reliably supports Gemini's image generation.

---

## 7. Special Parameters Required

### Critical (generation fails without these)

| Parameter | Location | Required Value | Notes |
|-----------|----------|---------------|-------|
| `responseModalities` | `generationConfig` | `["IMAGE"]` or `["TEXT", "IMAGE"]` | **MUST be uppercase**. Without this, model returns text only. |

### Optional but important

| Parameter | Location | Values | Default |
|-----------|----------|--------|---------|
| `imageConfig.aspectRatio` | `generationConfig.imageConfig` | `"1:1"`, `"16:9"`, etc. | `"1:1"` |
| `imageConfig.imageSize` | `generationConfig.imageConfig` | `"1K"`, `"2K"`, `"4K"` | Model-dependent. **Not all models support this.** |
| `safety_settings` | Top-level | Array of category+threshold | Moderate blocking default |

### Gotchas

1. `responseModalities` values MUST be uppercase: `"IMAGE"` not `"image"` not `"Image"`
2. `imageSize` must have uppercase K: `"2K"` not `"2k"`
3. `aspectRatio` inside Imagen 4 is camelCase; inside Nano Banana `imageConfig` it's also camelCase via REST (Python SDK uses snake_case `aspect_ratio`)
4. Imagen 4 Fast model does NOT support `imageSize` parameter
5. `imageConfig` must be nested — passing `aspect_ratio` directly to `generationConfig` throws `extra_forbidden` error

---

## 8. Rate Limits and Costs

### Google AI Studio (Free Tier)

| Model | RPM | RPD | Notes |
|-------|-----|-----|-------|
| `gemini-2.5-flash-image` | 10 | 50 | Conservative free tier |
| Imagen 4 models | 10 | 50 | Similar free limits |
| `gemini-3-pro-image-preview` | 5 | 25 | Preview = stricter |

### Google AI Studio (Paid / Pay-as-you-go)

| Model | Cost | Unit |
|-------|------|------|
| `gemini-2.5-flash-image` | ~$1/1M input tokens + 1,290 tokens per image output | Per image ≈ **$0.0013** |
| `gemini-3-pro-image-preview` | ~$2/1M input + $0.134/image | Resolution-dependent |
| `imagen-4.0-generate-001` | ~$0.02/image | Estimated |
| `imagen-4.0-ultra-generate-001` | ~$0.04/image | Estimated |
| `imagen-4.0-fast-generate-001` | ~$0.01/image | Estimated |

### Vertex AI (Enterprise)

- Higher RPM/RPD (configurable quotas)
- Same per-image pricing
- SLA-backed

### Codebase Daily Limit

The clawd codebase implements a local quota tracker (50 images/day default, configurable via `~/.clawd/config.json`):
```json
{ "quotas": { "daily_image_limit": 50 } }
```
Resets at midnight Pacific Time. Set to 0 to disable.

---

## 9. Quality Comparison: Gemini vs DALL-E 3 vs Stable Diffusion

| Dimension | Gemini (Nano Banana Flash) | Gemini (Nano Banana Pro) | DALL-E 3 | SD 3.5 / SDXL |
|-----------|---------------------------|-------------------------|----------|----------------|
| **Photorealism** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Text in images** | ⭐⭐⭐ (25 char limit) | ⭐⭐⭐⭐⭐ (4K text) | ⭐⭐⭐⭐ | ⭐⭐ |
| **Prompt adherence** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ (thinking mode) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Speed** | 🚀 5-10s | 💡 10-20s | 💡 10-20s | 🚀 2-5s (local GPU) |
| **Editing support** | ✅ Native (send image+instruction) | ✅ Native | ❌ (separate DALL-E 2 edit API) | ✅ (img2img/inpaint) |
| **Multi-turn refinement** | ✅ Chat-based | ✅ Chat-based | ❌ | ❌ |
| **Cost per image** | ~$0.001 | ~$0.13 | ~$0.04-0.08 | Free (local) / $0.002 (API) |
| **Max resolution** | 4K | 4K | 1024×1792 | Configurable |
| **Multi-image input** | ~3-5 refs | Up to 14 refs | ❌ | ✅ (ControlNet) |
| **Self-hosted** | ❌ | ❌ | ❌ | ✅ |
| **Watermark** | SynthID (invisible) | SynthID | Metadata | None (local) |

### Key differentiators for Gemini

1. **Chat-based refinement** — unique advantage. No other API allows iterative "make the sky bluer" refinement within a conversation.
2. **Multimodal I/O in same call** — can analyze uploaded images AND generate new ones in same conversation.
3. **Cost** — Flash Image at ~$0.001/image is 40x cheaper than DALL-E 3.
4. **Image editing as a first-class citizen** — send image + instruction, get edited image back. No separate API.

### Where Gemini falls short

1. **Censorship** — more aggressive safety filters than DALL-E 3 or SD. Will block many creative/artistic prompts.
2. **No batch generation** — Nano Banana generates 1 image per request (Imagen 4 does 1-4).
3. **No fine-tuning** — can't train custom models (SD can via LoRA/DreamBooth).
4. **No self-hosting** — API-only (SD can run locally).

---

## Practical Integration Examples

### Direct Gemini API (fetch/curl)

```bash
# Generate an image via curl
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "A serene mountain lake at sunrise"}]}],
    "generationConfig": {
      "responseModalities": ["IMAGE"],
      "imageConfig": {"aspectRatio": "16:9"}
    }
  }' | jq -r '.candidates[0].content.parts[0].inlineData.data' | base64 -d > output.png
```

### Python SDK

```python
from google import genai
from google.genai import types
import os

client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))

# Generate image
response = client.models.generate_content(
    model='gemini-2.5-flash-image',
    contents='A cyberpunk city at night',
    config=types.GenerateContentConfig(
        response_modalities=['IMAGE'],
        image_config=types.ImageConfig(aspect_ratio='16:9')
    )
)

# Save
for part in response.candidates[0].content.parts:
    if part.inline_data:
        with open('output.png', 'wb') as f:
            f.write(part.inline_data.data)
```

### TypeScript (from codebase — direct fetch)

```typescript
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`;

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
    },
  }),
});

const data = await response.json();
const imageBase64 = data.candidates[0].content.parts[0].inlineData.data;
const mimeType = data.candidates[0].content.parts[0].inlineData.mimeType;
// Write Buffer.from(imageBase64, 'base64') to file
```

---

## Decision Matrix: When to Use What

| Scenario | Recommendation |
|----------|---------------|
| Quick image gen in chat app | `gemini-2.5-flash-image` via `generateContent` |
| Production marketing assets | `imagen-4.0-ultra-generate-001` via `generateImages` |
| Image editing (modify existing) | `gemini-2.5-flash-image` — send image + instruction |
| Text-heavy images (posters, banners) | `gemini-3-pro-image-preview` (4K text rendering) |
| Through GitHub Copilot proxy | **NOT POSSIBLE** — use direct Gemini API |
| Through custom OpenAI proxy | Only if proxy supports `modalities` extension (CPA) |
| Bulk generation (100+ images) | `imagen-4.0-fast-generate-001` (cheapest + fastest) |
| Chat-based iterative refinement | `gemini-2.5-flash-image` with multi-turn chat |
| Self-hosted / air-gapped | Use Stable Diffusion instead — Gemini is API-only |

---

## Unresolved Questions

1. **LiteLLM passthrough**: Does LiteLLM's Gemini provider forward `response_modalities` to the native API? Their docs mention Gemini support but image generation specifically is undocumented.
2. **OpenRouter Gemini image models**: OpenRouter lists some Gemini models — unclear if image-generation variants are available or if `responseModalities` is forwarded.
3. **Vertex AI vs AI Studio rate limit specifics**: Exact RPM/RPD numbers for paid Vertex AI tiers not publicly documented in detail.
4. **Gemini 2.0 Flash image gen**: The reference mentions `gemini-2.0-flash-preview-image-generation` as deprecated — but some community examples still reference Gemini 2.0 Flash for image generation. Unclear if any 2.0 model still works.
5. **SynthID detection**: Can SynthID watermark be detected programmatically by third parties, or only by Google?

---

## Sources

| Source | Type | Reliability |
|--------|------|------------|
| `$HOME/.claude/skills/ai-multimodal/references/image-generation.md` | Local reference (skill) | ✅ Authoritative (maintained) |
| `src/server/multimodal.ts` | Codebase implementation | ✅ Working code |
| `docs/architecture.md` | Codebase architecture | ✅ Internal docs |
| `reports/260303-0523-github-copilot-api-image-capabilities.md` | Prior research | ✅ Cross-referenced |
| [Google AI Gemini API Docs](https://ai.google.dev/gemini-api/docs/) | Official | ✅ |
| [Google AI Pricing](https://ai.google.dev/pricing) | Official | ✅ |
