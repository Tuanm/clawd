/**
 * Multimodal Tool Helpers
 *
 * Pure TypeScript implementation using Gemini REST API via fetch().
 * No external script dependencies (Python, Node.js scripts, etc.).
 * Native tools (ffmpeg, ffprobe) are called via subprocess with sandbox support.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getEnvVar, loadConfigFile } from "../config-file";

// ============================================================================
// Constants
// ============================================================================

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_FILES_API = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const DEFAULT_VISION_MODEL = "gemini-2.5-flash";
const DEFAULT_IMAGE_GEN_MODEL = "gemini-3.1-flash-image-preview";
const MAX_RESULT_CHARS = 10_000;
const MAX_INLINE_SIZE = 20 * 1024 * 1024; // 20MB — Gemini inline limit
const MAX_UPLOAD_SIZE = 200 * 1024 * 1024; // 200MB — practical upload limit to avoid OOM

// Default daily image generation limit (conservative to avoid unexpected charges).
// Override via ~/.clawd/config.json: { "quotas": { "daily_image_limit": 50 } }
// Set to 0 to disable tracking (unlimited).
const DEFAULT_DAILY_IMAGE_LIMIT = 50;
const USAGE_FILE = join(homedir(), ".clawd", "usage.json");
const USAGE_TMP_FILE = `${USAGE_FILE}.tmp`;

// In-memory counter to mitigate TOCTOU race condition across concurrent requests
let _inFlightCount = 0;

// ============================================================================
// Image Generation Quota Tracking
// ============================================================================

interface UsageData {
  date: string; // YYYY-MM-DD in Pacific time (matches Google's quota reset)
  image_count: number;
}

/** Get today's date string in Pacific time (Google resets quotas at midnight PT).
 *  Uses formatToParts for spec-compliant YYYY-MM-DD output. */
function getTodayPT(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/** Load usage data from disk, resetting if the date has changed. */
function loadUsage(): UsageData {
  const today = getTodayPT();
  try {
    if (existsSync(USAGE_FILE)) {
      const raw = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as UsageData;
      if (
        raw.date === today &&
        typeof raw.image_count === "number" &&
        raw.image_count >= 0 &&
        Number.isFinite(raw.image_count)
      ) {
        return raw;
      }
    }
  } catch {
    // Corrupt file — reset
  }
  return { date: today, image_count: 0 };
}

/** Save usage data to disk using atomic write (temp + rename). */
function saveUsage(data: UsageData): boolean {
  try {
    const dir = join(homedir(), ".clawd");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(USAGE_TMP_FILE, JSON.stringify(data), "utf-8");
    renameSync(USAGE_TMP_FILE, USAGE_FILE);
    return true;
  } catch (err) {
    console.error("[clawd] Warning: Failed to save usage data:", (err as Error).message);
    try {
      if (existsSync(USAGE_TMP_FILE)) rmSync(USAGE_TMP_FILE);
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Get the configured daily image limit (0 = unlimited). */
function getDailyImageLimit(): number {
  const config = loadConfigFile();
  const limit = config.quotas?.daily_image_limit;
  if (typeof limit === "number" && limit >= 0 && Number.isFinite(limit)) {
    return limit;
  }
  return DEFAULT_DAILY_IMAGE_LIMIT;
}

/**
 * Check if image generation quota is available.
 * Returns null if OK, or an error message string if quota exceeded.
 * Includes in-flight requests to mitigate concurrent race conditions.
 */
function checkImageQuota(): string | null {
  const limit = getDailyImageLimit();
  if (limit === 0) return null; // Tracking disabled
  const usage = loadUsage();
  const effectiveCount = usage.image_count + _inFlightCount;
  if (effectiveCount >= limit) {
    return (
      `Daily image generation limit reached (${effectiveCount}/${limit}). ` +
      `Quota resets at midnight Pacific Time. ` +
      `To increase the limit, edit ~/.clawd/config.json: { "quotas": { "daily_image_limit": ${limit * 2} } }. ` +
      `Set to 0 to disable tracking (warning: may incur charges).`
    );
  }
  _inFlightCount += 1;
  return null;
}

/** Record one image generation in the usage tracker. Call after successful generation. */
function recordImageGeneration(): void {
  _inFlightCount = Math.max(0, _inFlightCount - 1);
  const usage = loadUsage();
  usage.image_count += 1;
  if (!saveUsage(usage)) {
    console.error("[clawd] Warning: Image generation recorded in memory but not persisted to disk.");
  }
}

/** Release in-flight counter on generation failure (no usage recorded). */
function releaseInFlight(): void {
  _inFlightCount = Math.max(0, _inFlightCount - 1);
}

/** Get current quota status (for informational display in tool results). */
export function getImageQuotaStatus(): { used: number; limit: number; remaining: number | null } {
  const limit = getDailyImageLimit();
  const usage = loadUsage();
  return {
    used: usage.image_count,
    limit,
    remaining: limit === 0 ? null : Math.max(0, limit - usage.image_count),
  };
}

// ============================================================================
// Config & Security
// ============================================================================

/** Get Gemini API key from config or environment */
function getGeminiApiKey(): string | undefined {
  return getEnvVar("GEMINI_API_KEY");
}

/** CPA (CLIProxyAPI) provider configuration for fallback image processing. */
interface CpaConfig {
  baseUrl: string;
  apiKey: string;
  imageModel: string;
  visionModel: string;
}

/** Get CPA provider config from ~/.clawd/config.json if configured. */
function getCpaConfig(): CpaConfig | null {
  const config = loadConfigFile();
  const cpa = config.providers?.cpa as Record<string, unknown> | undefined;
  if (
    !cpa ||
    typeof cpa.base_url !== "string" ||
    typeof cpa.api_key !== "string" ||
    (cpa.base_url as string).trim() === "" ||
    (cpa.api_key as string).trim() === ""
  )
    return null;
  const models = cpa.models as Record<string, string> | undefined;
  return {
    baseUrl: (cpa.base_url as string).trim().replace(/\/+$/, ""),
    apiKey: (cpa.api_key as string).trim(),
    imageModel: models?.["flash-image"] || models?.default || "gemini-3.1-flash-image",
    visionModel: models?.flash || models?.default || "gemini-3-flash",
  };
}

/** Sanitize CPA error messages to prevent API key leakage. */
function sanitizeCpaError(message: string, apiKey: string): string {
  const escaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escaped, "g"), "[REDACTED]");
}

/** Check if yolo mode is enabled (disables sandbox restrictions) */
function isYoloMode(): boolean {
  const config = loadConfigFile();
  return config.yolo === true;
}

/** Validate that a file path is within allowed directories (resolves symlinks) */
function isPathSafe(filePath: string, allowedDirs: string[]): boolean {
  if (isYoloMode()) return true;
  try {
    const realPath = realpathSync(filePath);
    return allowedDirs.some((dir) => {
      try {
        const realDir = realpathSync(dir);
        return realPath === realDir || realPath.startsWith(`${realDir}/`);
      } catch {
        const resolvedDir = resolve(dir);
        return realPath === resolvedDir || realPath.startsWith(`${resolvedDir}/`);
      }
    });
  } catch {
    // File doesn't exist yet (e.g., output path for generation) — check resolved path
    const resolved = resolve(filePath);
    return allowedDirs.some((dir) => {
      const resolvedDir = resolve(dir);
      return resolved === resolvedDir || resolved.startsWith(`${resolvedDir}/`);
    });
  }
}

/** Pre-flight check for Gemini API availability */
function checkGeminiPrereqs(): string | null {
  if (!getGeminiApiKey()) {
    return 'GEMINI_API_KEY not configured. Add to ~/.clawd/config.json: { "env": { "GEMINI_API_KEY": "your-key" } }';
  }
  return null;
}

// ============================================================================
// Subprocess Helper (sandbox-aware, no external scripts)
// ============================================================================

/** Run a native system command with timeout. Only used for ffmpeg/ffprobe. */
function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, stdout, stderr: "Process timed out", timedOut: true });
      } else {
        resolve({ ok: code === 0, stdout, stderr, timedOut: false });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

// ============================================================================
// Gemini REST API Client (pure TypeScript — no Python dependency)
// ============================================================================

/** Truncate output to prevent context bloat */
function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + `\n\n[Output truncated at ${MAX_RESULT_CHARS} characters]`;
}

/** Read file as base64 for Gemini inline data */
function fileToBase64(filePath: string): string {
  const buffer = readFileSync(filePath);
  return buffer.toString("base64");
}

/** Detect MIME type from file extension */
function detectMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    // Video
    mp4: "video/mp4",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
  };
  return mimeMap[ext] || "application/octet-stream";
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

/** Sanitize error messages to prevent API key leakage. */
function sanitizeError(message: string): string {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return message;
  const escaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escaped, "g"), "[REDACTED]");
}

/**
 * Call Gemini generateContent API directly via fetch().
 * Supports inline image/video data or file URIs from Files API.
 * Optional generationConfig for controlling response modalities (e.g., IMAGE output).
 */
async function callGeminiGenerateContent(
  model: string,
  parts: GeminiPart[],
  timeoutMs: number = 120_000,
  generationConfig?: Record<string, unknown>,
): Promise<{ ok: boolean; text?: string; imageData?: { mimeType: string; data: string }; error?: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY not configured" };

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody: Record<string, unknown> = {
      contents: [{ parts }],
    };
    if (generationConfig) {
      requestBody.generationConfig = generationConfig;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Gemini API error (${response.status}): ${sanitizeError(errorText).slice(0, 500)}` };
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      return { ok: false, error: sanitizeError(`Gemini API error: ${data.error.message}`) };
    }

    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.length) {
      return { ok: false, error: "Gemini returned empty response" };
    }

    // Determine if caller expects image output based on generationConfig
    const expectsImage =
      Array.isArray((generationConfig as Record<string, unknown> | undefined)?.responseModalities) &&
      ((generationConfig as Record<string, unknown>).responseModalities as string[]).includes("IMAGE");

    if (expectsImage) {
      // For image generation: prefer inlineData
      const imagePart = candidate.content.parts.find((p) => p.inlineData);
      if (imagePart?.inlineData) {
        return { ok: true, imageData: imagePart.inlineData };
      }
    }

    // For text/analysis: prefer text
    const textParts = candidate.content.parts.filter((p) => p.text).map((p) => p.text!);
    if (textParts.length > 0) {
      return { ok: true, text: truncateResult(textParts.join("\n")) };
    }

    // Fallback: check for image data even if not explicitly requested
    const imagePart = candidate.content.parts.find((p) => p.inlineData);
    if (imagePart?.inlineData) {
      return { ok: true, imageData: imagePart.inlineData };
    }

    return { ok: false, error: "Gemini returned no usable content" };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Request timed out" };
    }
    return {
      ok: false,
      error: sanitizeError(`Gemini API request failed: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
}

// ============================================================================
// CPA (CLIProxyAPI) Fallback — OpenAI-compatible image processing
// ============================================================================

/**
 * Call CPA provider for image generation/editing via OpenAI-compatible API.
 * Used as fallback when direct Gemini API fails.
 * CPA response format: message.images[].image_url.url = "data:{mime};base64,..."
 */
async function callCpaImageGeneration(
  prompt: string,
  sourceImagePath?: string,
  timeoutMs: number = 180_000,
): Promise<{ ok: boolean; imageData?: { mimeType: string; data: string }; error?: string }> {
  const cpa = getCpaConfig();
  if (!cpa) return { ok: false, error: "CPA provider not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build message content
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

    // For image editing: include source image as inline data
    if (sourceImagePath) {
      const mimeType = detectMimeType(sourceImagePath);
      const base64 = fileToBase64(sourceImagePath);
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64}` },
      });
    }

    const response = await fetch(`${cpa.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cpa.apiKey}`,
      },
      body: JSON.stringify({
        model: cpa.imageModel,
        messages: [{ role: "user", content }],
        modalities: ["text", "image"],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `CPA API error (${response.status}): ${sanitizeCpaError(errorText, cpa.apiKey).slice(0, 500)}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          images?: Array<{ image_url?: { url?: string } }>;
        };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      return { ok: false, error: sanitizeCpaError(`CPA API error: ${data.error.message}`, cpa.apiKey) };
    }

    const images = data.choices?.[0]?.message?.images;
    if (!images?.length) {
      return { ok: false, error: "CPA returned no image data" };
    }

    const imageUrl = images[0].image_url?.url;
    if (!imageUrl?.startsWith("data:")) {
      return { ok: false, error: "CPA returned unsupported image format" };
    }

    // Parse data URI: "data:image/png;base64,iVBOR..."
    const commaIdx = imageUrl.indexOf(",");
    if (commaIdx === -1) return { ok: false, error: "CPA returned malformed data URI" };
    const header = imageUrl.slice(0, commaIdx); // "data:image/png;base64"
    const base64Data = imageUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/^data:([^;]+)/);
    const mimeType = mimeMatch?.[1] || "image/png";

    return { ok: true, imageData: { mimeType, data: base64Data } };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "CPA request timed out" };
    }
    return {
      ok: false,
      error: sanitizeCpaError(`CPA request failed: ${err instanceof Error ? err.message : String(err)}`, cpa.apiKey),
    };
  }
}

/**
 * Call CPA provider for image analysis (vision) via OpenAI-compatible API.
 * Used as fallback when direct Gemini vision API fails.
 */
async function callCpaVisionAnalysis(
  filePath: string,
  prompt: string,
  timeoutMs: number = 120_000,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const cpa = getCpaConfig();
  if (!cpa) return { ok: false, error: "CPA provider not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const mimeType = detectMimeType(filePath);
    const base64 = fileToBase64(filePath);

    const response = await fetch(`${cpa.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cpa.apiKey}`,
      },
      body: JSON.stringify({
        model: cpa.visionModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `CPA vision error (${response.status}): ${sanitizeCpaError(errorText, cpa.apiKey).slice(0, 500)}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message: string };
    };

    if (data.error) {
      return { ok: false, error: sanitizeCpaError(`CPA vision error: ${data.error.message}`, cpa.apiKey) };
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) return { ok: false, error: "CPA returned empty vision response" };

    return { ok: true, text: truncateResult(text) };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "CPA vision request timed out" };
    }
    return {
      ok: false,
      error: sanitizeCpaError(
        `CPA vision request failed: ${err instanceof Error ? err.message : String(err)}`,
        cpa.apiKey,
      ),
    };
  }
}

/**
 * Upload a file to Gemini Files API for large files (>20MB).
 * Returns a file URI for use in generateContent.
 */
async function uploadToGeminiFilesAPI(
  filePath: string,
  mimeType: string,
): Promise<{ ok: boolean; fileUri?: string; error?: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY not configured" };

  const fileSize = statSync(filePath).size;
  if (fileSize > MAX_UPLOAD_SIZE) {
    return {
      ok: false,
      error: `File too large for upload (${Math.round(fileSize / 1024 / 1024)}MB > ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit)`,
    };
  }

  const fileData = readFileSync(filePath);
  const displayName = filePath.split("/").pop() || "file";

  // Resumable upload: initiate
  const initUrl = `${GEMINI_FILES_API}?key=${apiKey}`;
  const initController = new AbortController();
  const initTimer = setTimeout(() => initController.abort(), 30_000);

  let initResponse: Response;
  try {
    initResponse = await fetch(initUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileData.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({ file: { displayName } }),
      signal: initController.signal,
    });
  } catch (err: unknown) {
    clearTimeout(initTimer);
    return {
      ok: false,
      error: sanitizeError(`Files API init request failed: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
  clearTimeout(initTimer);

  if (!initResponse.ok) {
    return { ok: false, error: `Files API init failed: ${initResponse.status}` };
  }

  const uploadUrl = initResponse.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) {
    return { ok: false, error: "Files API did not return upload URL" };
  }

  // Upload file data
  const uploadController = new AbortController();
  const uploadTimer = setTimeout(() => uploadController.abort(), 300_000); // 5 min for large files

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileData.byteLength),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: fileData,
      signal: uploadController.signal,
    });
  } catch (err: unknown) {
    clearTimeout(uploadTimer);
    return {
      ok: false,
      error: sanitizeError(`File upload failed: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
  clearTimeout(uploadTimer);

  if (!uploadResponse.ok) {
    return { ok: false, error: `File upload failed: ${uploadResponse.status}` };
  }

  const result = (await uploadResponse.json()) as { file?: { uri?: string; state?: string } };
  if (!result.file?.uri) {
    return { ok: false, error: "Upload succeeded but no file URI returned" };
  }

  // Wait for file processing (poll until ACTIVE)
  const fileName = result.file.uri.split("/").pop();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollController = new AbortController();
    const pollTimer = setTimeout(() => pollController.abort(), 10_000);
    try {
      const statusResp = await fetch(`${GEMINI_API_BASE}/files/${fileName}?key=${apiKey}`, {
        signal: pollController.signal,
      });
      clearTimeout(pollTimer);
      if (statusResp.ok) {
        const statusData = (await statusResp.json()) as { state?: string; uri?: string };
        if (statusData.state === "ACTIVE") {
          return { ok: true, fileUri: statusData.uri || result.file.uri };
        }
        if (statusData.state === "FAILED") {
          return { ok: false, error: "File processing failed on Gemini servers" };
        }
      }
    } catch {
      clearTimeout(pollTimer);
      // Continue polling on timeout
    }
  }

  return { ok: false, error: "File processing timed out (60s)" };
}

// ============================================================================
// Public API — Image Analysis
// ============================================================================

export async function analyzeImage(
  filePath: string,
  prompt: string,
  allowedDirs: string[],
): Promise<{ ok: boolean; result?: string; error?: string }> {
  if (!existsSync(filePath)) return { ok: false, error: "File not found on disk" };
  if (!isPathSafe(filePath, allowedDirs)) {
    return { ok: false, error: "File path not within allowed directories" };
  }

  const mimeType = detectMimeType(filePath);
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return { ok: false, error: `File is not an image (${mimeType})` };
  }

  // Try Gemini first (if API key configured)
  const geminiKey = getGeminiApiKey();
  if (geminiKey) {
    const geminiResult = await analyzeImageViaGemini(filePath, mimeType, prompt);
    if (geminiResult.ok) return geminiResult;
    // Gemini failed — try CPA fallback
    const cpa = getCpaConfig();
    if (cpa) {
      const cpaResult = await callCpaVisionAnalysis(filePath, prompt);
      if (cpaResult.ok) return { ok: true, result: cpaResult.text };
    }
    return geminiResult; // return Gemini error
  }

  // No Gemini — try CPA directly
  const cpa = getCpaConfig();
  if (cpa) {
    const cpaResult = await callCpaVisionAnalysis(filePath, prompt);
    if (cpaResult.ok) return { ok: true, result: cpaResult.text };
    return { ok: false, error: cpaResult.error };
  }

  return {
    ok: false,
    error:
      "No image analysis provider configured. Add GEMINI_API_KEY in ~/.clawd/config.json or configure a CPA provider",
  };
}

/** Internal: analyze image via direct Gemini API. */
async function analyzeImageViaGemini(
  filePath: string,
  mimeType: string,
  prompt: string,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const fileSize = statSync(filePath).size;
  let parts: GeminiPart[];
  if (fileSize <= MAX_INLINE_SIZE) {
    const base64 = fileToBase64(filePath);
    parts = [{ text: prompt }, { inlineData: { mimeType, data: base64 } }];
  } else {
    const upload = await uploadToGeminiFilesAPI(filePath, mimeType);
    if (!upload.ok) return { ok: false, error: upload.error };
    parts = [{ text: prompt }, { fileData: { mimeType, fileUri: upload.fileUri! } }];
  }
  const result = await callGeminiGenerateContent(DEFAULT_VISION_MODEL, parts, 120_000);
  return { ok: result.ok, result: result.text, error: result.error };
}

// ============================================================================
// Public API — Image Generation & Editing
// ============================================================================

/** Generate a new image from a text prompt.
 *  Primary: CPA provider (if configured). Fallback: direct Gemini API (if GEMINI_API_KEY set). */
export async function generateImage(
  prompt: string,
  outputPath: string,
  aspectRatio: string = "1:1",
  allowedDirs: string[],
  imageSize: string = "1K",
): Promise<{ ok: boolean; path?: string; mimeType?: string; error?: string }> {
  if (!isPathSafe(outputPath, allowedDirs)) {
    return { ok: false, error: "Output path not within allowed directories" };
  }

  // Try Gemini first (with quota check)
  const geminiKey = getGeminiApiKey();
  if (geminiKey) {
    const quotaError = checkImageQuota();
    if (!quotaError) {
      const geminiResult = await generateImageViaGemini(prompt, outputPath, aspectRatio, imageSize);
      if (geminiResult.ok) {
        recordImageGeneration();
        return geminiResult;
      }
      releaseInFlight();
    }
    // Gemini failed or quota exceeded — try CPA fallback (no quota limit for CPA)
    const cpa = getCpaConfig();
    if (cpa) {
      const cpaResult = await callCpaImageGeneration(prompt);
      if (cpaResult.ok) {
        let saved: { ok: boolean; path?: string; mimeType?: string; error?: string };
        try {
          saved = saveImageResult(cpaResult, outputPath);
        } catch (err) {
          return { ok: false, error: `Failed to save CPA image: ${err instanceof Error ? err.message : String(err)}` };
        }
        return saved;
      }
    }
    if (quotaError) return { ok: false, error: quotaError };
    return { ok: false, error: "Image generation failed on all available providers" };
  }

  // No Gemini — try CPA directly (no quota limit for CPA)
  const cpa = getCpaConfig();
  if (cpa) {
    const cpaResult = await callCpaImageGeneration(prompt);
    if (cpaResult.ok) {
      let saved: { ok: boolean; path?: string; mimeType?: string; error?: string };
      try {
        saved = saveImageResult(cpaResult, outputPath);
      } catch (err) {
        return { ok: false, error: `Failed to save CPA image: ${err instanceof Error ? err.message : String(err)}` };
      }
      return saved;
    }
    return { ok: false, error: cpaResult.error || "CPA image generation failed" };
  }

  return {
    ok: false,
    error:
      "No image generation provider configured. Add GEMINI_API_KEY in ~/.clawd/config.json or configure a CPA provider",
  };
}

/** Internal: generate image via direct Gemini API. */
async function generateImageViaGemini(
  prompt: string,
  outputPath: string,
  aspectRatio: string,
  imageSize: string,
): Promise<{ ok: boolean; path?: string; mimeType?: string; error?: string }> {
  const parts: GeminiPart[] = [{ text: prompt }];
  const genConfig: Record<string, unknown> = {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio, imageSize },
  };
  const result = await callGeminiGenerateContent(DEFAULT_IMAGE_GEN_MODEL, parts, 180_000, genConfig);
  try {
    return saveImageResult(result, outputPath);
  } catch (err) {
    return { ok: false, error: `Failed to save image: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Edit an existing image based on a text prompt.
 *  Primary: CPA provider (if configured). Fallback: direct Gemini API (if GEMINI_API_KEY set).
 *  The source image is read internally by file path — the caller (agent) never sees image content. */
export async function editImage(
  sourceFilePath: string,
  prompt: string,
  outputPath: string,
  allowedDirs: string[],
): Promise<{ ok: boolean; path?: string; mimeType?: string; error?: string }> {
  if (!existsSync(sourceFilePath)) {
    return { ok: false, error: "Source image not found on disk" };
  }
  if (!isPathSafe(sourceFilePath, allowedDirs)) {
    return { ok: false, error: "Source file path not within allowed directories" };
  }
  if (!isPathSafe(outputPath, allowedDirs)) {
    return { ok: false, error: "Output path not within allowed directories" };
  }

  const mimeType = detectMimeType(sourceFilePath);
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return { ok: false, error: `Source file is not an image (${mimeType})` };
  }

  const fileSize = statSync(sourceFilePath).size;
  if (fileSize > MAX_INLINE_SIZE) {
    return {
      ok: false,
      error: `Source image too large (${Math.round(fileSize / 1024 / 1024)}MB > ${MAX_INLINE_SIZE / 1024 / 1024}MB limit)`,
    };
  }

  // Try Gemini first (with quota check)
  const geminiKey = getGeminiApiKey();
  if (geminiKey) {
    const quotaError = checkImageQuota();
    if (!quotaError) {
      const geminiResult = await editImageViaGemini(sourceFilePath, mimeType, prompt, outputPath);
      if (geminiResult.ok) {
        recordImageGeneration();
        return geminiResult;
      }
      releaseInFlight();
    }
    // Gemini failed or quota exceeded — try CPA fallback (no quota limit for CPA)
    const cpa = getCpaConfig();
    if (cpa) {
      const cpaResult = await callCpaImageGeneration(prompt, sourceFilePath);
      if (cpaResult.ok) {
        let saved: { ok: boolean; path?: string; mimeType?: string; error?: string };
        try {
          saved = saveImageResult(cpaResult, outputPath);
        } catch (err) {
          return {
            ok: false,
            error: `Failed to save CPA edited image: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return saved;
      }
    }
    if (quotaError) return { ok: false, error: quotaError };
    return { ok: false, error: "Image editing failed on all available providers" };
  }

  // No Gemini — try CPA directly (no quota limit for CPA)
  const cpa = getCpaConfig();
  if (cpa) {
    const cpaResult = await callCpaImageGeneration(prompt, sourceFilePath);
    if (cpaResult.ok) {
      let saved: { ok: boolean; path?: string; mimeType?: string; error?: string };
      try {
        saved = saveImageResult(cpaResult, outputPath);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to save CPA edited image: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return saved;
    }
    return { ok: false, error: cpaResult.error || "CPA image editing failed" };
  }

  return {
    ok: false,
    error: "No image editing provider configured. Add GEMINI_API_KEY in ~/.clawd/config.json or configure a CPA provider",
  };
}

/** Internal: edit image via direct Gemini API. */
async function editImageViaGemini(
  sourceFilePath: string,
  mimeType: string,
  prompt: string,
  outputPath: string,
): Promise<{ ok: boolean; path?: string; mimeType?: string; error?: string }> {
  const base64 = fileToBase64(sourceFilePath);
  const parts: GeminiPart[] = [{ text: prompt }, { inlineData: { mimeType, data: base64 } }];
  const genConfig: Record<string, unknown> = {
    responseModalities: ["IMAGE"],
  };
  const result = await callGeminiGenerateContent(DEFAULT_IMAGE_GEN_MODEL, parts, 180_000, genConfig);
  try {
    return saveImageResult(result, outputPath);
  } catch (err) {
    return { ok: false, error: `Failed to save edited image: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Save image data from a Gemini response to disk. */
function saveImageResult(
  result: { ok: boolean; imageData?: { mimeType: string; data: string }; error?: string },
  outputPath: string,
): { ok: boolean; path?: string; mimeType?: string; error?: string } {
  if (!result.ok || !result.imageData) {
    return { ok: false, error: result.error || "No image generated" };
  }

  const mimeType = result.imageData.mimeType || "image/png";
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  const hasExtension = /\.[^./]+$/.test(outputPath);
  const finalPath = hasExtension ? outputPath.replace(/\.[^.]+$/, ext) : outputPath + ext;

  try {
    const imageBuffer = Buffer.from(result.imageData.data, "base64");
    writeFileSync(finalPath, imageBuffer);
    return { ok: true, path: finalPath, mimeType };
  } catch (err) {
    return { ok: false, error: `Failed to write image file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================================================
// Public API — Video Analysis
// ============================================================================

/** Get video duration using ffprobe (native system tool) */
async function getVideoDuration(filePath: string): Promise<number> {
  const result = await spawnWithTimeout(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    10_000,
  );
  if (result.ok && result.stdout.trim()) {
    const duration = parseFloat(result.stdout.trim());
    return isNaN(duration) ? 60 : duration;
  }
  return 60;
}

export async function analyzeVideo(
  filePath: string,
  prompt: string,
  allowedDirs: string[],
  maxFrames: number = 30,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const prereqError = checkGeminiPrereqs();
  if (prereqError) return { ok: false, error: prereqError };

  if (!existsSync(filePath)) return { ok: false, error: "File not found on disk" };
  if (!isPathSafe(filePath, allowedDirs)) {
    return { ok: false, error: "File path not within allowed directories" };
  }

  const mimeType = detectMimeType(filePath);
  if (!mimeType.toLowerCase().startsWith("video/")) {
    return { ok: false, error: `File is not a video (${mimeType})` };
  }
  const fileSize = statSync(filePath).size;

  // Try direct upload to Gemini (for files within upload size limit)
  if (fileSize <= MAX_UPLOAD_SIZE) {
    const upload = await uploadToGeminiFilesAPI(filePath, mimeType);
    if (upload.ok) {
      const parts: GeminiPart[] = [{ text: prompt }, { fileData: { mimeType, fileUri: upload.fileUri! } }];
      const result = await callGeminiGenerateContent(DEFAULT_VISION_MODEL, parts, 300_000);
      if (result.ok) return { ok: true, result: result.text };
    }
  }

  // Fallback: extract frames with ffmpeg and analyze as images
  return analyzeVideoFrames(filePath, prompt, allowedDirs, maxFrames);
}

async function analyzeVideoFrames(
  filePath: string,
  prompt: string,
  allowedDirs: string[],
  maxFrames: number,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const framesDir = join(tmpdir(), `clawd-frames-${Date.now()}`);
  mkdirSync(framesDir, { recursive: true });

  try {
    const duration = await getVideoDuration(filePath);
    const fps = Math.max(0.01, maxFrames / duration);

    const extractResult = await spawnWithTimeout(
      "ffmpeg",
      ["-i", filePath, "-vf", `fps=${fps},scale=1280:-1`, "-q:v", "2", join(framesDir, "frame_%04d.jpg")],
      120_000,
    );

    if (!extractResult.ok) {
      return { ok: false, error: `Frame extraction failed: ${extractResult.stderr.slice(0, 300)}` };
    }

    const frames = readdirSync(framesDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (frames.length === 0) {
      return { ok: false, error: "No frames extracted from video" };
    }

    // Build parts with frame images (inline base64)
    const parts: GeminiPart[] = [
      { text: `${prompt}\n\nAnalyze these ${frames.length} frames extracted from a video:` },
    ];
    for (const frame of frames.slice(0, maxFrames)) {
      const framePath = join(framesDir, frame);
      const base64 = fileToBase64(framePath);
      parts.push({ inlineData: { mimeType: "image/jpeg", data: base64 } });
    }

    const result = await callGeminiGenerateContent(DEFAULT_VISION_MODEL, parts, 120_000);
    return { ok: result.ok, result: result.text, error: result.error };
  } finally {
    try {
      rmSync(framesDir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-fatal
    }
  }
}
