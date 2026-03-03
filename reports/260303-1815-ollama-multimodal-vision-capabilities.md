# Ollama Multimodal (Vision/Image) Capabilities Research

**Date**: 2026-03-03
**Sources**: Ollama official docs (api.md, capabilities/vision.mdx, api/openai-compatibility.mdx, cloud.mdx, openapi.yaml), clawd codebase analysis

---

## Executive Summary

Ollama has **full vision/multimodal support** for image analysis via both its native API and OpenAI-compatible endpoint. Image generation is **experimental** and limited to specific diffusion models. The clawd `OllamaProvider` currently **does NOT pass images** — this is a gap.

---

## 1. Vision/Multimodal Support — YES, Fully Supported

### Native Ollama API (`/api/chat` and `/api/generate`)

Images are sent as **base64-encoded strings** in an `images` array on the message object.

**`/api/chat` format:**
```json
{
  "model": "gemma3",
  "messages": [{
    "role": "user",
    "content": "What is in this image?",
    "images": ["iVBORw0KGgo...base64..."]
  }],
  "stream": false
}
```

**`/api/generate` format:**
```json
{
  "model": "llava",
  "prompt": "What is in this picture?",
  "images": ["iVBORw0KGgo...base64..."],
  "stream": false
}
```

Key points:
- `images` is a **top-level array on the message** (not nested in content parts)
- Values are **raw base64 strings** (no `data:image/png;base64,` prefix in native API)
- SDKs (Python/JS) additionally accept file paths and raw bytes — the REST API only takes base64
- No image URL support in native API (must download & encode yourself)

### OpenAI-Compatible API (`/v1/chat/completions`)

Supports the **OpenAI vision message format** with `image_url` content parts:

```json
{
  "model": "qwen3-vl:8b",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": "data:image/png;base64,iVBORw0KGgo..."}
    ]
  }],
  "max_tokens": 300
}
```

**Supported image formats in `/v1/chat/completions`:**
- ✅ Base64 encoded images (`data:image/png;base64,...`)
- ❌ Image URLs (NOT supported — must be base64)

Note: The `image_url` field can be either:
- A string: `"data:image/png;base64,..."` (Ollama's actual format)
- An object: `{"url": "data:image/png;base64,..."}` (standard OpenAI format — likely also works)

---

## 2. Vision-Capable Models

### Local Models (run on your GPU)

| Model | Sizes | Notes |
|-------|-------|-------|
| **llava** | 7B, 13B, 34B | Original vision model, well-tested |
| **llava-llama3** | 8B | LLaVA built on Llama 3 |
| **llava-phi3** | 3.8B | Lightweight, fast |
| **llama3.2-vision** | 11B, 90B | Meta's official vision model |
| **gemma3** | 4B, 12B, 27B | Google's multimodal model |
| **qwen3-vl** | 3B, 8B | Alibaba's vision-language model |
| **bakllava** | 7B | BakLLaVA variant |
| **moondream** | 1.8B | Ultra-lightweight vision |
| **minicpm-v** | 8B | Efficient vision model |

### Cloud Models (via ollama.com API)

Cloud models listed at `https://ollama.com/search?c=cloud`. The cloud API uses the **same `/api/chat` format** — images should work identically when the cloud model supports vision. Cloud models are accessed:
- **Locally proxied**: `ollama run model:tag-cloud` → local Ollama forwards to cloud
- **Direct API**: `https://ollama.com/api/chat` with Bearer token

Whether specific cloud models support vision depends on the model itself (e.g., `gpt-oss:120b` is text-only based on the docs examples). Check `https://ollama.com/search?c=vision` for vision-capable cloud models.

---

## 3. OpenAI-Compatible Vision — Detailed

From the official `openai-compatibility.mdx`:

```
/v1/chat/completions supported features:
  ✅ Vision
  ✅ Image content (base64 encoded)
  ❌ Image URL
  ✅ Array of content parts
```

### Exact curl example from Ollama docs:

```shell
curl -X POST http://localhost:11434/v1/chat/completions \
-H "Content-Type: application/json" \
-d '{
  "model": "qwen3-vl:8b",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What is this an image of?"},
      {"type": "image_url", "image_url": "data:image/png;base64,iVBORw0KGgo..."}
    ]
  }]
}'
```

### Python with OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url='http://localhost:11434/v1/',
    api_key='ollama',
)

response = client.chat.completions.create(
    model='qwen3-vl:8b',
    messages=[{
        'role': 'user',
        'content': [
            {'type': 'text', 'text': "What's in this image?"},
            {'type': 'image_url', 'image_url': 'data:image/png;base64,...'},
        ],
    }],
    max_tokens=300,
)
```

---

## 4. Image Generation/Editing — Experimental, Limited

### Generation: YES (experimental)

Ollama recently added **experimental image generation** for diffusion models via:

**Native API** (`/api/generate`):
```json
{
  "model": "x/z-image-turbo",
  "prompt": "a sunset over mountains",
  "width": 1024,
  "height": 768
}
```

Response includes `"image": "base64-encoded-png..."` in the final response.

**OpenAI-compatible** (`/v1/images/generations`) — also experimental:
```json
{
  "model": "x/z-image-turbo",
  "prompt": "A cute robot learning to paint",
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Supported fields: `model`, `prompt`, `size`, `response_format` (only `b64_json`).
NOT supported: `n`, `quality`, `style`, `user`.

### Editing: NO

No image editing endpoint exists. Strictly generation from text prompts only.

### Available Image Generation Models

These must be local diffusion models (e.g., `x/z-image-turbo`). The selection is very limited compared to text models. This is bleeding-edge in Ollama.

---

## 5. Practical Implementation for Clawd

### Current Gap in OllamaProvider

The `OllamaProvider.toOllamaRequest()` at `src/agent/src/api/factory.ts:748` maps messages but **strips images**:

```typescript
// Current code (line 804) - NO image handling:
return {
  role: msg.role === "system" ? "system" : msg.role,
  content: msg.content,
};
```

The `images` field from the Ollama message spec is never populated.

### Fix: Add Image Support to toOllamaRequest

For the native `/api/chat` endpoint, images go on the message object:

```typescript
// In the message mapping function:
return {
  role: msg.role,
  content: msg.content,
  // Pass through images if present (base64 strings)
  ...(msg.images?.length ? { images: msg.images } : {}),
};
```

If images come in OpenAI format (content parts array with `image_url` type), they need conversion:

```typescript
// Convert OpenAI vision format to Ollama native format
if (Array.isArray(msg.content)) {
  const textParts = msg.content
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n');
  const images = msg.content
    .filter(p => p.type === 'image_url')
    .map(p => {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      // Strip data URI prefix if present
      return url.replace(/^data:image\/\w+;base64,/, '');
    });
  return {
    role: msg.role,
    content: textParts,
    ...(images.length ? { images } : {}),
  };
}
```

### For Cloud API Access (https://ollama.com)

Same format works. Just use Bearer token auth:

```shell
curl https://ollama.com/api/chat \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma3",
    "messages": [{
      "role": "user",
      "content": "Describe this image",
      "images": ["iVBORw0KGgo..."]
    }],
    "stream": false
  }'
```

---

## Summary Table

| Feature | Native API | OpenAI-compat API | Cloud API |
|---------|-----------|-------------------|-----------|
| **Vision (image input)** | ✅ `images` array on message | ✅ `image_url` content parts | ✅ Same as native |
| **Image format** | base64 strings | `data:image/...;base64,...` | base64 strings |
| **Image URLs** | ❌ | ❌ | ❌ |
| **Image generation** | ✅ Experimental | ✅ Experimental `/v1/images/generations` | Unknown |
| **Image editing** | ❌ | ❌ | ❌ |
| **Multi-image** | ✅ Multiple in array | ✅ Multiple content parts | ✅ |

---

## Unresolved Questions

1. **Which cloud models support vision?** The cloud model catalog at `ollama.com/search?c=vision` may list cloud-enabled vision models, but we can't verify without live access.
2. **Image generation model availability**: Only `x/z-image-turbo` is referenced in docs. Unclear what other image generation models exist or if any are cloud-available.
3. **`/v1/images/generations` on ollama.com cloud**: Docs don't confirm whether the experimental image generation endpoint is available on the cloud API.
4. **Max image size limits**: Not documented in Ollama's API docs. Likely constrained by context window of the specific model.
5. **OpenAI `image_url` object vs string**: Ollama docs show `image_url` as a string (not `{"url": "..."}` object). The object form *may* work but is unconfirmed.
