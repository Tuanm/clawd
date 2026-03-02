# Workspace MCP Server API Design: Two-Layer Desktop Control

**Date:** 2026-03-02
**Status:** Complete
**Scope:** Design the unified MCP server that runs inside each agent's Docker container, exposing a "human at a PC" interface with hybrid Playwright + vision control.

---

## 1. Problem Statement

Claw'd agents need to interact with a full desktop environment — web pages, browser extensions (MetaMask, password managers), native apps, system dialogs — through a single coherent MCP API. The existing brainstorms establish the hybrid Docker + MCP architecture. What's missing is the **precise API design**: tool definitions, routing logic, state management, and failure handling.

### Core Design Challenge

Two fundamentally different control paradigms must feel like one API:

| Aspect | Layer 1 (Structured) | Layer 2 (Vision) |
|--------|---------------------|-------------------|
| **Engine** | Playwright/CDP | Screenshot + xdotool |
| **Targeting** | Element ref / selector | Pixel coordinates |
| **Accuracy** | ~95%+ deterministic | ~60-75% probabilistic |
| **Cost** | ~$0.03-0.06/action | ~$0.10-0.25/action |
| **Scope** | Web page content only | Everything on screen |
| **Latency** | ~100-500ms | ~2-5s (includes LLM call) |

The MCP server must route between these layers **automatically** while exposing escape hatches for explicit control.

---

## 2. Architecture: One Server, Two Engines

### Why ONE MCP Server (Not Two)

Previous brainstorms proposed separate Playwright MCP + Desktop MCP servers. This is wrong for the two-layer use case. Reasons:

1. **Routing burden shifts to agent**: The agent (LLM) must decide which server to call — it will get this wrong frequently
2. **No shared state**: Separate servers can't coordinate transitions (e.g., "Playwright action triggered extension popup, now use vision")
3. **Port proliferation**: Each additional MCP server needs a port, health check, supervisor entry
4. **Context fragmentation**: Agent must describe what it sees to one server when the other server triggered the state

**One server. Two internal engines. Automatic routing.**

```
┌──────────────────────────────────────────────────┐
│            Workspace MCP Server (:3100)           │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │            Routing & State Machine           │  │
│  │  ┌──────────────┐  ┌────────────────────┐   │  │
│  │  │ Context Stack │  │ Transition Detector│   │  │
│  │  └──────────────┘  └────────────────────┘   │  │
│  └──────────┬──────────────────┬───────────────┘  │
│             │                  │                   │
│  ┌──────────▼──────┐  ┌───────▼────────────────┐  │
│  │  Structured     │  │  Vision Engine          │  │
│  │  Engine         │  │                         │  │
│  │  ┌───────────┐  │  │  ┌──────┐ ┌─────────┐  │  │
│  │  │ Playwright │  │  │  │ scrot│ │ xdotool │  │  │
│  │  │ + CDP      │  │  │  └──────┘ └─────────┘  │  │
│  │  └───────────┘  │  │  ┌──────────────────┐   │  │
│  │                 │  │  │ Vision LLM / OCR  │   │  │
│  │                 │  │  └──────────────────┘   │  │
│  └─────────────────┘  └────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │  Shared Services                             │  │
│  │  • Screenshot cache    • Clipboard bridge    │  │
│  │  • Window tracker      • Action logger       │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## 3. Tool Definitions

### 3.1 Category: Browser & Environment Setup

#### `workspace_launch_browser`

Launches Chrome/Chromium with specified configuration. This is the entry point — must be called before any browser interaction.

```json
{
  "name": "workspace_launch_browser",
  "description": "Launch a browser instance with optional extensions. Returns browser session ID. Must be called before any browser interaction tools.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "extensions": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Paths to unpacked extensions to load (e.g., ['/extensions/metamask', '/extensions/ublock']). Extensions are pre-installed in the container image."
      },
      "start_url": {
        "type": "string",
        "description": "Initial URL to navigate to after launch. Defaults to 'about:blank'."
      },
      "viewport": {
        "type": "object",
        "properties": {
          "width": { "type": "number", "default": 1920 },
          "height": { "type": "number", "default": 1080 }
        },
        "description": "Browser viewport dimensions."
      },
      "user_data_dir": {
        "type": "string",
        "description": "Path to Chrome user data directory for persistent profiles/sessions. If omitted, uses a fresh temp profile."
      }
    },
    "required": []
  }
}
```

**Implementation notes:**
- Launches Chrome via Playwright's `chromium.launchPersistentContext()` with `--load-extension` flags
- Connects CDP session for extension/popup monitoring
- Registers `Target.targetCreated` listener for popup detection
- Returns `{ session_id, browser_pid, extensions_loaded: [...], cdp_port }`

#### `workspace_launch_app`

Launches a native desktop application.

```json
{
  "name": "workspace_launch_app",
  "description": "Launch a native desktop application (e.g., terminal, file manager, IDE). Application runs on the container's X11 display. Use workspace_screenshot to see the result.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "Shell command to launch the application (e.g., 'code /workspace', 'thunar', 'xterm')."
      },
      "wait_for_window": {
        "type": "boolean",
        "default": true,
        "description": "Wait for a new X11 window to appear before returning. Times out after 10s."
      }
    },
    "required": ["command"]
  }
}
```

**Implementation notes:**
- Spawns process with `DISPLAY=:99`
- If `wait_for_window`, polls `xdotool search --sync --onlyvisible` until new window appears
- Returns `{ pid, window_id, window_title, window_geometry }`

---

### 3.2 Category: Page Interaction (Auto-Routed)

These are the **primary tools** the agent calls. They attempt structured (Playwright) first, fall back to vision automatically.

#### `workspace_navigate`

```json
{
  "name": "workspace_navigate",
  "description": "Navigate the browser to a URL. Uses structured browser control. Returns the page title and a snapshot of visible elements.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "URL to navigate to."
      },
      "wait_until": {
        "type": "string",
        "enum": ["load", "domcontentloaded", "networkidle"],
        "default": "load",
        "description": "When to consider navigation complete."
      }
    },
    "required": ["url"]
  }
}
```

**Implementation:** Pure Playwright. No routing needed — navigation is always structured.
Returns: `{ url, title, snapshot_summary (truncated a11y tree) }`

#### `workspace_click`

The most critical auto-routed tool. This is where Layer 1 → Layer 2 transitions happen.

```json
{
  "name": "workspace_click",
  "description": "Click on an element or screen location. Automatically uses structured browser control when a page element is targeted, or vision-based coordinate control for extension popups, native dialogs, and desktop applications. Provide EITHER 'element' (for structured) OR 'coordinates' (for vision) OR 'description' (for auto-detection).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "element": {
        "type": "string",
        "description": "Playwright element reference from a previous snapshot (e.g., 'ref:14' or a CSS selector). Uses structured control. Preferred when available."
      },
      "coordinates": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" }
        },
        "description": "Absolute screen coordinates to click. Uses xdotool. For extension popups or native UI."
      },
      "description": {
        "type": "string",
        "description": "Natural language description of what to click (e.g., 'the MetaMask Confirm button', 'the Save dialog OK button'). Server takes a screenshot, identifies the element via vision, and clicks it. Slowest but most flexible."
      },
      "button": {
        "type": "string",
        "enum": ["left", "right", "middle"],
        "default": "left"
      },
      "double_click": {
        "type": "boolean",
        "default": false
      },
      "modifiers": {
        "type": "array",
        "items": { "type": "string", "enum": ["ctrl", "shift", "alt", "meta"] },
        "description": "Modifier keys to hold during click."
      }
    }
  }
}
```

**Routing logic (internal):**
```
if element provided:
    → Playwright click(element)
    → if fails (element detached/hidden):
        → take screenshot
        → return { success: false, screenshot, suggestion: "Element not found. Use 'description' or 'coordinates' instead." }

if coordinates provided:
    → xdotool mousemove --sync {x} {y} && xdotool click {button}
    → take verification screenshot
    → return { success: true, screenshot }

if description provided:
    → take screenshot
    → send to vision LLM: "Find the element matching '{description}' and return its coordinates"
    → xdotool click at identified coordinates
    → take verification screenshot
    → return { success: true, coordinates_used, screenshot }
```

#### `workspace_type`

```json
{
  "name": "workspace_type",
  "description": "Type text into the focused element or at the current cursor position. For web page inputs, targets the specified element (structured). For extension popups or native apps, types at the current keyboard focus (desktop-level).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "description": "Text to type."
      },
      "element": {
        "type": "string",
        "description": "Playwright element reference to focus before typing. If omitted, types at current keyboard focus."
      },
      "press_enter": {
        "type": "boolean",
        "default": false,
        "description": "Press Enter after typing."
      },
      "clear_first": {
        "type": "boolean",
        "default": false,
        "description": "Clear existing content before typing (Ctrl+A then type)."
      },
      "delay_ms": {
        "type": "number",
        "default": 0,
        "description": "Delay between keystrokes in ms. Use >0 for inputs that process each keystroke (autocomplete fields)."
      }
    },
    "required": ["text"]
  }
}
```

**Routing logic:**
```
if element provided:
    → Playwright focus(element) + fill(text) or type(text, delay)
if no element:
    → xdotool type --delay {delay_ms} "{text}"
    → if press_enter: xdotool key Return
```

#### `workspace_press_key`

```json
{
  "name": "workspace_press_key",
  "description": "Press a keyboard key or key combination. Works across both web pages and native applications.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "Key to press. Examples: 'Enter', 'Escape', 'Tab', 'Backspace', 'F5', 'ctrl+c', 'ctrl+shift+t', 'alt+F4'. For combinations, use '+' separator."
      },
      "element": {
        "type": "string",
        "description": "Optional Playwright element to focus first. If omitted, sends key to whatever has focus."
      }
    },
    "required": ["key"]
  }
}
```

**Routing:** Same pattern — element present → Playwright, absent → xdotool key.

#### `workspace_select`

```json
{
  "name": "workspace_select",
  "description": "Select an option from a dropdown/select element. Structured control only (web pages).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "element": {
        "type": "string",
        "description": "Playwright element reference for the select/dropdown."
      },
      "value": {
        "type": "string",
        "description": "Option value to select."
      },
      "label": {
        "type": "string",
        "description": "Option visible text to select (alternative to value)."
      }
    },
    "required": ["element"]
  }
}
```

#### `workspace_drag`

```json
{
  "name": "workspace_drag",
  "description": "Drag from one position to another. Supports both element-based (structured) and coordinate-based (vision) targeting.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from_element": { "type": "string", "description": "Source element reference." },
      "to_element": { "type": "string", "description": "Target element reference." },
      "from_coordinates": {
        "type": "object",
        "properties": { "x": { "type": "number" }, "y": { "type": "number" } }
      },
      "to_coordinates": {
        "type": "object",
        "properties": { "x": { "type": "number" }, "y": { "type": "number" } }
      },
      "duration_ms": {
        "type": "number",
        "default": 500,
        "description": "Duration of drag motion. Some apps need slower drags to register."
      }
    }
  }
}
```

**Routing:** Elements → Playwright dragTo(). Coordinates → xdotool mousemove + mousedown + mousemove + mouseup with duration.

---

### 3.3 Category: Observation & Context

#### `workspace_snapshot`

The primary observation tool. Returns structured page data when available.

```json
{
  "name": "workspace_snapshot",
  "description": "Get a structured snapshot of the current browser page's accessibility tree. This is the CHEAPEST and MOST ACCURATE way to understand web page content. Returns element references that can be used with click/type/select tools. Does NOT work for extension popups or native apps — use workspace_screenshot for those.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scope": {
        "type": "string",
        "description": "CSS selector to scope the snapshot to a specific region. Reduces token usage on complex pages."
      },
      "max_depth": {
        "type": "number",
        "default": 10,
        "description": "Maximum depth of the accessibility tree to return."
      }
    }
  }
}
```

**Implementation:** Playwright `page.accessibility.snapshot()` with filtering. Returns structured text representation with element refs.

**Returns:**
```json
{
  "type": "structured",
  "url": "https://app.uniswap.org",
  "title": "Uniswap Interface",
  "snapshot": "- heading 'Swap' [ref:1]\n- text 'You pay' [ref:2]\n- textbox 'Enter amount' value='' [ref:3]\n- button 'Select token' [ref:4]\n...",
  "element_count": 47,
  "truncated": false
}
```

#### `workspace_screenshot`

The universal observation tool. Works for everything on screen.

```json
{
  "name": "workspace_screenshot",
  "description": "Capture a screenshot of the screen or a specific region. Use this when workspace_snapshot is insufficient — extension popups, native apps, system dialogs, or to verify visual state. Returns a base64 image. More expensive than workspace_snapshot (requires vision model to interpret).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "region": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        },
        "description": "Capture only this region. Reduces image size and vision cost. Omit for full screen."
      },
      "resize_width": {
        "type": "number",
        "default": 1280,
        "description": "Resize screenshot to this width (maintains aspect ratio). Lower = cheaper vision analysis. Use 960 for quick checks, 1920 for precision."
      },
      "format": {
        "type": "string",
        "enum": ["png", "jpeg"],
        "default": "jpeg",
        "description": "Image format. JPEG is smaller (cheaper to transmit), PNG is lossless."
      }
    }
  }
}
```

**Implementation:** `scrot` for full screen, Playwright `page.screenshot()` for browser-only captures. ImageMagick for resize/crop.

**Returns:**
```json
{
  "type": "screenshot",
  "image_base64": "...",
  "mime_type": "image/jpeg",
  "dimensions": { "width": 1280, "height": 720 },
  "timestamp": "2026-03-02T10:30:00Z",
  "active_window": { "title": "MetaMask Notification", "geometry": "380x600+770+240" }
}
```

#### `workspace_observe`

High-level: combines screenshot + vision analysis in one call. The agent asks a question about what's on screen.

```json
{
  "name": "workspace_observe",
  "description": "Take a screenshot and analyze it with a vision model to answer a question about the current screen state. Useful for: 'Is the MetaMask popup visible?', 'What options are in this dialog?', 'Did the transaction confirm?'. Combines screenshot + vision analysis into one call.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": {
        "type": "string",
        "description": "What you want to know about the screen. Be specific."
      },
      "region": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        },
        "description": "Optional region to focus analysis on."
      }
    },
    "required": ["question"]
  }
}
```

**Implementation:** Screenshot → Gemini vision with prompt: `"Analyze this screenshot. {question}. If you identify clickable elements, include their approximate pixel coordinates."` 

**Returns:**
```json
{
  "answer": "Yes, a MetaMask popup is visible at approximately (770, 240). It shows a 'Confirm Transaction' dialog with fields: Gas fee: 0.002 ETH, Total: 1.502 ETH. There are two buttons: 'Reject' at approximately (850, 720) and 'Confirm' at (1020, 720).",
  "screenshot_base64": "...",
  "elements_found": [
    { "label": "Reject button", "coordinates": { "x": 850, "y": 720 }, "confidence": 0.92 },
    { "label": "Confirm button", "coordinates": { "x": 1020, "y": 720 }, "confidence": 0.95 }
  ]
}
```

#### `workspace_get_context`

Returns the current state of the workspace — what's focused, what's running, what control mode is active.

```json
{
  "name": "workspace_get_context",
  "description": "Get the current workspace state: active windows, focused element, browser tabs, detected popups, and recommended control mode. Call this when unsure about the current state or after an unexpected result.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Implementation:** Aggregates data from:
- `xdotool getactivewindow getwindowname` → active window
- `xdotool search --name "" getwindowname` → all windows
- Playwright `page.url()`, `page.title()` → browser state
- CDP target list → detected extension popups
- Internal state machine → current control mode

**Returns:**
```json
{
  "active_window": {
    "id": 48234567,
    "title": "MetaMask Notification",
    "class": "crx_nkbihfbeogaeaoehlefnkodbefgpgknn",
    "geometry": { "x": 770, "y": 240, "width": 380, "height": 600 }
  },
  "browser": {
    "tabs": [
      { "url": "https://app.uniswap.org", "title": "Uniswap", "active": false }
    ],
    "extension_popups": [
      { "id": "nkbihfbeogaeaoehlefnkodbefgpgknn", "title": "MetaMask Notification" }
    ]
  },
  "all_windows": [
    { "id": 48234567, "title": "MetaMask Notification" },
    { "id": 44123456, "title": "Uniswap Interface - Chromium" }
  ],
  "control_mode": {
    "recommended": "vision",
    "reason": "Active window is a Chrome extension popup (MetaMask). Playwright cannot interact with extension UI. Use workspace_screenshot + workspace_click with coordinates or description.",
    "structured_available": false
  },
  "clipboard": "0x1a2b3c...def0"
}
```

---

### 3.4 Category: Window & Clipboard Management

#### `workspace_window`

```json
{
  "name": "workspace_window",
  "description": "Manage desktop windows: focus, minimize, maximize, resize, close, or list all windows.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["focus", "minimize", "maximize", "restore", "close", "resize", "move", "list"],
        "description": "Window action to perform."
      },
      "window_id": {
        "type": "number",
        "description": "X11 window ID. Required for all actions except 'list'. Get from workspace_get_context."
      },
      "geometry": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        },
        "description": "For 'resize' and 'move' actions."
      }
    },
    "required": ["action"]
  }
}
```

**Implementation:** `xdotool windowactivate`, `xdotool windowminimize`, `wmctrl -r :ACTIVE: -b toggle,maximized_vert,maximized_horz`, etc.

#### `workspace_clipboard`

```json
{
  "name": "workspace_clipboard",
  "description": "Read from or write to the system clipboard. Works across all applications (browser, native apps, terminal). Essential for cross-app data transfer.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["read", "write", "copy", "paste"],
        "description": "'read': Get current clipboard content. 'write': Set clipboard content. 'copy': Send Ctrl+C to focused app then read clipboard. 'paste': Write to clipboard then send Ctrl+V to focused app."
      },
      "content": {
        "type": "string",
        "description": "Content to write to clipboard. Required for 'write' and 'paste' actions."
      }
    },
    "required": ["action"]
  }
}
```

**Implementation:** `xclip -selection clipboard` for read/write. `xdotool key ctrl+c` + `xclip` for copy. `xclip` + `xdotool key ctrl+v` for paste.

#### `workspace_wait`

```json
{
  "name": "workspace_wait",
  "description": "Wait for a condition to be true. Avoids polling with repeated screenshot calls. Much cheaper than a vision-based check loop.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "condition": {
        "type": "string",
        "enum": [
          "element_visible",
          "element_hidden",
          "url_contains",
          "title_contains",
          "window_appears",
          "window_closes",
          "file_exists",
          "duration"
        ],
        "description": "Condition to wait for."
      },
      "value": {
        "type": "string",
        "description": "Value for the condition: element ref/selector, URL substring, title substring, window title pattern, file path, or duration in ms."
      },
      "timeout_ms": {
        "type": "number",
        "default": 10000,
        "description": "Max time to wait before returning with timeout status."
      }
    },
    "required": ["condition"]
  }
}
```

**Implementation:**
- `element_visible/hidden`: Playwright `waitForSelector`
- `url_contains/title_contains`: Playwright `waitForURL` / poll `page.title()`
- `window_appears/closes`: Poll `xdotool search --name "{value}"`
- `file_exists`: Poll filesystem
- `duration`: Simple `setTimeout`

---

### 3.5 Category: Authentication Helpers

#### `workspace_handle_dialog`

```json
{
  "name": "workspace_handle_dialog",
  "description": "Handle browser dialogs (alert, confirm, prompt, beforeunload) and common native dialog patterns. For browser JS dialogs, this uses structured control. For file picker or OS-level dialogs, uses desktop interaction.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["accept", "dismiss", "fill_and_accept"],
        "description": "'accept': Click OK/Confirm. 'dismiss': Click Cancel/Close. 'fill_and_accept': Enter text in prompt dialog then accept."
      },
      "text": {
        "type": "string",
        "description": "Text to enter for prompt dialogs or file path for file picker dialogs."
      }
    },
    "required": ["action"]
  }
}
```

**Implementation:** Playwright's dialog handler for JS dialogs. For file pickers: detect GTK/Qt dialog via window class, use `xdotool` to type path + Enter.

#### `workspace_file_chooser`

```json
{
  "name": "workspace_file_chooser",
  "description": "Handle file upload dialogs. When a file chooser appears (from clicking an upload button), provide the file path(s) to upload. Uses structured control when triggered from Playwright-managed pages.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Absolute file paths to upload."
      }
    },
    "required": ["files"]
  }
}
```

**Implementation:** Playwright `page.on('filechooser')` + `fileChooser.setFiles()`. Falls back to typing path in native dialog.

---

## 4. Routing & State Machine

### 4.1 Context Stack

The server maintains a stack of "what's in front":

```typescript
interface ContextFrame {
  type: 'page' | 'extension_popup' | 'native_window' | 'dialog' | 'file_chooser';
  id: string;              // Playwright page ID, X11 window ID, or CDP target ID
  title: string;
  control_mode: 'structured' | 'vision' | 'hybrid';
  entered_at: number;      // timestamp
  triggered_by?: string;   // which tool call caused this frame
}

// Example stack during MetaMask flow:
[
  { type: 'page', id: 'page-1', title: 'Uniswap', control_mode: 'structured' },
  { type: 'extension_popup', id: 'target-abc', title: 'MetaMask Notification', control_mode: 'vision' }
]
```

### 4.2 Automatic Transition Detection

CDP events trigger stack updates:

```typescript
// Pseudo-code for transition detection
cdpSession.on('Target.targetCreated', (event) => {
  if (event.targetInfo.type === 'other' && isExtensionTarget(event.targetInfo.url)) {
    contextStack.push({
      type: 'extension_popup',
      title: event.targetInfo.title,
      control_mode: 'vision',  // Extensions ALWAYS need vision
      triggered_by: lastToolCall
    });
    // Notify: next tool response includes context_changed flag
  }
});

cdpSession.on('Target.targetDestroyed', (event) => {
  const frame = contextStack.findByTargetId(event.targetId);
  if (frame) {
    contextStack.pop(frame);
    // Automatically back to previous frame's control mode
  }
});

// X11 window monitoring (polling every 500ms)
xdotoolPoller.on('new_window', (windowInfo) => {
  if (!isKnownBrowserWindow(windowInfo)) {
    contextStack.push({
      type: 'native_window',
      title: windowInfo.name,
      control_mode: 'vision'
    });
  }
});
```

### 4.3 Routing Decision Tree

When a tool call arrives, the server decides the engine:

```
workspace_click({ element: "ref:14" })
  ├─ element provided → STRUCTURED engine
  │   ├─ Success → return result
  │   └─ Failure (element gone) → return error + auto-screenshot
  │       └─ Suggest: "Element not found. The page may have changed.
  │          Use workspace_snapshot to refresh, or workspace_click
  │          with 'description' for vision-based targeting."
  │
workspace_click({ coordinates: {x: 1020, y: 720} })
  ├─ coordinates provided → VISION engine (xdotool)
  │   ├─ Click executed → take verification screenshot → return
  │   └─ Click failed (xdotool error) → return error
  │
workspace_click({ description: "the Confirm button in MetaMask" })
  ├─ description provided → VISION engine (full cycle)
  │   ├─ Screenshot → vision LLM identifies element → xdotool click
  │   ├─ Vision found element → click → verify screenshot → return
  │   └─ Vision couldn't find element → return error + screenshot
  │       └─ "Could not identify 'the Confirm button in MetaMask'
  │          on screen. Screenshot attached for your review."
```

---

## 5. Example Flows

### 5.1 MetaMask DApp Transaction (Complete Flow)

```
AGENT                                    MCP SERVER                              DESKTOP
  │                                          │                                      │
  ├─ workspace_launch_browser ──────────────►│                                      │
  │  { extensions: ["/ext/metamask"],        │─── chromium.launch(--load-ext) ─────►│
  │    start_url: "https://app.uniswap.org" }│                                      │ Chrome opens
  │◄─ { session_id: "s1",                   │◄──────────────────────────────────────│
  │     extensions_loaded: ["metamask"] }    │                                      │
  │                                          │                                      │
  ├─ workspace_snapshot ────────────────────►│                                      │
  │  {}                                      │─── page.accessibility.snapshot() ───►│
  │◄─ { type: "structured",                 │◄──────────────────────────────────────│
  │     snapshot: "- button 'Connect         │                                      │
  │       Wallet' [ref:7] ..." }             │                                      │
  │                                          │                                      │
  ├─ workspace_click ───────────────────────►│                                      │
  │  { element: "ref:7" }                    │─── playwright click(ref:7) ─────────►│
  │                                          │                                      │ DApp triggers
  │                                          │◄── CDP: Target.targetCreated ────────│ MetaMask popup
  │                                          │    type: "other", url: "chrome-ext.."│
  │                                          │                                      │
  │                                          │─── contextStack.push({              │
  │                                          │      type: 'extension_popup',        │
  │                                          │      control_mode: 'vision' })       │
  │                                          │                                      │
  │◄─ { success: true,                      │                                      │
  │     context_changed: true,               │                                      │
  │     new_context: {                       │                                      │
  │       type: "extension_popup",           │                                      │
  │       title: "MetaMask Notification",    │                                      │
  │       control_mode: "vision",            │                                      │
  │       hint: "Extension popup detected.   │                                      │
  │         Use workspace_observe or         │                                      │
  │         workspace_screenshot to see it." │                                      │
  │     }                                    │                                      │
  │   }                                      │                                      │
  │                                          │                                      │
  │  [Agent sees control_mode: "vision"]     │                                      │
  │                                          │                                      │
  ├─ workspace_observe ─────────────────────►│                                      │
  │  { question: "What does the MetaMask     │─── scrot screenshot ────────────────►│
  │    popup show? What buttons are           │─── gemini.vision(screenshot,         │
  │    available?" }                          │      question) ──────► [VISION LLM]  │
  │                                          │◄────────── analysis ──────────────────│
  │◄─ { answer: "MetaMask shows 'Connect    │                                      │
  │     to Uniswap'. Two buttons visible:    │                                      │
  │     'Cancel' at (850, 680), 'Connect'    │                                      │
  │     at (1020, 680).",                    │                                      │
  │     elements_found: [                    │                                      │
  │       { label: "Connect", coordinates:   │                                      │
  │         {x:1020, y:680}, confidence:0.94}│                                      │
  │     ] }                                  │                                      │
  │                                          │                                      │
  ├─ workspace_click ───────────────────────►│                                      │
  │  { coordinates: {x: 1020, y: 680} }     │─── xdotool mousemove click ─────────►│ Clicks Connect
  │                                          │                                      │
  │                                          │◄── CDP: Target.targetDestroyed ──────│ Popup closes
  │                                          │─── contextStack.pop() ──────────────►│
  │                                          │                                      │
  │◄─ { success: true,                      │                                      │
  │     context_changed: true,               │                                      │
  │     new_context: {                       │                                      │
  │       type: "page",                      │                                      │
  │       title: "Uniswap Interface",        │                                      │
  │       control_mode: "structured",        │                                      │
  │       hint: "Back to web page.           │                                      │
  │         Use workspace_snapshot for        │                                      │
  │         efficient structured access."     │                                      │
  │     }                                    │                                      │
  │   }                                      │                                      │
  │                                          │                                      │
  │  [Agent sees control_mode: "structured"] │                                      │
  │                                          │                                      │
  ├─ workspace_snapshot ────────────────────►│                                      │
  │  {}                                      │─── page.accessibility.snapshot() ───►│
  │◄─ { snapshot: "- text 'Connected' ...    │                                      │
  │     - button 'Swap' [ref:22] ..." }      │                                      │
  │                                          │                                      │
  │  [Agent continues with structured tools] │                                      │
```

### 5.2 OAuth Login Flow (Google Sign-In Popup)

```
AGENT                                    MCP SERVER
  │                                          │
  ├─ workspace_click({ element: "ref:5" })   │  [Clicks "Sign in with Google"]
  │  (the Google login button on a web app)  │
  │                                          │─── playwright click
  │                                          │◄── New browser window detected
  │                                          │    (accounts.google.com)
  │                                          │    This IS a browser page → structured!
  │◄─ { success: true,                      │
  │     context_changed: true,               │
  │     new_context: {                       │
  │       type: "page",                      │  ← NOT extension, it's a new tab/popup
  │       title: "Sign in - Google Accounts", │
  │       control_mode: "structured",        │  ← Playwright can handle this!
  │     } }                                  │
  │                                          │
  ├─ workspace_snapshot()                    │  [Gets Google login form]
  │◄─ { snapshot: "- textbox 'Email or       │
  │     phone' [ref:31] ..." }               │
  │                                          │
  ├─ workspace_type({                        │  [Types email — structured]
  │    element: "ref:31",                    │
  │    text: "user@gmail.com",               │
  │    press_enter: true })                  │
  │                                          │
  │  ... [password entry, 2FA if needed] ... │
  │                                          │
  │  [OAuth completes, popup closes,         │
  │   original page regains focus]           │
  │                                          │
  │◄─ { context_changed: true,               │
  │     new_context: {                       │
  │       type: "page",                      │
  │       title: "MyApp - Dashboard",        │
  │       control_mode: "structured" } }     │
```

Key insight: OAuth popups that open as browser windows **stay in structured mode**. Only extension popups and native dialogs trigger vision mode. The server's CDP listener distinguishes these correctly.

### 5.3 2FA with Authenticator Extension

```
AGENT                                    MCP SERVER
  │                                          │
  │  [Login form asks for 2FA code]          │
  │  [Agent needs to get code from           │
  │   password manager extension]            │
  │                                          │
  ├─ workspace_press_key({                   │
  │    key: "ctrl+shift+x" })               │  [Opens extension panel]
  │                                          │─── xdotool key ctrl+shift+x
  │                                          │◄── CDP: extension popup detected
  │◄─ { success: true,                      │
  │     context_changed: true,               │
  │     new_context: {                       │
  │       type: "extension_popup",           │
  │       control_mode: "vision" } }         │
  │                                          │
  ├─ workspace_observe({                     │
  │    question: "What does the password     │
  │    manager extension show? Is there      │
  │    a TOTP code visible?" })              │
  │                                          │─── screenshot → vision LLM
  │◄─ { answer: "Shows entry for            │
  │     'myapp.com'. TOTP code: 847293.      │
  │     Copy button at (1100, 450).",        │
  │     elements_found: [...] }              │
  │                                          │
  ├─ workspace_click({                       │
  │    coordinates: {x: 1100, y: 450} })     │  [Clicks copy on TOTP]
  │                                          │─── xdotool click
  │◄─ { success: true }                     │
  │                                          │
  ├─ workspace_press_key({ key: "Escape" })  │  [Close extension popup]
  │                                          │─── xdotool key Escape
  │                                          │◄── CDP: extension popup destroyed
  │◄─ { context_changed: true,               │
  │     new_context: {                       │
  │       type: "page",                      │
  │       control_mode: "structured" } }     │
  │                                          │
  ├─ workspace_clipboard({ action: "read" }) │  [Read the copied TOTP]
  │◄─ { content: "847293" }                  │
  │                                          │
  ├─ workspace_type({                        │  [Paste into 2FA field]
  │    element: "ref:18",                    │
  │    text: "847293",                       │
  │    press_enter: true })                  │
```

---

## 6. Failure Handling & Retry Strategy

### 6.1 Failure Taxonomy

| Failure Type | Detection | Recovery Strategy |
|---|---|---|
| **Element not found** | Playwright throws | Re-snapshot → suggest updated ref |
| **Element not interactable** | Playwright throws | Wait 1s → retry → screenshot |
| **Vision can't locate element** | Vision LLM returns no match | Re-screenshot (state may have changed) → retry with different phrasing → return error + screenshot |
| **xdotool click missed target** | Verification screenshot differs from expected | Agent decides to retry (server can't know intent) |
| **Extension popup didn't appear** | Timeout on CDP target event | Return with `popup_detected: false` + screenshot |
| **Page navigation timeout** | Playwright timeout | Return partial load state + screenshot |
| **Application crash** | Process exit / window destroyed | Return error + suggest `workspace_launch_app` |

### 6.2 Universal Error Response Format

Every tool error includes diagnostic context:

```json
{
  "success": false,
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "Element 'ref:7' no longer exists in the page. The page may have been updated.",
    "recovery_hint": "Call workspace_snapshot to get fresh element references.",
    "screenshot_base64": "...",
    "context": {
      "url": "https://app.uniswap.org",
      "title": "Uniswap Interface",
      "control_mode": "structured"
    }
  }
}
```

### 6.3 Internal Retry Policy (Server-Side)

The server retries internally for **transient** failures only. Non-transient failures return immediately with diagnostics.

```typescript
const RETRY_POLICY = {
  // Transient — server retries automatically
  'ELEMENT_NOT_INTERACTABLE': { retries: 2, delay_ms: 500, strategy: 'wait_and_retry' },
  'NAVIGATION_TIMEOUT':       { retries: 1, delay_ms: 2000, strategy: 'retry' },
  'XDOTOOL_DISPLAY_ERROR':    { retries: 1, delay_ms: 1000, strategy: 'retry' },

  // Non-transient — return to agent immediately with diagnostics
  'ELEMENT_NOT_FOUND':        { retries: 0, strategy: 'snapshot_and_report' },
  'VISION_NO_MATCH':          { retries: 0, strategy: 'screenshot_and_report' },
  'WINDOW_NOT_FOUND':         { retries: 0, strategy: 'list_windows_and_report' },
  'APPLICATION_CRASHED':      { retries: 0, strategy: 'report' },
};
```

### 6.4 `context_changed` Flag

Critical design element: whenever the foreground context changes (popup appears, window closes, page navigates), the tool response includes a `context_changed` flag. This is **proactive notification** — the agent doesn't have to poll.

```json
{
  "success": true,
  "result": { ... },
  "context_changed": true,
  "new_context": {
    "type": "extension_popup",
    "title": "MetaMask Notification",
    "control_mode": "vision",
    "hint": "Extension popup detected. Structured control unavailable. Use workspace_observe or workspace_screenshot."
  }
}
```

This eliminates the "agent clicks button and doesn't realize a popup appeared" failure mode.

---

## 7. Cost Optimization Strategies

### 7.1 Token Budget by Control Mode

| Operation | Tokens (input) | Cost @ $3/M | Notes |
|-----------|----------------|-------------|-------|
| `workspace_snapshot` (typical page) | ~8,000-20,000 | $0.024-0.060 | Structured, no image |
| `workspace_snapshot` (scoped) | ~2,000-5,000 | $0.006-0.015 | CSS selector filter |
| `workspace_screenshot` (1280px JPEG) | ~1,500 tokens | $0.0045 | Image only, no analysis |
| `workspace_observe` | ~2,500 tokens | $0.0075 + vision cost | Screenshot + vision LLM |
| Vision LLM analysis (Gemini) | N/A | $0.01-0.05 | External API call |
| **Total vision action cycle** | - | **$0.02-0.06** | Screenshot + analysis + verify |
| **Total structured action** | - | **$0.001-0.005** | Element ref click, no image |

### 7.2 Optimization Rules (Embedded in Tool Descriptions)

The tool descriptions themselves guide the agent toward cheaper paths:

1. `workspace_snapshot` description says: *"This is the CHEAPEST and MOST ACCURATE way..."*
2. `workspace_screenshot` description says: *"More expensive than workspace_snapshot..."*
3. `workspace_observe` description says: *"Combines screenshot + vision analysis..."* (signals it's costly)
4. `workspace_click` with `element` is documented as *"Preferred when available"*

### 7.3 Smart Screenshot Caching

Server-side optimization: if multiple observation tools are called within 500ms, reuse the same screenshot:

```typescript
class ScreenshotCache {
  private cache: { image: Buffer; timestamp: number } | null = null;
  private TTL_MS = 500;

  async capture(): Promise<Buffer> {
    if (this.cache && Date.now() - this.cache.timestamp < this.TTL_MS) {
      return this.cache.image;  // reuse
    }
    const image = await scrot();
    this.cache = { image, timestamp: Date.now() };
    return image;
  }
}
```

---

## 8. Tool Summary Table

| # | Tool | Layer | Purpose |
|---|------|-------|---------|
| 1 | `workspace_launch_browser` | Structured | Start Chrome with extensions |
| 2 | `workspace_launch_app` | Vision | Start native desktop app |
| 3 | `workspace_navigate` | Structured | Go to URL |
| 4 | `workspace_click` | **Auto-routed** | Click element/coordinate/description |
| 5 | `workspace_type` | **Auto-routed** | Type text into focused element |
| 6 | `workspace_press_key` | **Auto-routed** | Press keyboard shortcut |
| 7 | `workspace_select` | Structured | Select dropdown option |
| 8 | `workspace_drag` | **Auto-routed** | Drag and drop |
| 9 | `workspace_snapshot` | Structured | Get accessibility tree (cheap) |
| 10 | `workspace_screenshot` | Vision | Capture screen image |
| 11 | `workspace_observe` | Vision | Screenshot + vision analysis |
| 12 | `workspace_get_context` | Both | Get workspace state & control mode |
| 13 | `workspace_window` | Vision | Manage desktop windows |
| 14 | `workspace_clipboard` | Vision | Read/write system clipboard |
| 15 | `workspace_wait` | Both | Wait for condition |
| 16 | `workspace_handle_dialog` | **Auto-routed** | Handle dialogs |
| 17 | `workspace_file_chooser` | Structured | Handle file uploads |

**17 tools. 5 auto-routed. 6 structured-only. 4 vision-only. 2 hybrid.**

---

## 9. Implementation Considerations

### 9.1 Container Image Changes

The Dockerfile from the existing brainstorm needs these additions:

```dockerfile
# Additions for the unified workspace MCP server:
# 1. Chrome extensions pre-installed as unpacked dirs
COPY extensions/metamask /extensions/metamask
COPY extensions/ublock /extensions/ublock

# 2. xclip for clipboard operations
RUN apt-get install -y xclip wmctrl

# 3. The workspace MCP server itself (TypeScript, runs on Bun or Node)
COPY workspace-mcp-server /opt/workspace-mcp
WORKDIR /opt/workspace-mcp
RUN npm install

# 4. Supervisor config starts ONE MCP server (not two)
# The single server internally manages Playwright + xdotool
```

### 9.2 Technology Choice: Bun vs Node

The MCP server inside the container should use **Node.js** (not Bun) because:
- Playwright has first-class Node support
- The `@anthropic/playwright-mcp` reference implementation is Node
- Container image already needs Node for Playwright
- Bun's Playwright support is less tested

Claw'd host stays Bun. Container MCP server is Node. No conflict.

### 9.3 Estimated Implementation Size

| Component | Lines (est.) | Complexity |
|-----------|-------------|------------|
| MCP server scaffold (HTTP transport, tool routing) | ~300 | Low |
| Structured engine (Playwright wrapper) | ~500 | Medium |
| Vision engine (screenshot + xdotool wrapper) | ~400 | Medium |
| Vision LLM integration (Gemini API calls) | ~200 | Low |
| Context stack & transition detection | ~350 | High |
| Auto-routing logic | ~200 | Medium |
| Tool definitions (17 tools) | ~600 | Low (repetitive) |
| Error handling & retry | ~250 | Medium |
| Screenshot cache & optimization | ~100 | Low |
| **Total** | **~2,900** | |

This is a **2-3 week build** for one senior developer, or **1-2 weeks** if starting from the `@anthropic/playwright-mcp` codebase and extending it.

---

## 10. Risks & Open Questions

### 10.1 Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Vision LLM accuracy on extension popups** | High | Return coordinates with confidence scores; agent can verify before clicking. Provide `workspace_observe` for pre-flight checks. |
| **CDP extension popup detection is unreliable** | Medium | Supplement with X11 window monitoring (`xdotool` polling every 500ms). Belt-and-suspenders. |
| **Context stack gets out of sync** | Medium | `workspace_get_context` provides full state reset. Agent calls it when confused. Server reconciles on every call. |
| **Accessibility tree exceeds token limits** | Medium | Scoped snapshots via CSS selector. Truncation with `max_depth`. Document in tool descriptions. |
| **Extension popups render at unpredictable coordinates** | Low | `workspace_observe` + vision handles this. No hardcoded coordinates. |

### 10.2 Open Questions

1. **Should `workspace_observe` use the agent's own LLM or a separate cheaper vision model?** Using Gemini Flash for vision analysis (~$0.01/call) is much cheaper than routing through the agent's primary model (Sonnet/Opus). Recommendation: dedicated Gemini vision endpoint.

2. **Should the server expose a `workspace_scroll` tool?** Playwright handles scrolling implicitly (scrolls to element before clicking). But vision mode may need explicit scroll. Consider adding if needed during implementation.

3. **Should the server record action history for replay/debugging?** An action log is cheap (~50 bytes/action) and invaluable for debugging. Recommendation: always log, expose via `workspace_get_history` tool.

4. **How to handle Chrome extension installation at runtime?** Current design pre-installs extensions in the container image. For runtime installation, the agent would need to navigate to `chrome://extensions`, enable developer mode, and load unpacked — all via vision. This is possible but fragile. Recommendation: pre-install known extensions, defer runtime installation.

---

## 11. Verdict

### What This Design Gets Right

1. **One server, not two** — eliminates the routing-burden-on-agent problem from earlier brainstorms
2. **Auto-routing with escape hatches** — simple for common cases, powerful for edge cases
3. **`context_changed` proactive notification** — solves the "agent doesn't realize a popup appeared" problem
4. **Cost-aware tool descriptions** — guides the agent toward cheaper structured tools by default
5. **17 tools, not 30+** — focused API surface that covers the stated requirements without bloat
6. **Universal error format with screenshots** — never leaves the agent blind after a failure

### What Could Be Better

1. **No AT-SPI integration** — Linux accessibility protocol could provide structured access to some native apps (GTK/Qt). Deferred per YAGNI, but would reduce vision dependency.
2. **Vision LLM coupling** — The server depends on an external vision API. If that API is down, all vision tools fail. Need to handle gracefully.
3. **No multi-tab orchestration** — The current design tracks one active page. Multi-tab workflows (e.g., copy data between tabs) need tab switching tools. Could extend `workspace_navigate` or add `workspace_tab`.

### Score: 8.5/10

The design is pragmatic, cost-aware, and solves the specific MetaMask/extension/native-app gaps that pure Playwright cannot handle. It fits cleanly into Claw'd's existing MCP architecture. The main risk is vision accuracy on complex extension popups, mitigated by confidence scores and agent verification.

---

## 12. Next Steps

1. **Prototype the context stack** — build just the CDP listener + X11 poller to validate transition detection works reliably for MetaMask popups
2. **Validate `workspace_observe` accuracy** — run 50 MetaMask popup screenshots through Gemini vision, measure coordinate accuracy
3. **Build from `@anthropic/playwright-mcp`** — fork the reference implementation, extend with vision engine and context stack
4. **Define extension catalog** — which extensions ship pre-installed in the container image? MetaMask, what else?
5. **Create implementation plan** — break the ~2,900 lines into phased deliverables
