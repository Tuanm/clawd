/**
 * Browser Tool Plugin — Provides browser automation tools via Chrome extension bridge.
 *
 * Tools: browser_navigate, browser_screenshot, browser_click, browser_type,
 *        browser_extract, browser_tabs, browser_execute, browser_scroll,
 *        browser_hover, browser_drag, browser_keypress, browser_wait_for,
 *        browser_select, browser_handle_dialog, browser_status,
 *        browser_history, browser_upload_file, browser_frames,
 *        browser_touch, browser_emulate, browser_download
 *
 * Requires: Chrome extension connected via WebSocket to /browser/ws
 * Gated behind: config.json "browser": true
 */

import type { ToolPlugin, ToolRegistration } from "../tools/plugin.js";
import type { ToolResult } from "../tools/tools.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export class BrowserPlugin implements ToolPlugin {
  readonly name = "browser";
  private channel?: string;
  private agentId?: string;

  constructor(channel?: string, agentId?: string) {
    this.channel = channel;
    this.agentId = agentId;
  }

  getTools(): ToolRegistration[] {
    return [
      {
        name: "browser_status",
        description:
          "Check browser extension connection status. Returns whether a Chrome/Edge extension is connected and available for browser automation.",
        parameters: {},
        required: [],
        handler: async () => this.handleStatus(),
      },
      {
        name: "browser_navigate",
        description:
          "Navigate a browser tab to a URL. If a tab with the target URL is already open (check via browser_tabs list first), reuse it by passing its tab_id instead of opening a new tab. Creates a new tab if no tab_id is specified. Close tabs you no longer need via browser_tabs action=close.",
        parameters: {
          url: { type: "string", description: "URL to navigate to" },
          tab_id: {
            type: "number",
            description: "Target tab ID (optional — creates new tab if omitted)",
          },
          wait_for: {
            type: "string",
            description: 'Wait condition: "load" (default) or "domcontentloaded"',
            enum: ["load", "domcontentloaded"],
          },
        },
        required: ["url"],
        handler: async (args) => this.handleNavigate(args),
      },
      {
        name: "browser_screenshot",
        description:
          "Take a screenshot of the current browser tab. Returns a base64 JPEG image. Use read_image tool to analyze the screenshot content if needed. " +
          "PREFER browser_extract or browser_execute (with stored scripts) to read page content — they return structured data, are faster, and use less context. " +
          "Only use screenshots when you need visual layout information that cannot be obtained from DOM/text extraction (e.g., charts, images, visual styling, spatial layout).",
        parameters: {
          tab_id: {
            type: "number",
            description: "Tab to screenshot (optional — uses active tab)",
          },
          selector: {
            type: "string",
            description: "CSS selector to screenshot a specific element (optional)",
          },
          full_page: {
            type: "boolean",
            description: "Capture full scrollable page instead of viewport (default: false)",
          },
        },
        required: [],
        handler: async (args) => this.handleScreenshot(args),
      },
      {
        name: "browser_click",
        description:
          'Click an element on the page. Supports single-click, double-click (click_count=2 to select words or open items), and right-click (button="right" for context menus). For dynamic pages, prefer selectors over coordinates. Set intercept_file_chooser=true when clicking upload/file buttons.',
        parameters: {
          selector: {
            type: "string",
            description: "CSS selector of element to click",
          },
          x: { type: "number", description: "X coordinate (if no selector)" },
          y: { type: "number", description: "Y coordinate (if no selector)" },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          button: {
            type: "string",
            description: '"left" (default) for normal click, "right" for context menu, "middle" for new-tab link open',
            enum: ["left", "right", "middle"],
          },
          click_count: {
            type: "number",
            description:
              "1 = single-click (default), 2 = double-click (select word, open item), 3 = triple-click (select line/paragraph)",
          },
          pierce: {
            type: "boolean",
            description: "Pierce shadow DOM and iframes to find the element (default: false)",
          },
          intercept_file_chooser: {
            type: "boolean",
            description:
              "Set true when clicking a file upload button. Intercepts the file chooser dialog so you can provide a file via browser_upload_file. Do NOT set for download buttons.",
          },
        },
        required: [],
        handler: async (args) => this.handleClick(args),
      },
      {
        name: "browser_type",
        description:
          "Type text into a focused element or a specific element by selector. Can also send special keys like Enter, Tab, Escape.",
        parameters: {
          text: { type: "string", description: "Text to type" },
          selector: {
            type: "string",
            description: "CSS selector of input element (optional — types into focused element)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          clear_first: {
            type: "boolean",
            description: "Clear the field before typing (default: false)",
          },
          press_enter: {
            type: "boolean",
            description: "Press Enter after typing (default: false)",
          },
          pierce: {
            type: "boolean",
            description: "Pierce shadow DOM and iframes to find the element (default: false)",
          },
        },
        required: ["text"],
        handler: async (args) => this.handleType(args),
      },
      {
        name: "browser_extract",
        description:
          "Extract structured content from the current page. Can extract text, links, form data, tables, or the accessibility tree. " +
          "PREFERRED over browser_screenshot for reading page content — returns structured text data that is faster, cheaper, and more accurate than OCR from screenshots.",
        parameters: {
          mode: {
            type: "string",
            description:
              '"text" (visible text), "links" (all links), "forms" (form fields), "tables" (table data), "accessibility" (accessibility tree), "html" (raw HTML of selector)',
            enum: ["text", "links", "forms", "tables", "accessibility", "html"],
          },
          selector: {
            type: "string",
            description: "CSS selector to scope extraction (optional — uses whole page)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          frame_id: {
            type: "string",
            description: "Frame ID to extract from (use browser_frames to list frames)",
          },
        },
        required: ["mode"],
        handler: async (args) => this.handleExtract(args),
      },
      {
        name: "browser_tabs",
        description:
          "List, close, or activate browser tabs. IMPORTANT: Before opening new tabs, check if a suitable tab is already open. Close tabs you no longer need to keep the browser tidy and reduce resource usage.",
        parameters: {
          action: {
            type: "string",
            description:
              '"list" (default) — shows all tabs; "close" — close a tab; "activate" — bring a tab to foreground',
            enum: ["list", "close", "activate"],
          },
          tab_id: {
            type: "number",
            description: "Tab ID for close/activate actions",
          },
        },
        required: [],
        handler: async (args) => this.handleTabs(args),
      },
      {
        name: "browser_execute",
        description:
          "Execute JavaScript in the browser tab. Supports running inline code OR a stored script by ID (saved via browser_store). " +
          "When reusing a stored script, pass script_id (and optional script_args) instead of code — this avoids re-sending large scripts and enables reuse across sessions. " +
          "If both code and script_id are provided, script_id takes priority. " +
          "TIP: If you find yourself running similar code more than once, save it as a reusable script via browser_store (with a description) and call it by script_id going forward.",
        parameters: {
          code: {
            type: "string",
            description: "JavaScript code to execute in the page context (omit if using script_id)",
          },
          script_id: {
            type: "string",
            description:
              "Key of a stored script (saved via browser_store with action=set). The script is loaded and wrapped in an async function — " +
              "use 'return <expr>' to return values (unlike inline code, the last expression is NOT implicitly returned). Prefer this over re-sending code.",
          },
          script_args: {
            type: "object",
            description:
              "Arguments object passed to the stored script as __args. Access via __args.key inside the script. " +
              "Only used with script_id.",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          frame_id: {
            type: "string",
            description: "Frame ID for frame-targeted execution (use browser_frames to list frames)",
          },
        },
        required: [],
        handler: async (args) => this.handleExecute(args),
      },
      {
        name: "browser_scroll",
        description:
          "Scroll the page or a specific scrollable area (sidebar, panel, chat list, etc.). When selector is given, the scroll event targets that element — the browser automatically scrolls the nearest scrollable ancestor. Use this to scroll within nested containers, not just the main page.",
        parameters: {
          direction: {
            type: "string",
            description: '"down" (default), "up", "left", or "right"',
            enum: ["up", "down", "left", "right"],
          },
          amount: {
            type: "number",
            description: "Scroll distance in pixels (default: 300)",
          },
          selector: {
            type: "string",
            description:
              "CSS selector — scroll event fires at this element's center, scrolling its nearest scrollable container (sidebar, panel, etc.)",
          },
          x: { type: "number", description: "X coordinate to scroll at (alternative to selector)" },
          y: { type: "number", description: "Y coordinate to scroll at (alternative to selector)" },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: [],
        handler: async (args) => this.handleScroll(args),
      },
      {
        name: "browser_hover",
        description:
          "Hover over an element to reveal hidden UI: tooltips, dropdown menus, action buttons, preview popups, and hover-only content. Essential for inspecting elements that only appear on mouse-over. After hovering, take a screenshot or extract to see the revealed content.",
        parameters: {
          selector: {
            type: "string",
            description: "CSS selector of element to hover over",
          },
          x: { type: "number", description: "X coordinate (if no selector)" },
          y: { type: "number", description: "Y coordinate (if no selector)" },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          pierce: {
            type: "boolean",
            description: "Pierce shadow DOM and iframes to find the element (default: false)",
          },
        },
        required: [],
        handler: async (args) => this.handleHover(args),
      },
      {
        name: "browser_mouse_move",
        description:
          "Move the mouse cursor to specific coordinates. Use sparingly — most interactions should use browser_click or browser_hover instead. Useful when you need to position the cursor at a precise location (e.g., to dismiss a popup, move away from an element, or prepare for a manual sequence).",
        parameters: {
          x: { type: "number", description: "Target X coordinate" },
          y: { type: "number", description: "Target Y coordinate" },
          steps: {
            type: "number",
            description: "Number of intermediate movement steps (default: 1). Use higher values for smoother travel.",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["x", "y"],
        handler: async (args) => this.handleMouseMove(args),
      },
      {
        name: "browser_drag",
        description:
          "Drag and drop from one position to another. Use selectors or coordinates for source and target. Works for sliders, sortable lists, and drag-and-drop UIs.",
        parameters: {
          from_selector: {
            type: "string",
            description: "CSS selector of element to drag from",
          },
          from_x: { type: "number", description: "Start X coordinate (if no from_selector)" },
          from_y: { type: "number", description: "Start Y coordinate (if no from_selector)" },
          to_selector: {
            type: "string",
            description: "CSS selector of element to drop onto",
          },
          to_x: { type: "number", description: "End X coordinate (if no to_selector)" },
          to_y: { type: "number", description: "End Y coordinate (if no to_selector)" },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          steps: {
            type: "number",
            description: "Number of intermediate move steps (default: 10). More steps = smoother drag.",
          },
        },
        required: [],
        handler: async (args) => this.handleDrag(args),
      },
      {
        name: "browser_keypress",
        description:
          "Send keyboard key presses with optional modifiers. Use for shortcuts, navigation keys, and special keys like Enter, Tab, Escape, Arrow keys, F1-F12, etc.",
        parameters: {
          key: {
            type: "string",
            description:
              'Key to press: "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Home", "End", "PageUp", "PageDown", "F1"-"F12", or any character',
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description:
              'Modifier keys to hold: "ctrl", "shift", "alt", "meta", or combinations like ["ctrl", "shift"]',
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["key"],
        handler: async (args) => this.handleKeypress(args),
      },
      {
        name: "browser_wait_for",
        description:
          "Wait for an element to appear on the page. Polls until the element matching the selector exists and is visible. Use before interacting with dynamically loaded content.",
        parameters: {
          selector: {
            type: "string",
            description: "CSS selector to wait for",
          },
          timeout: {
            type: "number",
            description: "Maximum wait time in milliseconds (default: 5000, max: 30000)",
          },
          visible: {
            type: "boolean",
            description: "Require element to be visible, not just in DOM (default: true)",
          },
          pierce: {
            type: "boolean",
            description: "Pierce shadow DOM and iframes to find the element (default: false)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["selector"],
        handler: async (args) => this.handleWaitFor(args),
      },
      {
        name: "browser_select",
        description:
          'Select an option from a <select> dropdown element. Can select by value, visible text, or index. Dispatches "input" and "change" events.',
        parameters: {
          selector: {
            type: "string",
            description: "CSS selector of the <select> element",
          },
          value: {
            type: "string",
            description: "Option value attribute to select",
          },
          text: {
            type: "string",
            description: "Visible text of the option to select",
          },
          index: {
            type: "number",
            description: "Zero-based index of the option to select",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["selector"],
        handler: async (args) => this.handleSelect(args),
      },
      {
        name: "browser_handle_dialog",
        description:
          'Handle a JavaScript dialog (alert, confirm, or prompt). Must be called after a dialog appears. Use action "accept" to click OK or "dismiss" to click Cancel.',
        parameters: {
          action: {
            type: "string",
            description: '"accept" (click OK, default) or "dismiss" (click Cancel)',
            enum: ["accept", "dismiss"],
          },
          prompt_text: {
            type: "string",
            description: "Text to enter in a prompt() dialog (optional)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: [],
        handler: async (args) => this.handleDialog(args),
      },
      {
        name: "browser_history",
        description:
          "Navigate back or forward in browser history. Equivalent to clicking the browser's back/forward buttons.",
        parameters: {
          action: {
            type: "string",
            description: '"back" or "forward"',
            enum: ["back", "forward"],
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action"],
        handler: async (args) => this.handleHistory(args),
      },
      {
        name: "browser_upload_file",
        description:
          "Upload a file to a web page. Two modes: (1) After clicking an upload button that opens a file chooser dialog (file_chooser_opened in response), just provide file_id — no selector needed. " +
          '(2) Direct mode: provide both file_id and a CSS selector for the <input type="file"> element.',
        parameters: {
          selector: {
            type: "string",
            description:
              'CSS selector of the <input type="file"> element. Optional if a file chooser dialog is pending from a previous click.',
          },
          file_id: {
            type: "string",
            description: "File ID from chat server",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["file_id"],
        handler: async (args) => this.handleUploadFile(args),
      },
      {
        name: "browser_frames",
        description:
          "List all frames (iframes) in the current page. Returns frame IDs, URLs, names, and hierarchy. Use frame IDs with browser_execute and browser_extract for frame-targeted commands.",
        parameters: {
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: [],
        handler: async (args) => this.handleFrames(args),
      },
      {
        name: "browser_touch",
        description:
          "Dispatch touch events for mobile interaction testing. Supports tap, swipe, long-press, and pinch gestures.",
        parameters: {
          action: {
            type: "string",
            description: '"tap", "swipe", "long-press", or "pinch"',
            enum: ["tap", "swipe", "long-press", "pinch"],
          },
          selector: {
            type: "string",
            description: "CSS selector of target element (alternative to x,y)",
          },
          x: { type: "number", description: "Start X coordinate" },
          y: { type: "number", description: "Start Y coordinate" },
          end_x: {
            type: "number",
            description: "End X coordinate for swipe gesture",
          },
          end_y: {
            type: "number",
            description: "End Y coordinate for swipe",
          },
          scale: {
            type: "number",
            description: "Scale factor for pinch gesture (e.g., 0.5 = zoom out, 2.0 = zoom in)",
          },
          duration: {
            type: "number",
            description: "Hold duration in ms for long-press (default: 500)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action"],
        handler: async (args) => this.handleTouch(args),
      },
      {
        name: "browser_emulate",
        description:
          'Emulate a mobile device or custom viewport. Set screen dimensions, device scale factor, touch capability, and user agent. Use action "clear" to reset.',
        parameters: {
          action: {
            type: "string",
            description: '"set" (default) to apply emulation, or "clear" to reset to defaults',
            enum: ["set", "clear"],
          },
          width: { type: "number", description: "Viewport width in pixels" },
          height: { type: "number", description: "Viewport height in pixels" },
          device_scale_factor: {
            type: "number",
            description: "Device pixel ratio (default: 1, use 2 for retina, 3 for high-DPI mobile)",
          },
          is_mobile: {
            type: "boolean",
            description: "Enable mobile mode (affects rendering, default: false)",
          },
          has_touch: {
            type: "boolean",
            description: "Enable touch event support (default: false)",
          },
          user_agent: {
            type: "string",
            description: "Custom user agent string (optional)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: [],
        handler: async (args) => this.handleEmulate(args),
      },
      {
        name: "browser_download",
        description:
          'Track and capture file downloads. Use "list" to see recent downloads, "wait" to wait for a download to complete, or "latest" to get the most recent completed download. Completed downloads are automatically uploaded to the chat server and returned as file_id (max 500 MiB).',
        parameters: {
          action: {
            type: "string",
            description:
              '"list" (recent downloads), "wait" (wait for next download), or "latest" (most recent completed)',
            enum: ["list", "wait", "latest"],
          },
          timeout: {
            type: "number",
            description: "Max wait time in ms for 'wait' action (default: 30000, max: 120000)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action"],
        handler: async (args) => this.handleDownload(args),
      },
      {
        name: "browser_auth",
        description:
          'Handle HTTP Basic/Digest authentication popups (e.g., staging servers, enterprise proxies). Use "status" to check if a page requires auth, "provide" to supply credentials, or "cancel" to dismiss.',
        parameters: {
          action: {
            type: "string",
            description: '"status" (check for pending auth), "provide" (supply credentials), or "cancel"',
            enum: ["status", "provide", "cancel"],
          },
          username: { type: "string", description: "Username for authentication (required for 'provide')" },
          password: { type: "string", description: "Password for authentication (required for 'provide')" },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action"],
        handler: async (args) => this.handleAuth(args),
      },
      {
        name: "browser_permissions",
        description:
          'Grant, deny, or reset browser permissions for a site. Controls access to camera, microphone, geolocation, notifications, clipboard, MIDI, and other web APIs. Grant permissions before interacting with features that need them (e.g., grant "geolocation" before testing a map app).',
        parameters: {
          action: {
            type: "string",
            description: '"grant", "deny", or "reset" (back to prompt)',
            enum: ["grant", "deny", "reset"],
          },
          permissions: {
            type: "array",
            items: { type: "string" },
            description:
              'Permission names: "geolocation", "camera", "microphone", "notifications", "clipboard-read", "clipboard-write", "midi", "background-sync", "sensors", "screen-wake-lock"',
          },
          origin: {
            type: "string",
            description: "Origin to set permission for (default: current page origin)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action", "permissions"],
        handler: async (args) => this.handlePermissions(args),
      },
      {
        name: "browser_store",
        description:
          "Store and retrieve data/scripts per-website using the browser's localStorage. " +
          "IMPORTANT: For any script you plan to run more than once, save it here first (action=set with a description), then run it via browser_execute with script_id instead of resending the code. " +
          "Use action=list to see all stored items with their descriptions. " +
          "Data is stored under a namespaced key (__clawd_store__) in the page's localStorage, scoped to the page origin. " +
          "Use descriptive keys like 'scroll-to-bottom', 'extract-table', 'login-form' so scripts are easy to find and reuse.",
        parameters: {
          action: {
            type: "string",
            description:
              '"set", "get", "list" (all keys with descriptions), "delete" (one key), or "clear" (all data for this origin)',
            enum: ["set", "get", "list", "delete", "clear"],
          },
          key: { type: "string", description: "Storage key (required for set/get/delete)" },
          value: {
            type: "string",
            description: "Value to store (required for set). For scripts, store the JS code as a string.",
          },
          description: {
            type: "string",
            description:
              "Human-readable description of what this stored item does (recommended for set). Shown in list results to help select the right script.",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["action"],
        handler: async (args) => this.handleStore(args),
      },
    ];
  }

  // ===========================================================================
  // Handlers
  // ===========================================================================

  private async getBridge() {
    const {
      isExtensionConnected,
      isExtensionConnectedForChannel,
      getConnectedExtensions,
      sendBrowserCommand,
      getConnectionInfo,
      releaseAgentTabs,
    } = await import("../../../server/browser-bridge");
    const channel = this.channel;
    const agentId = this.agentId;
    // Wrap sendBrowserCommand to auto-inject agent routing options
    const send = (method: string, params: Record<string, any> = {}) =>
      sendBrowserCommand(method, params, { agentId, channel });
    return {
      isExtensionConnected,
      isExtensionConnectedForChannel,
      getConnectedExtensions,
      sendBrowserCommand: send,
      getConnectionInfo,
      releaseAgentTabs,
    };
  }

  /** Save a buffer as a chat file and return its file ID + metadata. */
  private async uploadToChatServer(buffer: Buffer, filename: string, mimetype: string) {
    const { ATTACHMENTS_DIR, db, generateId } = await import("../../../server/database");
    const id = generateId("F");
    const dotIndex = filename.lastIndexOf(".");
    const ext = dotIndex > 0 ? filename.slice(dotIndex + 1) : "";
    const storedName = ext ? `${id}.${ext}` : id;
    const filepath = join(ATTACHMENTS_DIR, storedName);
    writeFileSync(filepath, buffer);
    db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      filename,
      mimetype,
      buffer.length,
      filepath,
      "UAGENT",
    ]);
    return { id, name: filename, mimetype, size: buffer.length };
  }

  private async handleStatus(): Promise<ToolResult> {
    const { isExtensionConnectedForChannel, getConnectionInfo } = await this.getBridge();
    const connected = isExtensionConnectedForChannel(this.channel);
    // Filter info to only this agent's channel to prevent cross-channel leakage
    const info = getConnectionInfo(this.channel);
    const browserCount = info.length;
    return {
      success: true,
      output: JSON.stringify(
        {
          connected,
          extensions: browserCount,
          browsers: info.map((b) => ({
            id: b.extensionId,
            channels: b.channels,
            agent_count: b.agentCount,
            connected_at: new Date(b.connectedAt).toISOString(),
          })),
          agent_channel: this.channel ?? null,
          message: connected
            ? `Browser extension connected (${browserCount} instance${browserCount > 1 ? "s" : ""}).`
            : "No browser extension connected. Install and enable the Claw'd Browser Extension.",
        },
        null,
        2,
      ),
    };
  }

  private async handleNavigate(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("navigate", {
        url: args.url,
        tabId: args.tab_id,
        waitFor: args.wait_for || "load",
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            tab_id: result.tabId,
            url: result.url,
            title: result.title,
            ...(result.download_triggered && { download_triggered: result.download_triggered }),
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleScreenshot(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("screenshot", {
        tabId: args.tab_id,
        selector: args.selector,
        fullPage: args.full_page,
      });
      if (!result.dataUrl) {
        return { success: false, output: "", error: "No screenshot data returned" };
      }
      const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
      // Limit screenshot size to 10MB decoded
      const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
      if (base64.length * 0.75 > MAX_SCREENSHOT_BYTES) {
        return {
          success: false,
          output: "",
          error: `Screenshot too large (>${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB). Try capturing a smaller area with selector or disable full_page.`,
        };
      }
      const buffer = Buffer.from(base64, "base64");
      const filename = `screenshot-${Date.now()}.jpg`;
      const file = await this.uploadToChatServer(buffer, filename, "image/jpeg");
      return {
        success: true,
        output: JSON.stringify(
          {
            file_id: file.id,
            tab_id: result.tabId,
            width: result.width,
            height: result.height,
            format: "jpeg",
            size: file.size,
            message: `Screenshot captured (${result.width}x${result.height}). Use read_image with file_id="${file.id}" to analyze the content.`,
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleClick(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector && (args.x === undefined || args.y === undefined)) {
      return { success: false, output: "", error: "Provide either a CSS selector or x,y coordinates" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("click", {
        selector: args.selector,
        x: args.x,
        y: args.y,
        tabId: args.tab_id,
        button: args.button || "left",
        clickCount: args.click_count,
        pierce: args.pierce,
        intercept_file_chooser: args.intercept_file_chooser,
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            clicked: true,
            element: result.element || args.selector || `(${args.x}, ${args.y})`,
            tab_id: result.tabId,
            ...(result.download_triggered && { download_triggered: result.download_triggered }),
            ...(result.file_chooser_opened && { file_chooser_opened: result.file_chooser_opened }),
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleType(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("type", {
        text: args.text,
        selector: args.selector,
        tabId: args.tab_id,
        clearFirst: args.clear_first,
        pressEnter: args.press_enter,
        pierce: args.pierce,
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            typed: true,
            text_length: args.text.length,
            element: result.element || args.selector || "(focused)",
            tab_id: result.tabId,
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleExtract(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("extract", {
        mode: args.mode,
        selector: args.selector,
        tabId: args.tab_id,
        frameId: args.frame_id,
      });
      // Truncate very large extractions
      let output = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
      if (output.length > 50000) {
        output = output.slice(0, 50000) + "\n\n... (truncated at 50KB)";
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleTabs(args: Record<string, any>): Promise<ToolResult> {
    const action = args.action || "list";
    if ((action === "close" || action === "activate") && args.tab_id === undefined) {
      return { success: false, output: "", error: `tab_id is required for "${action}" action` };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("tabs", {
        action,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleExecute(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      let code = args.code;

      // If script_id is provided, load the stored script first
      if (args.script_id) {
        const storeResult = await sendBrowserCommand("store", {
          action: "get",
          key: args.script_id,
          tabId: args.tab_id,
        });
        const storedScript = storeResult?.value;
        const found = storeResult?.found;
        if (!found) {
          return {
            success: false,
            output: "",
            error: `Stored script '${String(args.script_id).slice(0, 100)}' not found. Use browser_store action=set to save it first, or use browser_store action=list to see available scripts.`,
          };
        }
        if (typeof storedScript !== "string" || storedScript.length === 0) {
          return {
            success: false,
            output: "",
            error: `Stored item '${String(args.script_id).slice(0, 100)}' is not a valid script (type: ${typeof storedScript}). Store a non-empty JS code string.`,
          };
        }
        // Serialize script_args safely
        let argsJson: string;
        try {
          argsJson = JSON.stringify(args.script_args ?? {});
        } catch {
          return {
            success: false,
            output: "",
            error:
              "script_args is not JSON-serializable (check for BigInt, circular references, or other non-serializable values)",
          };
        }
        // Wrap stored script as async IIFE with __args injected (async supports await in scripts)
        code = `(async function(){const __args=${argsJson};${storedScript}})()`;
      }

      if (!code) {
        return {
          success: false,
          output: "",
          error: "Either 'code' or 'script_id' is required.",
        };
      }

      const result = await sendBrowserCommand("execute", {
        code,
        tabId: args.tab_id,
        frameId: args.frame_id,
      });
      let output =
        result.value !== undefined
          ? typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value, null, 2)
          : "(undefined)";
      if (output.length > 50_000) {
        output = output.slice(0, 50_000) + "\n\n... (truncated at 50KB)";
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleScroll(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("scroll", {
        direction: args.direction || "down",
        amount: args.amount,
        selector: args.selector,
        x: args.x,
        y: args.y,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          { scrolled: true, direction: result.direction, amount: result.amount, tab_id: result.tabId },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleHover(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector && (args.x === undefined || args.y === undefined)) {
      return { success: false, output: "", error: "Provide either a CSS selector or x,y coordinates" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("hover", {
        selector: args.selector,
        x: args.x,
        y: args.y,
        tabId: args.tab_id,
        pierce: args.pierce,
      });
      return {
        success: true,
        output: JSON.stringify({ hovered: true, element: result.element, tab_id: result.tabId }, null, 2),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleMouseMove(args: Record<string, any>): Promise<ToolResult> {
    if (args.x === undefined || args.y === undefined) {
      return { success: false, output: "", error: "Both x and y coordinates are required" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("mouse_move", {
        x: args.x,
        y: args.y,
        steps: args.steps,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify({ moved: true, position: result.position, tab_id: result.tabId }, null, 2),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleDrag(args: Record<string, any>): Promise<ToolResult> {
    if (!args.from_selector && (args.from_x === undefined || args.from_y === undefined)) {
      return { success: false, output: "", error: "Provide from_selector or from_x/from_y coordinates" };
    }
    if (!args.to_selector && (args.to_x === undefined || args.to_y === undefined)) {
      return { success: false, output: "", error: "Provide to_selector or to_x/to_y coordinates" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("drag", {
        fromSelector: args.from_selector,
        fromX: args.from_x,
        fromY: args.from_y,
        toSelector: args.to_selector,
        toX: args.to_x,
        toY: args.to_y,
        tabId: args.tab_id,
        steps: args.steps,
      });
      return {
        success: true,
        output: JSON.stringify({ dragged: true, from: result.from, to: result.to, tab_id: result.tabId }, null, 2),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleKeypress(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("keypress", {
        key: args.key,
        modifiers: args.modifiers,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          { pressed: true, key: result.key, modifiers: result.modifiers, tab_id: result.tabId },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleWaitFor(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector) {
      return { success: false, output: "", error: "selector is required" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("wait_for", {
        selector: args.selector,
        tabId: args.tab_id,
        timeout: args.timeout,
        visible: args.visible,
        pierce: args.pierce,
      });
      return {
        success: true,
        output: JSON.stringify(
          { found: true, element: result.element, elapsed_ms: result.elapsed, tab_id: result.tabId },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleSelect(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector) {
      return { success: false, output: "", error: "selector is required" };
    }
    if (args.value === undefined && args.text === undefined && args.index === undefined) {
      return { success: false, output: "", error: "Provide value, text, or index to select" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("select", {
        selector: args.selector,
        value: args.value,
        text: args.text,
        index: args.index,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          { selected: true, value: result.selected, text: result.text, index: result.index, tab_id: result.tabId },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleDialog(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("dialog", {
        action: args.action || "accept",
        promptText: args.prompt_text,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            handled: result.handled,
            type: result.type,
            dialog_message: result.dialogMessage,
            tab_id: result.tabId,
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleHistory(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("history", {
        action: args.action,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          { navigated: true, action: result.action, url: result.url, title: result.title, tab_id: result.tabId },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleUploadFile(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector) {
      return {
        success: false,
        output: "",
        error: "selector is required (CSS selector for the <input type='file'> element)",
      };
    }
    if (!args.file_id) {
      return { success: false, output: "", error: "file_id is required (from chat server)" };
    }
    const { sendBrowserCommand } = await this.getBridge();

    try {
      const result = await sendBrowserCommand("file_upload", {
        selector: args.selector,
        fileId: args.file_id,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            uploaded: true,
            selector: args.selector,
            file_id: args.file_id,
            filename: result.fileName,
            tab_id: result.tabId,
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleFrames(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("frames", { tabId: args.tab_id });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleTouch(args: Record<string, any>): Promise<ToolResult> {
    if (!args.selector && (args.x === undefined || args.y === undefined)) {
      return { success: false, output: "", error: "Provide either selector or x,y coordinates" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("touch", {
        action: args.action,
        selector: args.selector,
        x: args.x,
        y: args.y,
        endX: args.end_x,
        endY: args.end_y,
        scale: args.scale,
        duration: args.duration,
        tabId: args.tab_id,
      });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleEmulate(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("emulate", {
        action: args.action || "set",
        width: args.width,
        height: args.height,
        deviceScaleFactor: args.device_scale_factor,
        isMobile: args.is_mobile,
        hasTouch: args.has_touch,
        userAgent: args.user_agent,
        tabId: args.tab_id,
      });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleDownload(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("download", {
        action: args.action,
        timeout: args.timeout,
      });

      // Extension now auto-uploads to chat server for wait/latest — result has file_id directly
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleAuth(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("auth", {
        action: args.action,
        username: args.username,
        password: args.password,
        tabId: args.tab_id,
      });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handlePermissions(args: Record<string, any>): Promise<ToolResult> {
    if (!args.permissions?.length) {
      return { success: false, output: "", error: "permissions array is required" };
    }
    const { sendBrowserCommand } = await this.getBridge();
    try {
      const result = await sendBrowserCommand("permissions", {
        action: args.action,
        permissions: args.permissions,
        origin: args.origin,
        tabId: args.tab_id,
      });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleStore(args: Record<string, any>): Promise<ToolResult> {
    const { sendBrowserCommand } = await this.getBridge();
    try {
      // Pre-validate value is JSON-serializable (catches circular references before sending to browser)
      if (args.action === "set" && args.value !== undefined) {
        try {
          JSON.stringify(args.value);
        } catch {
          return {
            success: false,
            output: "",
            error: "Value is not JSON-serializable (check for circular references)",
          };
        }
      }
      const result = await sendBrowserCommand("store", {
        action: args.action,
        key: args.key,
        value: args.value,
        description: args.description,
        tabId: args.tab_id,
      });
      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async destroy(): Promise<void> {
    if (this.agentId) {
      const { releaseAgentTabs } = await import("../../../server/browser-bridge");
      releaseAgentTabs(this.agentId);
    }
  }
}
