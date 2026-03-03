# Research Report: MiniMax AI Models — Image & Multimodal Capabilities

## Executive Summary

MiniMax is a Chinese AI company (founded 2022) with a **full-stack multimodal model matrix** covering text, speech, video, image, and music. Their text models (M-series) are **text-only** — none accept image input via API. Image generation exists via a **separate dedicated endpoint** (`image-01` model), NOT through chat completions. The only vision-capable model is **MiniMax-VL-01** (Jan 2025), which is available as open weights on HuggingFace but is **NOT currently exposed through their API platform** — it was bundled into the legacy `MiniMax-01` offering on OpenRouter only.

**Bottom line for developer use case**: MiniMax excels at coding/agentic text tasks (M2, M2.1, M2.5 are elite). For image generation, they offer a proprietary `image-01` model via REST API. For image *understanding/vision* via API — **no current offering**. Their API is Anthropic-SDK-compatible (recommended) and OpenAI-compatible.

---

## 1. MiniMax Model Lineup (as of mid-2025)

### Text/LLM Models (Current Generation)

| Model | Total Params | Active Params | Context | Speed | Focus |
|-------|-------------|---------------|---------|-------|-------|
| **MiniMax-M2.5** | 230B | 10B | 196K | ~100 tps (Lightning) / ~50 tps | SOTA coding, office work, agentic. 80.2% SWE-Bench Verified |
| **MiniMax-M2.5-highspeed** | 230B | 10B | 196K | ~100 tps | Same capability, faster inference |
| **MiniMax-M2.1** | 230B | 10B | 196K | ~60 tps | Multilingual coding specialist. 72.5% SWE-Bench Multilingual |
| **MiniMax-M2.1-highspeed** | 230B | 10B | 196K | ~100 tps | Same, faster |
| **MiniMax-M2** | 230B | 10B | 196K | ~60 tps | Coding & agentic workflows. First M2-series |
| **MiniMax-M2-her** | ? | ? | 65K | ? | Roleplay/dialogue specialist. Character-driven chat |
| **MiniMax-M1** | 456B | 45.9B | 1M tokens | ? | Reasoning model (RL-trained CISPO). Long-context champion |
| **MiniMax-01** (legacy) | 456B | 45.9B | 1M+ | ? | Text+VL bundle, predecessor to M-series |
| **MiniMax-Text-01** | 456B | 45.9B | 4M tokens | ? | Legacy text model (Jan 2025 release) |

### Vision/Multimodal Models

| Model | Type | Status | Availability |
|-------|------|--------|-------------|
| **MiniMax-VL-01** | Image-text-to-text (ViT-MLP-LLM) | Open weights on HuggingFace | Self-hosted only (vLLM). **NOT on MiniMax API platform** |
| **MiniMax-01** (via OpenRouter) | text+image→text | Available on OpenRouter | Input: text+image. Output: text. 1M context |
| **VTP-Small/Base/Large** | Image feature extraction (ViT) | Open weights on HuggingFace | Research models, not API-served |

### Creative/Media Models (via API)

| Model | Type | API Model Name |
|-------|------|---------------|
| **image-01** | Text-to-image generation | `image-01` |
| **MiniMax-Hailuo-02** | Video generation (text/image-to-video) | via MCP/API |
| **MiniMax Speech 2.6** | Text-to-speech, voice cloning | TTS API |
| **MiniMax Music 2.5** | Music generation | `music-1.5` |

### HuggingFace Open Weight Models

- `MiniMaxAI/MiniMax-M2.5` — 331K downloads, 1071 likes
- `MiniMaxAI/MiniMax-M2.1` — 74K downloads
- `MiniMaxAI/MiniMax-M2` — 332K downloads
- `MiniMaxAI/MiniMax-M1-80k` — 63K downloads (80K context variant)
- `MiniMaxAI/MiniMax-M1-40k` — 10K downloads (40K context variant)
- `MiniMaxAI/MiniMax-VL-01` — 82K downloads, **image-text-to-text** pipeline
- `MiniMaxAI/MiniMax-Text-01` — 1K downloads (legacy)

---

## 2. Image Generation

### Yes — MiniMax offers image generation via `image-01`

**API Endpoint**: `POST https://api.minimax.io/v1/image_generation`

**Model name**: `image-01`

**Capabilities**:
- Text-to-image generation from detailed prompts
- Image-to-image generation with reference images (subject preservation)
- Supports `aspect_ratio` parameter
- Returns base64-encoded JPEG images
- Accepts reference image URLs for consistent character/subject generation

**Example Request**:
```python
import requests, os

url = "https://api.minimax.io/v1/image_generation"
headers = {"Authorization": f"Bearer {os.environ['MINIMAX_API_KEY']}"}
payload = {
    "model": "image-01",
    "prompt": "A professional developer working at a desk...",
    "aspect_ratio": "16:9",
    "response_format": "base64",
}
response = requests.post(url, headers=headers, json=payload)
images = response.json()["data"]["image_base64"]
```

**Key limitation**: This is a **standalone REST endpoint**, NOT accessible through chat completions. You cannot ask an LLM to generate images inline — you must call the image API separately.

---

## 3. Image Understanding/Vision

### Limited — Only via legacy MiniMax-01 on OpenRouter

**MiniMax-VL-01** (the actual vision model):
- 303M param ViT + MLP projector + MiniMax-Text-01 as base LLM
- Dynamic resolution: 336×336 to 2016×2016
- Strong benchmarks: OCRBench 865, ChartQA 91.7%, DocVQA 96.4%
- **Self-hosted only** via vLLM. Requires 8 GPUs with int8 quantization
- Supports function calling with vision input
- **NOT available on MiniMax's own API platform**

**MiniMax-01 on OpenRouter**:
- Modality: `text+image→text` (confirmed by OpenRouter metadata)
- Input modalities: `["text", "image"]`
- This bundles VL-01 with Text-01
- Accessible via OpenRouter's OpenAI-compatible API
- Context: 1M tokens
- Pricing: $0.20/M input, $1.10/M output (via OpenRouter)

**Current M-series (M2, M2.1, M2.5)**: 
- **All text-only**. Modality: `text→text`
- Input modalities: `["text"]` only
- **No vision capability whatsoever**

---

## 4. API Compatibility & Endpoints

### Base URLs (Region-dependent)

| Region | API Host | Platform Console |
|--------|----------|-----------------|
| **Global** | `https://api.minimax.io` | `https://platform.minimax.io` |
| **China/Mainland** | `https://api.minimaxi.com` | `https://platform.minimaxi.com` |

⚠️ **API key must match host region** — cross-region keys produce "invalid api key" errors.

> **Note**: The old URL `https://api.minimaxi.chat` is **deprecated/dead** (returns 404).

### Anthropic-Compatible API (Recommended by MiniMax)

**Base URL**: `https://api.minimax.io/anthropic`  
**Messages endpoint**: `https://api.minimax.io/anthropic/v1/messages`

```bash
export ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
export ANTHROPIC_API_KEY=${YOUR_MINIMAX_API_KEY}
```

```python
import anthropic
client = anthropic.Anthropic()
message = client.messages.create(
    model="MiniMax-M2.5",
    max_tokens=1000,
    system="You are a helpful assistant.",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**Supports**: Streaming, interleaved thinking, tool calling, cache control.

### OpenAI-Compatible API

**Base URL**: `https://api.minimax.io/v1` (inferred from patterns)  
**Chat completions**: `https://api.minimax.io/v1/chat/completions`

```python
from openai import OpenAI
client = OpenAI(
    api_key="YOUR_MINIMAX_API_KEY",
    base_url="https://api.minimax.io/v1"
)
response = client.chat.completions.create(
    model="MiniMax-M2.5",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### Other API Endpoints

| Endpoint | URL |
|----------|-----|
| Image Generation | `POST https://api.minimax.io/v1/image_generation` |
| Video Generation | via MCP server or direct API |
| Text-to-Speech | TTS API endpoints |
| Music Generation | Music API endpoints |

### Third-Party Integration

| Platform | Method | Model Format |
|----------|--------|-------------|
| **OpenRouter** | OpenAI-compatible | `minimax/minimax-m2.5`, `minimax/minimax-m1`, etc. |
| **LiteLLM** | Anthropic specs | `minimax/MiniMax-M2.1`, with `api_base=https://api.minimax.io/anthropic/v1/messages` |
| **Claude Code / Cursor / Cline** | Anthropic SDK | Set `ANTHROPIC_BASE_URL` to MiniMax endpoint |

---

## 5. Pricing

### Text Models (Pay-as-you-go via OpenRouter)

| Model | Input ($/M tokens) | Output ($/M tokens) | Cache Read ($/M) |
|-------|-------------------|---------------------|------------------|
| **MiniMax-M2.5** | $0.295 | $1.20 | $0.03 |
| **MiniMax-M2.5-Lightning** | $0.30 | $2.40 | — |
| **MiniMax-M2.1** | $0.27 | $0.95 | $0.03 |
| **MiniMax-M2** | $0.255 | $1.00 | $0.03 |
| **MiniMax-M2-her** | $0.30 | $1.20 | $0.03 |
| **MiniMax-M1** | $0.40 | $2.20 | — |
| **MiniMax-01** (legacy) | $0.20 | $1.10 | — |

### MiniMax Direct Platform Pricing (from M2.5 README)

- **M2.5**: $0.15/M input, $1.20/M output (at 50 tps)
- **M2.5-Lightning**: $0.30/M input, $2.40/M output (at 100 tps)
- "$1 to run the model continuously for an hour at 100 tps"
- Cost is **1/10th to 1/20th** of Claude Opus, Gemini 3 Pro, GPT-5

### Free Tier

- **MiniMax-M2 API**: Explicitly stated as "**free for a limited time**" on their platform
- **MiniMax Agent** (consumer product): "**publicly available and free**" for a limited time
- No permanent free tier confirmed; promotional free access ongoing

### Coding Plan

MiniMax offers a dedicated **"Coding Plan"** subscription:
- Described as "A cost-effective coding package tailored for developers"
- Features: Top model access, unlimited monthly plan, one-click integration with leading dev tools (Claude Code, Cursor, Cline)
- Specific pricing tiers not scraped (behind JS-rendered paywall)
- Tagline: "Subscribe to Coding Plan to use MiniMax text models at ultra-low prices!"

### Audio Subscription Pricing

| Tier | Monthly | Credits/month |
|------|---------|---------------|
| Starter | $81/yr ($48/mo) | 100,000 |
| Pro | $267/yr ($288/mo) | 300,000 |
| Business | $672/yr ($950/mo) | 1,100,000 |
| Enterprise | $2,697/yr ($2,390/mo) | 3,300,000 |
| Custom | Custom | 20,000,000 |

### Image Generation Pricing
- Not explicitly listed in scraped data
- Available via the `image-01` model at `POST /v1/image_generation`
- Likely credit/pay-per-image based (details behind auth wall)

---

## 6. Multimodal Tasks via Chat Completions

### Can you send images in chat messages? **Mostly NO.**

| Model | Image input in chat? | Notes |
|-------|---------------------|-------|
| M2.5, M2.1, M2, M2-her | ❌ NO | Text-only models |
| M1 | ❌ NO | Text-only reasoning model |
| MiniMax-01 (via OpenRouter) | ✅ YES | Legacy model, accepts `text+image` input |
| MiniMax-VL-01 (self-hosted) | ✅ YES | Requires local deployment with 8 GPUs |

**For image generation**: Must use separate `POST /v1/image_generation` endpoint — NOT embeddable in chat completions.

**Via MCP Server**: MiniMax offers an official MCP server (`minimax-mcp`) that exposes:
- `text_to_image` — image generation tool
- `generate_video` — video generation
- `text_to_audio` — speech synthesis
- `voice_clone` — voice cloning
- `music_generation` — music creation

This means Cursor, Claude Desktop, Windsurf, and other MCP-compatible tools can trigger image generation through the MCP protocol, but it's a **tool call**, not native multimodal in the LLM context.

---

## 7. MiniMax "Coding Plan"

Per their platform docs:
- **Purpose**: Cost-effective package for developers
- **Features**:
  - Access to latest SOTA models (M2.5, M2.1)
  - Unlimited monthly usage plan
  - One-click integration with Claude Code, Cursor, Cline
  - Anthropic SDK compatibility (recommended integration path)
- **Setup**: 
  ```bash
  export ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
  export ANTHROPIC_API_KEY=${YOUR_MINIMAX_API_KEY}
  ```
- Then use Claude Code / Cursor / Cline normally — they'll route to MiniMax

---

## 8. Creative/Visual-Specific Models

| Product | Model | Capability |
|---------|-------|-----------|
| **Hailuo AI Video** | MiniMax-Hailuo-02 | Text/image-to-video. 6s/10s duration, 768P/1080P |
| **Image Generation** | `image-01` | Text-to-image, image-to-image with subject preservation |
| **MiniMax Music** | `music-1.5` / Music 2.5 | Text+lyrics-to-music |
| **MiniMax Audio** | Speech 2.6 | TTS with LoRA voice cloning, real-time response |
| **M2-her** | Text model | Roleplay/character-driven dialogue |

MiniMax positions itself as a **full-stack AI company** — text, image, video, audio, music all under one API platform.

---

## 9. Comparison: Image Generation & Processing

### Image Generation Comparison

| Provider | Model | API Type | Quality | OpenAI-Compatible? |
|----------|-------|----------|---------|-------------------|
| **MiniMax** | `image-01` | REST (dedicated endpoint) | Good (subject preservation) | ❌ Custom endpoint |
| **OpenAI** | DALL-E 3, gpt-image-1 | `POST /v1/images/generations` | Very good | ✅ Native |
| **Stability AI** | SDXL, SD3 | REST | Excellent (customizable) | ❌ Custom |
| **Google** | Imagen 3 | Vertex AI | Excellent | ❌ Custom |
| **Midjourney** | MJ v6 | Discord bot / limited API | Best artistic | ❌ No standard API |
| **Recraft** | Recraft V3 | REST | Great for design | ❌ Custom |

### Image Understanding Comparison

| Provider | Model | Via Chat Completions? | Quality |
|----------|-------|-----------------------|---------|
| **MiniMax** | VL-01 (self-hosted only) | Only via OpenRouter (legacy MiniMax-01) | Good |
| **OpenAI** | GPT-4o, GPT-4V | ✅ Native | Excellent |
| **Anthropic** | Claude 3.5/4 Sonnet | ✅ Native | Excellent |
| **Google** | Gemini 2.5 | ✅ Native | Excellent |

### Key Takeaway

MiniMax is **not competitive** for image understanding via API — their vision model is legacy and not served on their own platform. For image generation, they offer a functional but not industry-leading standalone API. **MiniMax's real strength is text/coding/agentic tasks at extremely low cost.**

---

## Capability Matrix Summary

| Capability | MiniMax Support | Model/Endpoint | Via Chat Completions? |
|-----------|----------------|----------------|----------------------|
| Text generation | ✅ Excellent | M2.5, M2.1, M2 | ✅ Yes (Anthropic/OpenAI compatible) |
| Code generation | ✅ SOTA | M2.5 (80.2% SWE-Bench) | ✅ Yes |
| Reasoning | ✅ Strong | M1 (1M context), M2.5 | ✅ Yes |
| Image generation | ✅ Available | `image-01` | ❌ Separate REST endpoint |
| Image understanding | ⚠️ Limited | VL-01 (self-host) / MiniMax-01 (OpenRouter) | ❌ Not on MiniMax platform |
| Video generation | ✅ Available | Hailuo-02 | ❌ Separate endpoint / MCP |
| Speech synthesis | ✅ Available | Speech 2.6 | ❌ Separate endpoint |
| Music generation | ✅ Available | Music 2.5 | ❌ Separate endpoint |
| Tool calling | ✅ Full support | All M-series models | ✅ Yes |
| Multimodal input (images in chat) | ❌ Not on current models | Only legacy MiniMax-01 | Only via OpenRouter |

---

## Unresolved Questions

1. **Exact Coding Plan pricing tiers** — behind JS-rendered paywall, couldn't scrape specific dollar amounts
2. **Image generation pricing** — per-image cost for `image-01` not publicly documented in scraped data
3. **Will M2.5 or M3 add vision?** — No announcement found; current M-series is text-only
4. **MiniMax-VL-01 API availability** — unclear if/when vision model will return to their hosted API
5. **OpenAI-compatible base URL exact format** — confirmed `https://api.minimax.io/v1` from patterns but Anthropic SDK is the recommended/documented path
6. **Rate limits** — mentioned in docs but specific numbers not extracted

---

## Sources

- OpenRouter API (`/api/v1/models`) — live model metadata and pricing
- HuggingFace API (`/api/models?author=MiniMaxAI`) — model catalog
- HuggingFace READMEs: MiniMax-VL-01, MiniMax-M2, MiniMax-M2.5
- MiniMax Platform docs: `platform.minimax.io/docs/guides/text-generation`, `image-generation`
- MiniMax MCP Server: `github.com/MiniMax-AI/MiniMax-MCP`
- LiteLLM docs: `docs.litellm.ai/docs/providers/minimax`
- MiniMax website: `www.minimax.io`

