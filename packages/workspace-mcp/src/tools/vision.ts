import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { screenshotTool, cleanupScreenshot } from './observe';
import { getCpaConfig, getEnv } from '../config';
import { getCurrentControlMode, isExtensionPopupDetected } from '../engines/playwright';

interface VisionResult {
  description: string;
  context_changed: boolean;
  control_mode: 'structured' | 'vision';
  active_context: string;
  hint?: string;
}

async function analyzeImageWithCpa(imagePath: string, prompt: string): Promise<string> {
  const cpa = getCpaConfig();
  if (!cpa) throw new Error('CPA provider not configured in /etc/clawd/config.json');

  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');

  const model = cpa.models?.['flash'] || cpa.models?.['default'] || 'gemini-3-flash';
  const response = await fetch(`${cpa.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cpa.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vision API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

export async function observeTool(): Promise<VisionResult> {
  const { path } = await screenshotTool();
  try {
    const description = await analyzeImageWithCpa(
      path,
      'Describe exactly what you see on screen. List all visible UI elements, buttons, text, dialogs, and their positions. Be specific and structured.'
    );
    return {
      description,
      context_changed: isExtensionPopupDetected(),
      control_mode: getCurrentControlMode(),
      active_context: isExtensionPopupDetected() ? 'extension_popup' : 'browser',
    };
  } finally {
    cleanupScreenshot(path);
  }
}

export async function visionClickCoords(description: string, retries = 3): Promise<{ x: number; y: number }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { path } = await screenshotTool();
    try {
      const response = await analyzeImageWithCpa(
        path,
        `Find the element matching this description: "${description}". Return ONLY a JSON object with x and y pixel coordinates of the center of that element. Example: {"x": 640, "y": 512}. Nothing else.`
      );
      cleanupScreenshot(path);

      // Parse coordinates — try JSON.parse first (handles any key order)
      try {
        const jsonMatch = response.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
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
