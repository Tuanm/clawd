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
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export class BrowserPlugin implements ToolPlugin {
  readonly name = "browser";

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
          "Navigate a browser tab to a URL. Creates a new tab if no tab_id is specified. Returns the page title, URL, and tab ID.",
        parameters: {
          url: { type: "string", description: "URL to navigate to" },
          tab_id: {
            type: "number",
            description: "Target tab ID (optional — creates new tab if omitted)",
          },
          wait_for: {
            type: "string",
            description: 'Wait condition: "load" (default), "domcontentloaded", or "networkidle"',
            enum: ["load", "domcontentloaded", "networkidle"],
          },
        },
        required: ["url"],
        handler: async (args) => this.handleNavigate(args),
      },
      {
        name: "browser_screenshot",
        description:
          "Take a screenshot of the current browser tab. Returns a base64 JPEG image. Use read_image tool to analyze the screenshot content if needed.",
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
          "Click an element on the page by CSS selector or coordinates. For dynamic pages, prefer selectors over coordinates.",
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
            description: '"left" (default), "right", or "middle"',
            enum: ["left", "right", "middle"],
          },
          click_count: {
            type: "number",
            description: "Number of clicks: 1 (default) for single-click, 2 for double-click",
          },
          pierce: {
            type: "boolean",
            description: "Pierce shadow DOM and iframes to find the element (default: false)",
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
          "Extract structured content from the current page. Can extract text, links, form data, tables, or the accessibility tree.",
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
        description: "List open browser tabs or manage them (close, activate). Returns tab IDs, titles, and URLs.",
        parameters: {
          action: {
            type: "string",
            description: '"list" (default), "close", or "activate"',
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
          "Execute JavaScript code in the browser tab context. Returns the expression result. Use for advanced DOM manipulation or page interaction.",
        parameters: {
          code: {
            type: "string",
            description: "JavaScript code to execute in the page context",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
          frame_id: {
            type: "string",
            description: "Frame ID for frame-targeted execution (use browser_frames to list frames)",
          },
        },
        required: ["code"],
        handler: async (args) => this.handleExecute(args),
      },
      {
        name: "browser_scroll",
        description:
          "Scroll the page or a specific element. Use direction and amount to control scrolling. Can scroll to an element by selector.",
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
            description: "CSS selector — scroll at this element's position (optional)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: [],
        handler: async (args) => this.handleScroll(args),
      },
      {
        name: "browser_hover",
        description:
          "Hover over an element by CSS selector or coordinates. Triggers hover effects, tooltips, and dropdown menus.",
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
          'Send keyboard key presses with optional modifiers. Use for shortcuts, navigation keys, and special keys like Enter, Tab, Escape, Arrow keys, F1-F12, etc.',
        parameters: {
          key: {
            type: "string",
            description: 'Key to press: "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Home", "End", "PageUp", "PageDown", "F1"-"F12", or any character',
          },
          modifiers: {
            type: "array",
            description: 'Modifier keys to hold: ["ctrl"], ["shift"], ["alt"], ["meta"], or combinations like ["ctrl", "shift"]',
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
          'Set files on a <input type="file"> element. Provide a CSS selector for the file input and either a file_id (from chat server) or a local file_path.',
        parameters: {
          selector: {
            type: "string",
            description: 'CSS selector of the <input type="file"> element',
          },
          file_id: {
            type: "string",
            description: "File ID from chat server (resolved to local path)",
          },
          file_path: {
            type: "string",
            description: "Local file path (alternative to file_id)",
          },
          tab_id: { type: "number", description: "Target tab ID (optional)" },
        },
        required: ["selector"],
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
          'Dispatch touch events for mobile interaction testing. Supports tap, swipe, long-press, and pinch gestures.',
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
            description: "End X for swipe, or scale factor for pinch (e.g., 0.5 = zoom out, 2.0 = zoom in)",
          },
          end_y: {
            type: "number",
            description: "End Y coordinate for swipe",
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
          'Track and capture file downloads. Use "list" to see recent downloads, "wait" to wait for a download to complete, or "latest" to get the most recent completed download. Downloaded files are uploaded to chat server and returned as file_id.',
        parameters: {
          action: {
            type: "string",
            description: '"list" (recent downloads), "wait" (wait for next download), or "latest" (most recent completed)',
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
    ];
  }

  // ===========================================================================
  // Handlers
  // ===========================================================================

  private async getBridge() {
    const { isExtensionConnected, getConnectedExtensions, sendBrowserCommand } = await import(
      "../../../server/browser-bridge"
    );
    return { isExtensionConnected, getConnectedExtensions, sendBrowserCommand };
  }

  /** Save a buffer as a chat file and return its file ID + metadata. */
  private async uploadToChatServer(buffer: Buffer, filename: string, mimetype: string) {
    const { ATTACHMENTS_DIR, db, generateId } = await import("../../../server/database");
    const id = generateId("F");
    const ext = filename.split(".").pop() || "";
    const storedName = `${id}.${ext}`;
    const filepath = join(ATTACHMENTS_DIR, storedName);
    writeFileSync(filepath, buffer);
    db.run(
      `INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, filename, mimetype, buffer.length, filepath, "UAGENT"],
    );
    return { id, name: filename, mimetype, size: buffer.length };
  }

  private async handleStatus(): Promise<ToolResult> {
    const { isExtensionConnected, getConnectedExtensions } = await this.getBridge();
    const connected = isExtensionConnected();
    const extensions = getConnectedExtensions();
    return {
      success: true,
      output: JSON.stringify(
        {
          connected,
          extensions: extensions.length,
          extension_ids: extensions,
          message: connected
            ? `Browser extension connected (${extensions.length} instance${extensions.length > 1 ? "s" : ""}).`
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
        return { success: false, output: "", error: `Screenshot too large (>${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB). Try capturing a smaller area with selector or disable full_page.` };
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
      });
      return {
        success: true,
        output: JSON.stringify(
          {
            clicked: true,
            element: result.element || args.selector || `(${args.x}, ${args.y})`,
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
      const result = await sendBrowserCommand("execute", {
        code: args.code,
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
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify({ scrolled: true, direction: result.direction, amount: result.amount, tab_id: result.tabId }, null, 2),
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
        output: JSON.stringify({ pressed: true, key: result.key, modifiers: result.modifiers, tab_id: result.tabId }, null, 2),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleWaitFor(args: Record<string, any>): Promise<ToolResult> {
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
        output: JSON.stringify({ found: true, element: result.element, elapsed_ms: result.elapsed, tab_id: result.tabId }, null, 2),
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
        output: JSON.stringify({ selected: true, value: result.selected, text: result.text, index: result.index, tab_id: result.tabId }, null, 2),
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
        output: JSON.stringify({
          handled: result.handled,
          type: result.type,
          dialog_message: result.dialogMessage,
          tab_id: result.tabId,
        }, null, 2),
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
          null, 2,
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async handleUploadFile(args: Record<string, any>): Promise<ToolResult> {
    if (!args.file_id && !args.file_path) {
      return { success: false, output: "", error: "Provide file_id or file_path" };
    }
    const { sendBrowserCommand } = await this.getBridge();

    let filePaths: string[] = [];
    if (args.file_id) {
      const { db } = await import("../../../server/database");
      const file = db.query("SELECT path FROM files WHERE id = ?").get(args.file_id) as any;
      if (!file) return { success: false, output: "", error: `File not found: ${args.file_id}` };
      filePaths = [file.path];
    } else {
      filePaths = [args.file_path];
    }

    try {
      const result = await sendBrowserCommand("file_upload", {
        selector: args.selector,
        files: filePaths,
        tabId: args.tab_id,
      });
      return {
        success: true,
        output: JSON.stringify(
          { uploaded: true, selector: args.selector, file_count: filePaths.length, tab_id: result.tabId },
          null, 2,
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
        tabId: args.tab_id,
      });

      if (args.action === "list") {
        return { success: true, output: JSON.stringify(result, null, 2) };
      }

      // For latest/wait, upload the file to chat server
      if (result.filename) {
        try {
          const buffer = readFileSync(result.filename);
          const name = basename(result.filename);
          const mime = result.mime || "application/octet-stream";
          const file = await this.uploadToChatServer(buffer, name, mime);
          return {
            success: true,
            output: JSON.stringify({
              file_id: file.id,
              filename: name,
              mime,
              size: file.size,
              download_url: result.url,
              message: `Downloaded file uploaded as ${file.id}. Use appropriate tool to read or attach this file.`,
            }, null, 2),
          };
        } catch {
          // Can't read the file (WSL/Windows path mismatch, etc.)
          return {
            success: true,
            output: JSON.stringify({
              filename: result.filename,
              url: result.url,
              mime: result.mime,
              size: result.totalBytes,
              note: "File downloaded but could not be read by server. Path: " + result.filename,
            }, null, 2),
          };
        }
      }

      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async destroy(): Promise<void> {
    // No persistent state to clean up
  }
}
