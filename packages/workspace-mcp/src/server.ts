import express, { type Request, type Response, type NextFunction } from 'express';
import { registerHealthEndpoint } from './health';
import { getAuthToken } from './config';
import { visionClickCoords } from './tools/vision';

// Tool imports
import { launchBrowserTool, launchAppTool, snapshotTool, waitTool, handleDialogTool } from './tools/browser';
import { clickTool, typeTextTool, pressKeyTool, selectOptionTool, dragTool } from './tools/interact';
import { screenshotTool, getContextTool } from './tools/observe';
import { observeTool } from './tools/vision';
import { clipboardTool, totpCodeTool, filedialogTool, windowManageTool } from './tools/utils';
import { pauseForHuman, signalResume } from './tools/handoff';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Auth middleware (skip if no token configured — dev mode)
app.use((req: Request, res: Response, next: NextFunction) => {
  const token = getAuthToken();
  if (!token) { next(); return; }
  if (req.path === '/health') { next(); return; }
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

registerHealthEndpoint(app);

// Resume handoff endpoint
app.post('/handoff/resume', (_req: Request, res: Response) => {
  signalResume();
  res.json({ ok: true });
});

// ============================================================================
// Tool Definitions (MCP protocol)
// ============================================================================

const TOOLS = [
  {
    name: 'launch_browser',
    description: 'Open a URL in the shared Chrome browser (or open a new tab). Starts browser if not already running.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to (optional — opens blank tab if omitted)' },
      },
    },
  },
  {
    name: 'launch_app',
    description: 'Start a native application (e.g., code, libreoffice, gedit).',
    inputSchema: {
      type: 'object',
      required: ['app'],
      properties: {
        app: { type: 'string', description: 'Application executable name or path' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments' },
      },
    },
  },
  {
    name: 'snapshot',
    description: 'Get the accessibility tree of the current browser page. Best for understanding page structure and finding element references.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the entire display. Returns the file path. Use read_image tool to analyze the screenshot content.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'observe',
    description: 'Take a screenshot and analyze it with vision AI. Returns a structured description of what is visible on screen. Use when snapshot() is insufficient (e.g., extension popups, native apps).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'click',
    description: 'Click an element. Priority: ref (fastest, uses Playwright CSS selector) > coordinates (x,y with xdotool) > description (slowest, uses vision AI to locate). Only provide ONE of these.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'CSS selector or Playwright locator (e.g., "button#submit", "text=Connect Wallet")' },
        x: { type: 'number', description: 'X coordinate (use with y)' },
        y: { type: 'number', description: 'Y coordinate (use with x)' },
        description: { type: 'string', description: 'Natural language description of the element (uses vision AI, most expensive)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        doubleClick: { type: 'boolean', description: 'Double click (default: false)' },
      },
    },
  },
  {
    name: 'type_text',
    description: 'Type text at the current focus position.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text to type' },
        use_xdotool: { type: 'boolean', description: 'Use xdotool instead of Playwright (needed for extension popups)' },
      },
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or combination (e.g., "Enter", "Ctrl+C", "Tab", "Escape").',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Key name or combo (Playwright format for web, xdotool format for native)' },
        use_xdotool: { type: 'boolean', description: 'Use xdotool instead of Playwright' },
      },
    },
  },
  {
    name: 'select_option',
    description: 'Select a value from a dropdown/select element.',
    inputSchema: {
      type: 'object',
      required: ['ref', 'value'],
      properties: {
        ref: { type: 'string', description: 'CSS selector for the select element' },
        value: { type: 'string', description: 'Value to select' },
      },
    },
  },
  {
    name: 'drag',
    description: 'Drag from one point to another using coordinates.',
    inputSchema: {
      type: 'object',
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      properties: {
        from_x: { type: 'number' },
        from_y: { type: 'number' },
        to_x: { type: 'number' },
        to_y: { type: 'number' },
      },
    },
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss a browser alert/confirm/prompt dialog.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        prompt_text: { type: 'string', description: 'Text to enter for prompt dialogs' },
      },
    },
  },
  {
    name: 'wait',
    description: 'Wait for a condition: an element to appear (selector), text to be present, or just wait for a duration.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text to wait for in page body' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 3000, max: 60000)' },
      },
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a specific element in a given direction.',
    inputSchema: {
      type: 'object',
      required: ['direction'],
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        selector: { type: 'string', description: 'Scroll within a specific element (default: window)' },
      },
    },
  },
  {
    name: 'get_context',
    description: 'Get current workspace state: active context, control mode (structured/vision), current URL, and hints for next actions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'window_manage',
    description: 'List, focus, resize, close, minimize, or maximize windows.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'focus', 'resize', 'close', 'minimize', 'maximize'] },
        window_id: { type: 'string', description: 'Window ID from list action' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
    },
  },
  {
    name: 'clipboard',
    description: 'Get or set clipboard content.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        text: { type: 'string', description: 'Text to set (required for set action)' },
        mime_type: { type: 'string', description: 'MIME type (default: text/plain)' },
      },
    },
  },
  {
    name: 'file_dialog',
    description: 'Interact with a native OS file open/save dialog by typing a file path.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path to enter in the dialog' },
        action: { type: 'string', enum: ['open', 'save'], description: 'Dialog type (default: open)' },
      },
    },
  },
  {
    name: 'totp_code',
    description: 'Generate a TOTP 2FA code for a configured account.',
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: {
        account: { type: 'string', description: 'Account name from TOTP secrets store' },
      },
    },
  },
  {
    name: 'pause_for_human',
    description: 'Pause agent execution and wait for human input (e.g., CAPTCHA, hardware 2FA, manual confirmation). Provides noVNC link for direct browser access.',
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'Why human input is needed' },
        instructions: { type: 'string', description: 'What the human should do' },
        timeout_seconds: { type: 'number', description: 'How long to wait before timing out (default: 300)' },
      },
    },
  },
];

// ============================================================================
// JSON-RPC Handler
// ============================================================================

async function handleToolCall(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case 'launch_browser':
      return launchBrowserTool(args.url);
    case 'launch_app':
      return launchAppTool(args.app, args.args);
    case 'snapshot':
      return snapshotTool();
    case 'screenshot': {
      const { path, width, height } = await screenshotTool();
      return { path, width, height, hint: 'Use read_image tool with this path to analyze screenshot content' };
    }
    case 'observe':
      return observeTool();
    case 'click':
      return clickTool(
        { ref: args.ref, x: args.x, y: args.y, description: args.description, button: args.button, doubleClick: args.doubleClick },
        visionClickCoords
      );
    case 'type_text':
      return typeTextTool(args.text, args.use_xdotool);
    case 'press_key':
      return pressKeyTool(args.key, args.use_xdotool);
    case 'select_option':
      return selectOptionTool(args.ref, args.value);
    case 'drag':
      return dragTool(args.from_x, args.from_y, args.to_x, args.to_y);
    case 'handle_dialog':
      return handleDialogTool(args.action, args.prompt_text);
    case 'wait':
      return waitTool(args.selector, args.text, Math.min(args.timeout_ms ?? 3000, 60000));
    case 'scroll': {
      const direction = args.direction as 'up' | 'down' | 'left' | 'right';
      const amount = (args.amount as number) || 500;
      const page = await (await import('./engines/playwright')).getActivePage();
      if (args.selector) {
        await page.locator(args.selector).first().evaluate((el: Element, [dir, amt]: [string, number]) => {
          el.scrollBy(
            dir === 'left' ? -amt : dir === 'right' ? amt : 0,
            dir === 'up' ? -amt : dir === 'down' ? amt : 0
          );
        }, [direction, amount] as [string, number]);
      } else {
        await page.mouse.wheel(
          direction === 'left' ? -amount : direction === 'right' ? amount : 0,
          direction === 'up' ? -amount : direction === 'down' ? amount : 0
        );
      }
      return { ok: true, direction, amount };
    }
    case 'get_context':
      return getContextTool();
    case 'window_manage':
      return windowManageTool(args.action, args.window_id, args.width, args.height);
    case 'clipboard':
      return clipboardTool(args.action, args.text, args.mime_type);
    case 'file_dialog':
      return filedialogTool(args.path, args.action);
    case 'totp_code':
      return totpCodeTool(args.account);
    case 'pause_for_human':
      return pauseForHuman(args.reason, args.instructions || '', args.timeout_seconds);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP JSON-RPC endpoint
app.post('/', async (req: Request, res: Response) => {
  const { id, method, params } = req.body;

  try {
    let result: any;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'workspace-mcp', version: '0.1.0' },
        };
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const { name, arguments: toolArgs } = params;
        try {
          const toolResult = await handleToolCall(name, toolArgs || {});
          result = { content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
        } catch (toolErr: any) {
          // Return tool execution errors as isError:true per MCP spec §5.9
          // (not as JSON-RPC protocol errors, which would terminate the session)
          result = { content: [{ type: 'text', text: toolErr.message }], isError: true };
        }
        break;
      }
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    res.json({ jsonrpc: '2.0', id, result });
  } catch (err: any) {
    console.error(`[MCP] Tool error:`, err.message);
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

const PORT = parseInt(process.env.MCP_PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[workspace-mcp] Server running on port ${PORT}`);
  console.log(`[workspace-mcp] Auth: ${getAuthToken() ? 'enabled' : 'disabled (dev mode)'}`);
});

export default app;
