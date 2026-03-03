# Research Report: Image Tools Architecture for Multi-Provider AI Agent Framework

**Date**: 2025-07-03
**Scope**: `read_image`, `create_image`, `edit_image` tool architecture across LLM providers
**Sources**: Codebase analysis (clawd `src/server/multimodal.ts`, `src/server/mcp.ts`, `src/config-file.ts`), Google Gemini API docs, OpenAI API docs, Anthropic API docs, Stability AI docs, agent framework patterns

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [read_image — Vision/Analysis](#1-read_image--visionanalysis)
3. [create_image — Generation](#2-create_image--generation)
4. [Multi-Provider Abstraction](#3-multi-provider-abstraction)
5. [Agent Framework Patterns](#4-agent-framework-patterns)
6. [Architectural Recommendation](#5-architectural-recommendation)
7. [Unresolved Questions](#unresolved-questions)

---

## Executive Summary

The clawd codebase **already has a mature, well-architected** multi-provider image tool system in `src/server/multimodal.ts` (~1350 LOC). It supports 3 providers (Gemini, Copilot/OpenAI, CPA) with per-operation config, fallback chains, quota tracking, and path security. The architecture is solid and closely matches industry best practices.

**Key findings:**
- **Vision (read_image)**: All major providers (OpenAI, Anthropic, Google, Meta) use the same pattern: base64 image data in chat completion messages. OpenAI's `image_url` format is the de facto standard.
- **Generation (create_image)**: Two paradigms exist: (1) dedicated image generation endpoints (DALL-E, Imagen 4) and (2) inline image generation via chat completions (Gemini Flash/Pro image models, GPT-4o `gpt-image-1`). The chat completions approach is converging as the standard.
- **Clawd's architecture is ahead of most frameworks** — LangChain, CrewAI, AutoGen all use simpler wrappers without the fallback chain + quota tracking + per-operation provider config that clawd already has.

---

## 1. read_image — Vision/Analysis

### Provider Support Matrix (Mid-2025)

| Provider | Models | Vision Support | Max Image Size |
|----------|--------|---------------|----------------|
| **OpenAI** | GPT-4o, GPT-4.1, GPT-5-mini, o1, o3 | ✅ Native | 20MB |
| **Anthropic** | Claude 3.5 Sonnet, Claude 4 Sonnet/Opus | ✅ Native | 20MB (base64), 5 imgs/msg |
| **Google** | Gemini 2.5 Flash/Pro, Gemini 3 | ✅ Native | 20MB inline, 2GB via Files API |
| **Meta** | Llama 3.2 Vision (11B/90B) | ✅ Via API hosts | Varies by host |
| **Copilot** | gpt-4.1, gpt-5-mini | ✅ Via chat completions | 20MB |

### API Format Comparison

#### OpenAI / Copilot (de facto standard)
```json
{
  "model": "gpt-4o",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": {
        "url": "data:image/png;base64,iVBOR...",
        "detail": "high"
      }}
    ]
  }]
}
```
- Endpoint: `POST /v1/chat/completions`
- Supports both `data:` URIs (base64) and `https://` URLs
- `detail`: `"low"` (512px, 85 tokens), `"high"` (up to 2048px, variable tokens), `"auto"`

#### Anthropic Claude
```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image", "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBOR..."
      }}
    ]
  }]
}
```
- Endpoint: `POST /v1/messages`
- Also supports `"type": "url"` source with `"url": "https://..."`
- Different schema from OpenAI (`image` type vs `image_url`)

#### Google Gemini
```json
{
  "contents": [{
    "parts": [
      { "text": "Describe this image" },
      { "inlineData": { "mimeType": "image/png", "data": "iVBOR..." } }
    ]
  }]
}
```
- Endpoint: `POST /v1beta/models/{model}:generateContent`
- Large files (>20MB): Upload to Files API first, use `fileData.fileUri`
- Completely different schema from OpenAI

### Best Practices for Large Images

1. **Resize before sending**: Most providers auto-downscale internally. Pre-resize to 2048px max dimension to save bandwidth.
2. **JPEG for photos, PNG for screenshots**: JPEG at quality 85 is 3-5x smaller than PNG for photographic content.
3. **Gemini Files API for >20MB**: Upload once, reference multiple times (files expire in 48h).
4. **Token cost awareness**:
   - OpenAI: 85 tokens (low detail) to ~1,100 tokens (high detail per tile)
   - Gemini: 258 tokens (small) to 6,192 tokens (4K)
   - Anthropic: Similar to OpenAI tiling approach

### Chat Images vs Local Filesystem

Clawd's current approach is **correct and elegant**:
1. Chat images: Stored in DB with `file_id`, agent references by ID → server resolves to disk path
2. Tool never exposes raw base64 to the LLM — the server-side `analyzeImage()` handles it
3. Images intercepted at `chat_download_file` → hint to use `read_image` instead

**Pattern**: Agent sees file metadata only; server-side tool handler reads actual bytes and sends to vision API. This is the right separation.

---

## 2. create_image — Generation

### Two Paradigms

#### A. Dedicated Image Generation Endpoints
| Provider | Model | Endpoint | Response |
|----------|-------|----------|----------|
| OpenAI DALL-E 3 | `dall-e-3` | `POST /v1/images/generations` | URL or base64 |
| Google Imagen 4 | `imagen-4.0-generate-001` | `POST .../models/{model}:predict` (Vertex) or `generate_images` (Gemini SDK) | Base64 bytes |
| Stability AI SD3 | `sd3-large` | `POST /v2beta/stable-image/generate/sd3` | Base64 |

#### B. Inline via Chat Completions (Converging Standard)
| Provider | Model | Endpoint | Config |
|----------|-------|----------|--------|
| Google Gemini | `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview` | `generateContent` | `responseModalities: ["IMAGE"]` |
| OpenAI | `gpt-image-1` | `POST /v1/images/generations` | Dedicated endpoint (not chat completions) |
| OpenAI (preview) | `gpt-4o` | May support via chat completions in future | N/A currently |

### Specific API Formats

#### OpenAI DALL-E 3
```json
POST /v1/images/generations
{
  "model": "dall-e-3",
  "prompt": "A serene mountain landscape",
  "n": 1,
  "size": "1024x1024",
  "quality": "hd",
  "response_format": "b64_json"
}
// Response: { "data": [{ "b64_json": "iVBOR...", "revised_prompt": "..." }] }
```
- Sizes: `1024x1024`, `1024x1792`, `1792x1024`
- Cost: ~$0.04/image (standard), ~$0.08/image (HD)

#### OpenAI gpt-image-1
```json
POST /v1/images/generations
{
  "model": "gpt-image-1",
  "prompt": "A serene mountain landscape",
  "n": 1,
  "size": "1024x1024",
  "quality": "high"
}
```
- NOT via chat completions — still uses `/v1/images/generations`
- Cost: ~$0.01–0.02/image (low), ~$0.02–0.07 (medium), ~$0.04–0.19 (high)

#### Google Gemini (Nano Banana) — used by clawd
```json
POST /v1beta/models/gemini-2.5-flash-image:generateContent
{
  "contents": [{ "parts": [{ "text": "A serene mountain landscape" }] }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" }
  }
}
// Response: candidates[0].content.parts[].inlineData = { mimeType, data }
```
- Cost: ~$0.00129/image (Flash at $1/1M tokens, 1290 tokens/image)
- **Cheapest option by far**

#### Google Imagen 4
```python
# Via Python SDK (google-genai)
response = client.models.generate_images(
    model='imagen-4.0-generate-001',
    prompt='...',
    config=GenerateImagesConfig(numberOfImages=1, aspectRatio='16:9')
)
# REST: POST /v1beta/models/imagen-4.0-generate-001:predict
```
- Cost: ~$0.02/image (standard), ~$0.04 (ultra)

#### Stability AI
```
POST https://api.stability.ai/v2beta/stable-image/generate/sd3
Content-Type: multipart/form-data
- prompt: "A serene mountain landscape"
- model: "sd3-large"
- output_format: "png"
// Response: image bytes directly
```
- Cost: ~$0.03-0.065/image depending on model

### Cost Comparison

| Provider/Model | Cost per Image | Quality | Speed |
|---------------|---------------|---------|-------|
| **Gemini Flash Image** | ~$0.001 | ⭐⭐⭐⭐ | Fast |
| Gemini Pro Image | ~$0.134 | ⭐⭐⭐⭐⭐ | Medium |
| Imagen 4 Standard | ~$0.02 | ⭐⭐⭐⭐ | Medium |
| Imagen 4 Ultra | ~$0.04 | ⭐⭐⭐⭐⭐ | Slow |
| Imagen 4 Fast | ~$0.01 | ⭐⭐⭐ | Fast |
| OpenAI DALL-E 3 HD | ~$0.08 | ⭐⭐⭐⭐ | Medium |
| OpenAI gpt-image-1 (high) | ~$0.04–0.19 | ⭐⭐⭐⭐⭐ | Medium |
| Stability AI SD3 Large | ~$0.065 | ⭐⭐⭐⭐ | Medium |

**Winner**: Gemini Flash Image at $0.001/image is 20-80x cheaper than alternatives.

### Can Chat Completion Models Generate Images Inline?

- **Gemini Flash/Pro Image**: ✅ Yes — via `responseModalities: ["IMAGE"]` in `generateContent`
- **GPT-4o**: ❌ Not yet via chat completions — uses dedicated `/v1/images/generations`
- **Claude**: ❌ No image generation capability
- **Llama**: ❌ No image generation in standard models

---

## 3. Multi-Provider Abstraction

### Clawd's Current Architecture (Already Excellent)

```
┌─────────────────────────────────────────────────┐
│                   config.json                    │
│  vision: {                                       │
│    read_image:     { provider: "copilot" }       │
│    generate_image: { provider: "gemini"  }       │
│    edit_image:     { provider: "cpa"     }       │
│  }                                               │
└────────────────────┬────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │  getVisionOpConfig()  │
         │  Per-operation router  │
         └───────────┬───────────┘
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌─────────┐   ┌───────────┐   ┌─────────┐
│ Copilot │   │  Gemini   │   │   CPA   │
│ (OpenAI │   │  (Direct  │   │(OpenAI- │
│  compat)│   │   REST)   │   │compat   │
│         │   │           │   │ proxy)  │
└─────────┘   └───────────┘   └─────────┘
     │               │               │
     └───────────────┼───────────────┘
                     ▼
            Legacy Fallback Chain:
            Gemini → CPA → Error
```

### Key Design Decisions (Already Implemented Well)

1. **Per-operation provider selection** — `read_image` can use Copilot (free vision), `generate_image` can use Gemini (cheapest)
2. **Fallback chain** — If primary fails, try next provider automatically
3. **Quota tracking** — Daily image generation limit with atomic file writes
4. **Path security** — Symlink-resolved path validation against allowed directories
5. **Image never exposed to LLM** — Server handles vision API calls, returns text analysis

### What Could Be Improved

1. **Add OpenAI DALL-E 3 as direct provider** — Currently only via CPA proxy. Direct integration would reduce latency.
2. **Add Stability AI provider** — For users who want SD3 without proxy.
3. **Provider health tracking** — Record success/failure rates per provider for smarter fallback.
4. **Retry with exponential backoff** — Currently single-attempt per provider before fallback.

---

## 4. Agent Framework Patterns

### How Other Frameworks Handle Image Tools

#### LangChain
- Uses `Tool` class wrapping individual provider SDKs
- `DallEAPIWrapper` for DALL-E, separate tools per provider
- No built-in fallback chain — user must compose manually
- Returns base64 or URL, no file management

#### CrewAI
- No built-in image tools — relies on custom tool functions
- Uses LangChain tools or custom `@tool` decorators
- No vision support built-in

#### AutoGen (Microsoft)
- Multimodal messages via `ImageMessage` class
- Vision handled by passing images in conversation messages (native to LLM)
- No dedicated image generation tool — wrapped as custom functions

#### Vercel AI SDK
- `experimental_generateImage()` function
- Supports OpenAI and custom providers via adapter pattern
- Returns `ImageGenerationResult` with base64 data
- Clean provider abstraction but limited to generation

### Best Practice: Returning Image Results

**Industry consensus**: Return **file path + metadata** (not base64, not URLs).

Reasons:
- Base64 in tool results wastes context window tokens
- URLs expire and aren't reliable for persistence
- File paths enable the agent to reference images in subsequent operations

**Clawd does this correctly**: Tool result is `{ ok: true, image: { id, name, path, mimetype, size } }` — the agent gets metadata, not pixels.

---

## 5. Architectural Recommendation

### Current Architecture Assessment: **8/10 — Very Good**

Clawd's `multimodal.ts` is well-engineered. Minor improvements suggested below.

### Recommended Improvements

#### 1. Normalize Provider Interface (DRY)

Currently each provider has bespoke call functions (`callGeminiGenerateContent`, `callCopilotVisionAnalysis`, `callCpaImageGeneration`). Extract a common interface:

```typescript
interface ImageProvider {
  name: string;
  analyzeImage(filePath: string, mimeType: string, prompt: string): Promise<VisionResult>;
  generateImage(prompt: string, config: ImageGenConfig): Promise<ImageGenResult>;
  editImage(source: string, mimeType: string, prompt: string): Promise<ImageGenResult>;
  isAvailable(): boolean;
}

interface VisionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface ImageGenResult {
  ok: boolean;
  imageData?: { mimeType: string; data: string }; // base64
  error?: string;
}
```

This would enable:
- Easy addition of new providers (DALL-E direct, Stability AI, Replicate)
- Cleaner fallback logic via provider array iteration
- Unit testing per provider

#### 2. Add Retry Logic Per Provider

```typescript
async function callWithRetry<T>(
  fn: () => Promise<T & { ok: boolean }>,
  maxRetries: number = 2,
  backoffMs: number = 1000,
): Promise<T & { ok: boolean }> {
  for (let i = 0; i <= maxRetries; i++) {
    const result = await fn();
    if (result.ok || i === maxRetries) return result;
    await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, i)));
  }
  // Unreachable, but TypeScript needs it
  throw new Error("Retry exhausted");
}
```

#### 3. Image Pre-processing (KISS — Optional)

Only if bandwidth becomes an issue:

```typescript
function shouldResize(filePath: string): boolean {
  // Only resize if > 5MB and JPEG/PNG
  return statSync(filePath).size > 5 * 1024 * 1024;
}
// Use sharp or canvas to resize to 2048px max dimension
// Most providers auto-resize internally, so this is YAGNI unless proven needed
```

#### 4. Direct DALL-E Provider (If Needed)

```typescript
// Only add if CPA proxy becomes unreliable or if OpenAI keys are available directly
async function callDalleImageGeneration(
  prompt: string, size: string = "1024x1024"
): Promise<ImageGenResult> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size,
      response_format: "b64_json",
    }),
  });
  const data = await response.json();
  return {
    ok: true,
    imageData: { mimeType: "image/png", data: data.data[0].b64_json },
  };
}
```

### What NOT to Change (YAGNI)

- ❌ Don't add Stability AI unless specifically requested — Gemini + CPA covers all needs
- ❌ Don't add image pre-processing/resizing — providers handle it
- ❌ Don't switch to URL-based image returns — file paths are correct for this architecture
- ❌ Don't add streaming image generation — no provider supports it meaningfully
- ❌ Don't abstract into a separate package — 1350 LOC in one file is manageable

### Config Schema (Already Well-Designed)

```json
{
  "vision": {
    "read_image": { "provider": "copilot", "model": "gpt-4.1" },
    "generate_image": { "provider": "gemini", "model": "gemini-2.5-flash-image" },
    "edit_image": { "provider": "cpa", "model": "gemini-3.1-flash-image" }
  },
  "providers": {
    "copilot": { "api_key": "..." },
    "cpa": { "base_url": "...", "api_key": "..." }
  },
  "env": { "GEMINI_API_KEY": "..." },
  "quotas": { "daily_image_limit": 50 }
}
```

### Recommended Default Provider Strategy

| Operation | Primary | Fallback | Rationale |
|-----------|---------|----------|-----------|
| `read_image` | Copilot (gpt-4.1) | Gemini → CPA | Copilot = 0 premium cost |
| `generate_image` | Gemini Flash Image | CPA → Error | $0.001/image, great quality |
| `edit_image` | Gemini Flash Image | CPA → Error | Native edit support |

---

## Unresolved Questions

1. **GPT-4o native image gen via chat completions**: OpenAI has teased this but it's not live in the standard API (only via `gpt-image-1` at dedicated endpoint). When/if this ships, the CPA provider would automatically support it if OpenAI makes it available through chat completions. Monitor OpenAI changelog.

2. **Anthropic image generation**: Claude has no image generation capability. If Anthropic adds it, the CPA adapter pattern would likely work since they'd likely use a similar chat completions format.

3. **Gemini model naming churn**: Google frequently renames models (`gemini-2.0-flash-preview-image-generation` → `gemini-2.5-flash-image` → `gemini-3.1-flash-image-preview`). The `DEFAULT_IMAGE_GEN_MODEL` constant approach is correct but needs periodic updates. Consider making it configurable without code changes (it already is via config.json).

4. **Multi-image generation (n>1)**: Current architecture generates 1 image per call. Imagen 4 supports 1-4 images per request. Not needed now but may be requested.

5. **Image editing quality**: Gemini's edit quality via `generateContent` with source image is decent but not as good as dedicated inpainting models (SD3 inpainting, DALL-E edit endpoint). If edit quality becomes a complaint, consider adding specialized edit providers.
