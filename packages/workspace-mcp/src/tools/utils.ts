import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DISPLAY_ENV = { ...process.env, DISPLAY: process.env.DISPLAY || ':99' };

export interface ClipboardResult { content?: string; success: boolean }

export async function clipboardTool(action: 'get' | 'set', text?: string, mimeType = 'text/plain'): Promise<ClipboardResult> {
  if (action === 'set') {
    if (!text) throw new Error('text required for clipboard set');
    // xclip stays running as clipboard owner — must spawn detached so it doesn't block
    const proc = spawn('xclip', ['-selection', 'clipboard', '-t', mimeType], {
      env: DISPLAY_ENV,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
    proc.unref();
    return { success: true };
  } else {
    try {
      const content = execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
        encoding: 'utf-8', env: DISPLAY_ENV, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return { content, success: true };
    } catch {
      return { content: '', success: true };
    }
  }
}

export async function totpCodeTool(account: string): Promise<{ code: string; expires_in_seconds: number }> {
  const secretsFile = '/data/.totp-secrets.json';
  if (!existsSync(secretsFile)) throw new Error('No TOTP secrets configured at /data/.totp-secrets.json');

  const secrets = JSON.parse(readFileSync(secretsFile, 'utf-8')) as Record<string, string>;
  const secret = secrets[account];
  if (!secret) throw new Error(`No TOTP secret configured for account: ${account}`);

  const code = execFileSync('oathtool', ['--totp', '--base32', secret], { encoding: 'utf-8' }).trim();
  // TOTP codes expire every 30s, calculate seconds remaining
  const epoch = Math.floor(Date.now() / 1000);
  const expiresIn = 30 - (epoch % 30);
  return { code, expires_in_seconds: expiresIn };
}

export async function filedialogTool(path: string, action: 'open' | 'save' = 'open'): Promise<{ success: boolean }> {
  // Wait for a file dialog to appear, then type the path
  try {
    // Try Ctrl+L (open path bar in GTK/Qt dialogs)
    execFileSync('xdotool', ['key', 'ctrl+l'], { env: DISPLAY_ENV });
    await new Promise(r => setTimeout(r, 200));
    // Use two separate calls to avoid shell injection
    execFileSync('xdotool', ['type', '--clearmodifiers', '--', path], { env: DISPLAY_ENV });
    execFileSync('xdotool', ['key', 'Return'], { env: DISPLAY_ENV });
    return { success: true };
  } catch (e: any) {
    throw new Error(`File dialog interaction failed: ${e.message}`);
  }
}

export async function windowManageTool(
  action: 'list' | 'focus' | 'resize' | 'close' | 'minimize' | 'maximize',
  windowId?: string,
  width?: number,
  height?: number
): Promise<{ windows?: Array<{ id: string; title: string; pid: number }>; success: boolean }> {
  switch (action) {
    case 'list': {
      try {
        const out = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf-8', env: DISPLAY_ENV });
        const windows = out.trim().split('\n').filter(Boolean).map(line => {
          const parts = line.split(/\s+/);
          return { id: parts[0], pid: parseInt(parts[2] || '0'), title: parts.slice(4).join(' ') };
        });
        return { windows, success: true };
      } catch {
        // wmctrl fails if WM hasn't initialized EWMH yet (e.g., Playwright context)
        return { windows: [], success: true };
      }
    }
    case 'focus':
      if (!windowId) throw new Error('windowId required for focus');
      execFileSync('wmctrl', ['-ia', windowId], { env: DISPLAY_ENV });
      return { success: true };
    case 'close':
      if (!windowId) throw new Error('windowId required for close');
      execFileSync('xdotool', ['windowclose', windowId], { env: DISPLAY_ENV });
      return { success: true };
    case 'minimize':
      if (!windowId) throw new Error('windowId required for minimize');
      execFileSync('xdotool', ['windowminimize', windowId], { env: DISPLAY_ENV });
      return { success: true };
    case 'maximize':
      if (!windowId) throw new Error('windowId required for maximize');
      execFileSync('xdotool', ['windowmaximize', windowId], { env: DISPLAY_ENV });
      return { success: true };
    case 'resize':
      if (!windowId || !width || !height) throw new Error('windowId, width, and height required for resize');
      execFileSync('wmctrl', ['-ir', windowId, '-e', `0,-1,-1,${width},${height}`], { env: DISPLAY_ENV });
      return { success: true };
    default:
      throw new Error(`Unknown window action: ${action}`);
  }
}
