/**
 * Browser Tool Plugin — Provides browser automation tools via Chrome extension bridge.
 *
 * Tools: browser_navigate, browser_screenshot, browser_click, browser_type,
 *        browser_extract, browser_tabs, browser_execute, browser_status
 *
 * Requires: Chrome extension connected via WebSocket to /browser/ws
 * Gated behind: config.json "browser": true
 */

import type { ToolPlugin, ToolRegistration } from "../tools/plugin.js";
import type { ToolResult } from "../tools/tools.js";

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
            description:
              'Wait condition: "load" (default), "domcontentloaded", or "networkidle"',
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
        description:
          "List open browser tabs or manage them (close, activate). Returns tab IDs, titles, and URLs.",
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

  private async handleStatus(): Promise<ToolResult> {
    const { isExtensionConnected, getConnectedExtensions } = await this.getBridge();
    const connected = isExtensionConnected();
    const extensions = getConnectedExtensions();
    return {
      success: true,
      output: JSON.stringify({
        connected,
        extensions: extensions.length,
        extension_ids: extensions,
        message: connected
          ? `Browser extension connected (${extensions.length} instance${extensions.length > 1 ? "s" : ""}).`
          : "No browser extension connected. Install and enable the Claw'd Browser Extension.",
      }, null, 2),
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
        output: JSON.stringify({
          tab_id: result.tabId,
          url: result.url,
          title: result.title,
        }, null, 2),
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
      // Save screenshot to temp file to avoid polluting agent context
      const tmpDir = require("os").tmpdir();
      const filename = `clawd-screenshot-${Date.now()}.jpg`;
      const filePath = require("path").join(tmpDir, filename);
      if (result.dataUrl) {
        const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        require("fs").writeFileSync(filePath, Buffer.from(base64, "base64"));
      }
      return {
        success: true,
        output: JSON.stringify({
          tab_id: result.tabId,
          width: result.width,
          height: result.height,
          format: "jpeg",
          file_path: filePath,
          message: `Screenshot captured (${result.width}x${result.height}). Use read_image with file_path="${filePath}" to analyze the content.`,
        }, null, 2),
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
        output: JSON.stringify({
          clicked: true,
          element: result.element || args.selector || `(${args.x}, ${args.y})`,
          tab_id: result.tabId,
        }, null, 2),
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
        output: JSON.stringify({
          typed: true,
          text_length: args.text.length,
          element: result.element || args.selector || "(focused)",
          tab_id: result.tabId,
        }, null, 2),
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
      let output = result.value !== undefined
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

  async destroy(): Promise<void> {
    // No persistent state to clean up
  }
}
