/**
 * Browser Tool Plugin — Provides browser automation tools via Chrome extension bridge.
 *
 * Tools: browser_navigate, browser_screenshot, browser_click, browser_type,
 *        browser_extract, browser_tabs, browser_execute, browser_scroll,
 *        browser_hover, browser_drag, browser_keypress, browser_status
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

  async destroy(): Promise<void> {
    // No persistent state to clean up
  }
}
