# Research Report: GitHub Copilot API — Image Generation Capabilities

**Date:** 2026-03-03  
**Scope:** Whether GitHub Copilot API supports image generation through multimodal models (Gemini, GPT-4o, etc.)

---

## Executive Summary

**GitHub Copilot API (`api.githubcopilot.com`) does NOT support image generation.** This is a fundamental architectural limitation, not a missing endpoint. The Copilot API proxies to LLM providers' chat completions endpoints but strips/ignores image-output capabilities. Gemini models (2.5 Pro, 3 Flash/Pro) accessible through Copilot are text-and-code-only—their native image generation (available on Google AI Studio) does not carry through the Copilot proxy. No DALL-E, GPT-Image-1, or Imagen models exist in the Copilot catalog. Vision **input** (sending images to models) works; image **output** does not.

---

## Detailed Findings

### 1. Image Generation Endpoints — Do They Exist?

**❌ No `/v1/images/generations` or equivalent endpoint exists.**

The Copilot API exposes exactly one inference endpoint:
```
POST https://api.githubcopilot.com/chat/completions
```

There is no:
- `/v1/images/generations` (OpenAI DALL-E style)
- `/images/edit` 
- `/responses` with image modality output
- Any image generation endpoint whatsoever

**Evidence:**
- The `CopilotClient` in this codebase (`src/agent/src/api/client.ts:192`) hardcodes `apiPath = "/chat/completions"` as the sole endpoint.
- The official Copilot Extensions Preview SDK (`@copilot-extensions/preview-sdk`) defaults to `https://api.githubcopilot.com/chat/completions` and has no image generation functions.
- Response types in both the SDK and this codebase define `content: string` — no image content blocks in responses.

### 2. Gemini Models Through Copilot — Native Image Gen?

**❌ Gemini's native image generation does NOT carry over to Copilot.**

**What Google AI Studio Gemini can do directly:**
- Gemini 2.0 Flash, 2.5 Flash, 3.1 Flash: native image generation via `responseModalities: ["IMAGE"]` in the `generationConfig`
- Uses `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `imageConfig` parameters
- Returns `inlineData` with `mimeType` + base64 `data` in response parts

**What Copilot's proxy does:**
- Copilot routes Gemini requests through Vertex AI on GCP (per model-hosting docs)
- The proxy uses OpenAI-compatible chat completions format, NOT Google's native `generateContent` API
- No `generationConfig`, `responseModalities`, or `imageConfig` parameters are supported in the OpenAI-compatible schema
- The `CompletionResponse` type (`src/agent/src/api/client.ts:57-71`) only supports `message.content: string` — no `inlineData` or image parts

**This codebase confirms the architecture gap:** `src/server/multimodal.ts` implements image generation via *direct* Gemini API calls (`generativelanguage.googleapis.com`), completely bypassing Copilot:

```typescript
// Line 29-32: Direct Gemini API, NOT Copilot
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_IMAGE_GEN_MODEL = "gemini-3.1-flash-image-preview";

// Line 1077-1082: Image gen goes direct to Gemini
const genConfig = { responseModalities: ["IMAGE"], imageConfig: { aspectRatio, imageSize } };
const result = await callGeminiGenerateContent(DEFAULT_IMAGE_GEN_MODEL, parts, 180_000, genConfig);
```

Meanwhile, Copilot is used ONLY for vision analysis (reading images):
```typescript
// Line 451-452: Copilot used only for reading images
const COPILOT_API_BASE = "https://api.githubcopilot.com";
const DEFAULT_COPILOT_VISION_MODEL = "gpt-4.1";  // text output only
```

### 3. Multimodal Models Available Through Copilot

**Available models (from official docs, current as of 2026-03-03):**

| Model | Provider | Vision Input | Image Output |
|---|---|---|---|
| Gemini 2.5 Pro | Google | ✅ | ❌ |
| Gemini 3 Flash | Google | ✅ | ❌ |
| Gemini 3 Pro | Google | ✅ | ❌ |
| Gemini 3.1 Pro | Google | ✅ | ❌ |
| GPT-4.1 | OpenAI | ✅ | ❌ |
| GPT-5 mini | OpenAI | ✅ | ❌ |
| GPT-5.1 | OpenAI | ✅ | ❌ |
| GPT-5.2 | OpenAI | ✅ | ❌ |
| Claude Sonnet 4/4.5/4.6 | Anthropic | ✅ | ❌ |
| Claude Opus 4.5/4.6 | Anthropic | ✅ | ❌ |
| Claude Haiku 4.5 | Anthropic | ✅ | ❌ |
| Grok Code Fast 1 | xAI | ⚠️ Unclear | ❌ |
| Raptor mini | Microsoft | ❓ | ❌ |
| Goldeneye | Microsoft | ❓ | ❌ |

**Key point:** ALL models support vision *input* (accepting images). NONE produce image *output* through Copilot.

### 4. API Differences: Gemini Direct vs Copilot Proxy

| Feature | Gemini Direct API | Copilot Proxy |
|---|---|---|
| **Endpoint** | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `api.githubcopilot.com/chat/completions` |
| **Auth** | `GEMINI_API_KEY` (query param) | Copilot JWT (Bearer header) |
| **Request format** | Google's `contents[].parts[]` | OpenAI-compatible `messages[]` |
| **`responseModalities`** | ✅ Supported (`["TEXT"]`, `["IMAGE"]`, `["TEXT", "IMAGE"]`) | ❌ Not supported |
| **`imageConfig`** | ✅ (`aspectRatio`, `imageSize`) | ❌ Not supported |
| **Image output** | ✅ `inlineData: { mimeType, data }` | ❌ Only `content: string` |
| **Vision input** | ✅ `inlineData` in request parts | ✅ `image_url` in content array |
| **Streaming** | ✅ `streamGenerateContent` | ✅ SSE streaming |
| **Tools/Function calling** | ✅ | ✅ |
| **System instructions** | ✅ | ✅ (via system message) |

**Features stripped by Copilot proxy:**
1. `responseModalities` — cannot request image output
2. `imageConfig` — no aspect ratio / size control
3. `generationConfig` entirely — Copilot uses its own parameter mapping (temperature, max_tokens, etc.)
4. File upload API — no `files.upload` or `fileData` references
5. Code execution / grounding — Google-specific features not passed through
6. Native multimodal output — all output is text-only through OpenAI format

### 5. GPT-4o / GPT-Image-1 / DALL-E Through Copilot

**❌ No DALL-E or GPT-Image-1 support.**

- GPT-4o is not in the current Copilot model catalog (replaced by GPT-4.1, GPT-5 series)
- OpenAI's `GPT-Image-1` model is not listed in any Copilot documentation
- DALL-E 2/3 are not in the Copilot model catalog
- The Copilot API has no `/v1/images/generations` endpoint

**Note:** Microsoft's *other* Copilot products (Microsoft 365 Copilot, Copilot in Windows, Bing Copilot) DO have image generation via Designer/DALL-E — but this is an entirely separate product stack from GitHub Copilot.

### 6. Documentation & Community Evidence

| Source | Finding |
|---|---|
| [GitHub official docs: supported-models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) | Lists only text/code models. "Working with visuals" section explicitly about *input* only. No mention of image generation. |
| [GitHub official docs: model-comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) | "Working with visuals (diagrams, screenshots)" = vision input. Zero mention of image output/generation. |
| [GitHub official docs: model-hosting](https://docs.github.com/en/copilot/reference/ai-models/model-hosting) | Documents hosting for text models only. No image generation infrastructure mentioned. |
| [Copilot Extensions Preview SDK](https://github.com/copilot-extensions/preview-sdk.js) | `CopilotMessage.content: string` — no image content type. No `createImageEvent()` function. |
| SDK `prompt()` implementation | Sends to `/chat/completions`, returns `choices[0].message` with string content only. |
| [CopilotX community proxy](https://pypi.org/project/copilotx/) | Confirms vision *input* support. No image generation mentioned. |
| This codebase (`src/server/multimodal.ts`) | Image generation uses direct Gemini API. Copilot used only for vision analysis (image *reading*). |

### 7. Chat Completions Response Format

**Copilot's response never contains image content blocks.**

Request (vision input works):
```json
{
  "model": "gpt-4.1",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What's in this image?" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
    ]
  }],
  "max_tokens": 4096
}
```

Response (text only, always):
```json
{
  "id": "chatcmpl-...",
  "choices": [{
    "index": 0,
    "finish_reason": "stop",
    "message": {
      "role": "assistant",
      "content": "The image shows a diagram of..."
    }
  }],
  "usage": { "prompt_tokens": 1500, "completion_tokens": 200, "total_tokens": 1700 }
}
```

There is no `images[]` array, no `inline_data`, no `image_url` in responses, no `content_block` with type `image`. The response schema is strictly `{ message: { content: string } }`.

---

## Architecture Summary

```
┌────────────────────────────────────────────────────────┐
│                    Copilot API                          │
│        api.githubcopilot.com/chat/completions          │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐ │
│  │  OpenAI   │  │Anthropic │  │ Google │  │   xAI    │ │
│  │ GPT-4.1   │  │ Claude   │  │Gemini  │  │  Grok    │ │
│  │ GPT-5.x   │  │ Sonnet   │  │2.5/3.x │  │Code Fast │ │
│  └──────────┘  └──────────┘  └────────┘  └──────────┘ │
│                                                         │
│  INPUT:  text + images (image_url)     ✅               │
│  OUTPUT: text only (string)            ⚠️               │
│  NO: responseModalities, imageConfig   ❌               │
│  NO: /images/generations endpoint      ❌               │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│              Direct Gemini API                          │
│     generativelanguage.googleapis.com/v1beta           │
│                                                         │
│  INPUT:  text + images + video + audio  ✅              │
│  OUTPUT: text + images (inlineData)     ✅              │
│  responseModalities: ["IMAGE"]          ✅              │
│  imageConfig: { aspectRatio, imageSize }✅              │
└────────────────────────────────────────────────────────┘
```

## Bottom Line

If you need image generation:
1. **Use Gemini API directly** (`GEMINI_API_KEY`) — supports native image gen via `responseModalities: ["IMAGE"]`
2. **Use a CPA/OpenAI-compatible proxy** that supports `modalities: ["text", "image"]`
3. **Do NOT rely on Copilot API** — it is a text-only proxy for all models, regardless of their native capabilities

This is exactly what this codebase already does: `generateImage()` in `multimodal.ts` calls Gemini directly (not through Copilot), while Copilot is used only for zero-cost vision analysis via `callCopilotVisionAnalysis()`.

---

## Unresolved Questions

1. **Will GitHub ever add image generation models to Copilot?** No public roadmap. The model-hosting docs and supported-models page show no plans for DALL-E, Imagen, or GPT-Image-1.
2. **Could Copilot proxy forward `responseModalities` in the future?** Theoretically possible but would require significant schema changes — their OpenAI-compatible format doesn't support it today.
3. **Does the GitHub Models API (`models.github.ai`) support image generation?** Its model catalog appears to mirror Copilot's. The REST API inference endpoint uses the same OpenAI-compatible format. No evidence of image generation support.
