import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { screenshotTool, cleanupScreenshot } from "./observe";
import { getVisionConfig, getEnv } from "../config";
import { getCurrentControlMode, isExtensionPopupDetected } from "../engines/playwright";

interface VisionResult {
  description: string;
  context_changed: boolean;
  control_mode: "structured" | "vision";
  active_context: string;
  hint?: string;
}

/**
 * Analyze an image using the configured vision provider (from vision.read_image config).
 * Supports Copilot (GPT-4.1) and OpenAI-compatible vision APIs.
 */
async function analyzeImageWithVision(imagePath: string, prompt: string): Promise<string> {
  const config = getVisionConfig();
  if (!config) {
    throw new Error(
      'Vision provider not configured. Set "vision.read_image" in ~/.clawd/config.json ' +
      "(e.g., copilot with gpt-4.1 or gemini with a vision model).",
    );
  }

  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString("base64");

  // Build headers — Copilot requires special headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.api_key}`,
  };

  if (config.provider === "copilot") {
    headers["Accept"] = "application/json";
    headers["X-Interaction-Type"] = "conversation-agent";
    headers["Openai-Intent"] = "conversation-agent";
    headers["X-Initiator"] = "agent";
    headers["X-GitHub-Api-Version"] = "2025-05-01";
    headers["Copilot-Integration-Id"] = "copilot-developer-cli";
    headers["User-Agent"] = "Claw'd/1.0.0";
  }

  // Copilot uses /chat/completions, others use /v1/chat/completions
  const baseUrl = config.base_url.replace(/\/+$/, "");
  const endpoint = config.provider === "copilot"
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vision API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return data.choices?.[0]?.message?.content || "";
}

export async function observeTool(): Promise<VisionResult> {
  const { path } = await screenshotTool();
  try {
    const description = await analyzeImageWithVision(
      path,
      "Describe exactly what you see on screen. List all visible UI elements, buttons, text, dialogs, and their positions. Be specific and structured.",
    );
    return {
      description,
      context_changed: isExtensionPopupDetected(),
      control_mode: getCurrentControlMode(),
      active_context: isExtensionPopupDetected() ? "extension_popup" : "browser",
    };
  } finally {
    cleanupScreenshot(path);
  }
}

export async function visionClickCoords(description: string, retries = 3): Promise<{ x: number; y: number }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { path } = await screenshotTool();
    try {
      const response = await analyzeImageWithVision(
        path,
        `Find the element matching this description: "${description}". Return ONLY a JSON object with x and y pixel coordinates of the center of that element. Example: {"x": 640, "y": 512}. Nothing else.`,
      );
      cleanupScreenshot(path);

      // Parse coordinates — try JSON.parse first (handles any key order)
      try {
        const jsonMatch = response.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.x === "number" && typeof parsed.y === "number") {
            return { x: parsed.x, y: parsed.y };
          }
        }
      } catch {}
      // Fallback regex patterns
      const match = response.match(/"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)/);
      if (match) {
        return { x: parseInt(match[1]), y: parseInt(match[2]) };
      }
      const altMatch = response.match(/"y"\s*:\s*(\d+)[^}]*"x"\s*:\s*(\d+)/);
      if (altMatch) {
        return { x: parseInt(altMatch[2]), y: parseInt(altMatch[1]) };
      }
    } catch (e) {
      cleanupScreenshot(path);
      if (attempt === retries) throw e;
    }
  }
  throw new Error(`Failed to locate element after ${retries} attempts: ${description}`);
}
