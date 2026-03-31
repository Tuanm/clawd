# Claw'd UI Design System

> **Purpose:** This document is the canonical reference for Claw'd's UI design language. All future UI work — new components, refactors, visual polish — must align with what is described here. When in doubt, read this first.
>
> **Verified:** Audited by 3 independent review agents against `packages/ui/src/styles.css` (8,929 lines) and all component source files. Last updated 2026-03-31.

---

## Table of Contents

1. [Philosophy & Vibe](#1-philosophy--vibe)
2. [Design Tokens](#2-design-tokens)
3. [Typography](#3-typography)
4. [Color System](#4-color-system)
5. [Layout & Spacing](#5-layout--spacing)
6. [The Mascot (Claw'd Crab)](#6-the-mascot-clawd-crab)
7. [Message System](#7-message-system)
8. [Message Composer](#8-message-composer)
9. [Artifact System](#9-artifact-system)
10. [Interactive Components](#10-interactive-components)
11. [Sidebar Panel](#11-sidebar-panel)
12. [Dialogs & Modals](#12-dialogs--modals)
13. [Diff Viewer & Worktree](#13-diff-viewer--worktree)
14. [Animation System](#14-animation-system)
15. [Dark Mode & Responsive](#15-dark-mode--responsive)
16. [Markdown & Code Rendering](#16-markdown--code-rendering)
17. [Icons & SVGs](#17-icons--svgs)
18. [Accessibility Primitives](#18-accessibility-primitives)
19. [Additional UI Surfaces](#19-additional-ui-surfaces)

---

## 1. Philosophy & Vibe

**Claw'd is a Slack-inspired chat UI for autonomous AI agents.** The design language draws heavily from Slack's information density and interaction patterns, then layers in warmth, personality, and a distinctive orange/coral brand accent.

### Core Design Principles

- **Familiar but alive** — The layout is unmistakably chat-like (think Slack), so users are immediately oriented. But crab animations, pulsing avatars, and streaming content make it feel like a living, breathing workspace rather than a static messaging app.
- **Warmth over sterility** — Neutral grays are replaced with warm off-whites and near-blacks that have subtle warm undertones. Nothing is pure `#000` or `#fff`.
- **Content-first** — The chrome is minimal. Borders, backgrounds, and UI furniture are expressed via low-opacity text-color overlays rather than hardcoded grays. This means the entire UI shifts tonally if you change only the `--text` variable.
- **Playful engineering** — The pixel-art Claw'd crab mascot is not decorative lip-service; it is a genuine character with legs, eyes, animations, and states. Its coral color (`hsl(15 63.1% 59.6%)`) is the brand accent used everywhere.
- **Progressive disclosure** — Hover states reveal actions (copy button, message toolbar, artifact actions). Nothing clutters the default view.

### What Claw'd Is NOT

- It is not a dark-first app. Light mode is the default; dark mode is user-toggleable via the Moon/Sun button in the composer toolbar (`localStorage["clawd-theme"]`).
- It is not a minimal/monochrome design system. The accent color and warmth are deliberate and should be preserved.
- It is not a generic Material/Tailwind component library. Styles are custom CSS with semantic class names.

---

## 2. Design Tokens

All tokens are CSS custom properties on `:root`. The entire UI is built on these — never hardcode a color without consulting this table first.

```css
:root {
  /* Brand accent — warm orange/coral */
  --accent: 15 63.1% 59.6%;

  /* Background colors */
  --bg: 48 33.3% 97.1%;         /* Warm off-white — main app background */
  --bg-center: 0 0% 100%;        /* Pure white — dialogs, modals, popovers */

  /* Text */
  --text: 60 2.6% 7.6%;         /* Near-black with warm undertone */

  /* Derived semantic vars (also defined in :root) */
  --text-secondary: hsl(var(--text) / 70%);
  --text-muted: hsl(var(--text) / 50%);

  /* Scale */
  --ui-scale: 1.25;              /* App scaled up 25% via CSS transform */
}
```

> **Note:** `--bg-dim`, `--bg-highlight`, `--text-dim`, `--border-dim` are **referenced** in several CSS rules but are **never defined** in `:root`. They are currently orphaned/undefined and resolve to empty — effectively a CSS gap. Do not rely on them.

### Derived Usage Patterns

| Purpose | CSS |
|---|---|
| Primary text | `hsl(var(--text))` |
| Secondary text | `hsl(var(--text) / 70%)` |
| Muted text | `hsl(var(--text) / 50%)` |
| Very muted | `hsl(var(--text) / 40%)` |
| Faint text | `hsl(var(--text) / 30%)` |
| Thin border | `hsl(var(--text) / 10%)` |
| Subtle border | `hsl(var(--text) / 12%)` |
| Hover bg | `hsl(var(--text) / 5–8%)` |
| Accent color | `hsl(var(--accent))` |
| Accent hover | `hsl(var(--accent) / 8%)` |
| Send button active | `hsl(15 63.1% 45%)` — darker accent |
| Error/danger | `hsl(0 72% 51%)` |
| Error muted | `hsl(0 70% 55%)` |
| Success | `hsl(142 60% 40%)` |

### App Scale

The entire app wraps in a CSS transform: `scale(var(--ui-scale))` with `transform-origin: top left`, where `--ui-scale: 1.25`. This means the app renders at 125% of the browser viewport — effectively making everything 25% larger without changing any absolute pixel values in the CSS. **Do not attempt to compensate for this in new components.**

---

## 3. Typography

### Font Stack

**Primary (UI):**
```css
font-family: "Lato", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```
Lato is loaded from Google Fonts at weights **400, 700, 900**. It is always the named first choice; system fonts are fallbacks only.

**Monospace (code/diffs):**
```css
/* General code */
font-family: Monaco, Menlo, Consolas, "Courier New", monospace;

/* Stream dialog (terminal-feel) */
font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace;

/* Diff viewer / agent file editor */
font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
```

### Type Scale

| Element | Size | Weight | Notes |
|---|---|---|---|
| Message sender name | 15px | 900 | Lato Black — most prominent weight |
| Message body | 15px | 400 | |
| Code inline | ~12–13px | 400 | Monospace, `#f4f4f4` bg, `#e01e5a` color |
| Timestamp | 12px | 400 | Muted |
| Artifact type badge | 40px height | 700 | Small label text inside |
| Sidebar panel title | 14px | 600 | |
| Dialog field labels | 13px | 600 | |
| Context menu items | 14px | 400 | |
| Section headers (worktree) | 11px | 700 | Uppercase, letter-spacing: 0.04em |
| Tool call descriptions | 13px | 400 | |
| Diff viewer | 12px | 400 | Monospace |
| Interactive text | 15px | 400 | Matches message body |
| Composer disclaimer | 9px | 400 | `hsl(var(--accent) / 20%)` — very faint |

### Line Height

- **Standard (messages):** `1.46668` — This is Slack's exact line-height value, carried over deliberately.
- **Code blocks:** `1.5–1.6`
- **Diff lines:** `1.5`

---

## 4. Color System

### Brand Accent: Warm Orange/Coral

```
hsl(15 63.1% 59.6%)  →  approximately #D97853
```
This is the **single brand color**. It appears on:
- The Claw'd crab mascot body/legs
- The send button (darker shade: `hsl(15 63.1% 45%)`)
- Active/selected interactive components
- Artifact card hover borders (at 30% opacity)
- Tab active underlines
- Focus borders on inputs
- The `/` pill for slash commands
- Trigger pills in skill files

### Semantic Colors

```
Error/Danger:  hsl(0 72% 51%)     — red
Success/Add:   hsl(142 60% 40%)   — green (used in diffs)
Warning:       hsl(45 80% 50%)    — gold (SVG artifact type)
Remove:        hsl(0 70% 55%)     — red (used in diffs)
Stage (diff):  #4ec94e            — bright green
Unstage:       #6ba3f7            — blue
Revert:        #e55050            — red
Unread badge:  hsl(0 72% 51%)     — red
```

### Background Architecture

The app background is **not flat** — it uses a layered system:

1. **Base:** `hsl(48 33.3% 97.1%)` — warm off-white
2. **Dot pattern overlay:** `radial-gradient(circle, hsl(var(--text) / 12%) 1px, transparent 1px)` at `16px 16px` spacing
3. **Message hover:** Full-width white `::before` pseudo-element that slides in — matches `--bg-center: 0 0% 100%` (pure white)
4. **Modals/dialogs:** `hsl(var(--bg-center))` — pure white, no dot pattern
5. **Sidebar:** `hsl(var(--bg))` — same warm off-white as app

The dot grid is also reused as the background for modal overlays (`.projects-dialog`, `.artifact-modal-overlay`), creating visual continuity even in layered contexts.

### Artifact Type Colors

Each of the 8 artifact types has a dedicated HSL color used for its badge and hover accent:

| Type | Color | Icon |
|---|---|---|
| HTML | `hsl(15 80% 55%)` | `</>` |
| React | `hsl(200 80% 55%)` | `R` |
| SVG | `hsl(45 80% 50%)` | `S` |
| Chart | `hsl(260 70% 60%)` | `C` |
| CSV | `hsl(140 60% 45%)` | `T` |
| Markdown | `hsl(210 15% 55%)` | `M` |
| Code | `hsl(180 50% 45%)` | `{}` |
| Interactive | `hsl(30 70% 55%)` | `⚡` |

---

## 5. Layout & Spacing

### Overall Structure

```
┌─────────────────────────────────────────┐
│  Header (fixed, ~48px)                  │
│  [ClawdLogo] [channel name] [actions]   │
├─────────────────────────────────────────┤
│  MessageList (flex: 1, scrollable)      │
│  ┌─────────────────────────────────┐    │
│  │  Messages with avatars          │    │
│  │  Unread separator               │    │
│  └─────────────────────────────────┘    │
├─────────────────────────────────────────┤
│  MessageComposer (fixed bottom)         │
│  [textarea + formatting toolbar]        │
└─────────────────────────────────────────┘
          ↔ SidebarPanel (80vw, slides in from right)
```

### Spacing Rhythm

- **4px** — Tight gaps (icon button padding, badge padding)
- **6px** — Compact vertical padding (header items, small buttons)
- **8px** — Standard small gap
- **12px** — Medium padding (dialog fields, code blocks)
- **16px** — Standard content padding (sidebar body, artifact modal)
- **20px** — Larger dialog sections
- **24px** — Generous vertical breathing room

### Message Layout Dimensions

- **Avatar:** 36px × 36px, **6px** border-radius (rounded square, not circle)
- **Avatar-to-content gap:** 12px (`.message { gap: 12px; }`)
- **Message block padding:** `0 24px` (desktop)
- **Message hover white bg:** full-width white via `::before` pseudo-element
- **Scroll to bottom button:** 40px diameter, white background, thin gray border (`1px solid #ddd`); gains red border in `.has-unread` state

### Scrollbars

Custom styled throughout:
- **Width:** 8px (message list)
- **Thumb:** `hsl(var(--text) / 20%)`, rounded
- **Track:** transparent
- Thin variant (dropdowns, e.g. `.home-dropdown`): 6px, `hsl(var(--text) / 15%)` thumb

---

## 6. The Mascot (Claw'd Crab)

The Claw'd crab is a pixel-art SVG character rendered as an inline SVG in the header (`ClawdLogo` component). It is also rendered as a chat message avatar via `.clawd-avatar-*` classes.

### Visual Character

- **Body:** Warm coral/orange (`hsl(15 63.1% 59.6%)` = `#D97853`) — exact brand accent color
- **Eyes:** Black pupils on white sclera — blink every ~10 seconds
- **Claws:** Two raised claws, same coral color
- **Legs:** 4 pairs, animated when running or standing

### Animation States

The mascot has distinct CSS animation states:

| State | Class | Animation | Notes |
|---|---|---|---|
| Running in | `.clawd-running-in` | `clawd-run-in` | App load entry |
| Streaming/active (header) | header class | `leg-run1` / `leg-run2` alternating | 0.15s period — fast run |
| Standing (message avatar) | `.clawd-avatar-standing` | `clawd-leg-run-1` / `clawd-leg-run-2` | 0.3s period — slower, resting walk |
| Streaming (message avatar) | `.clawd-avatar-streaming` | `clawd-leg-run-1` / `clawd-leg-run-2` | 0.15s period — fast |
| Bouncing (message avatar) | `.clawd-avatar-streaming .clawd-avatar-svg` | `clawd-avatar-bounce` | Vertical bounce while streaming |
| Blinking | Always on | `blink` at 10s intervals | Eyes close/open continuously |
| Sleeping | `.sleeping-clawd` | `sleeping-blink` at 3s intervals | More exaggerated blink; applied to `.clawd-eye` |
| Heartbeat pulse | `.stream-agent-avatar-dot.heartbeat-pulse` | `heartbeat-zoom` | On the agent status dot, not mascot body |

> **Important:** `heartbeat-zoom` applies to `.stream-agent-avatar-dot.heartbeat-pulse` — the small colored status dot in the agent selector bar — NOT to the crab body itself. The pulse goes `scale(1) opacity(0.7) → scale(1.08) opacity(1) → scale(1) opacity(0.7)`.

### Blink Keyframe (exact)

```css
@keyframes blink {
  0%, 96%, 100% { transform: scaleY(1); }
  98%           { transform: scaleY(0.15); }
}
```

### Leg Naming Clarification

Two separate sets of leg keyframes exist:
- **`leg-run1` / `leg-run2`** — used on the header/logo crab legs
- **`clawd-leg-run-1` / `clawd-leg-run-2`** — used on message avatar crab legs

Both produce the same running motion at different scales/contexts.

---

## 7. Message System

### Message Anatomy

```
[Avatar 36px] [Sender Name 15px/900] [Timestamp 12px muted]
              [Message content — markdown rendered]
              [Artifact cards, file cards, tool calls, etc.]
              [Reactions (if any)]
[Seen avatars — small 16px circles, right-aligned]
```

### Continuation Messages (Slack-style Grouping)

When consecutive messages come from the same sender within a time window, the avatar and sender name are hidden in subsequent messages. The vertical space collapses and the content aligns under the original sender's content column. Only a small left-margin timestamp hint appears on hover.

### Message States

| State | Visual |
|---|---|
| Normal | Standard layout |
| Streaming | Avatar bounces (`.clawd-avatar-streaming`), content grows in real-time |
| Thinking | Separate `thinking_text` shown in italic/muted style above main content |
| Sleeping agent | Dimmed avatar with `is_sleeping` indicator; `sleeping-blink` animation on eye |
| Failed (pending) | Red error text with retry button |
| Sending (pending) | Opacity reduced, no avatar |

### Tool Result Cards

Tool calls render as expandable cards inside messages:
- **Running:** Spinner + tool name + description
- **Succeeded:** Green checkmark + collapsible result
- **Failed:** Red × + error message

The tool name is shown in monospace. The card uses a subtle border and can be expanded/collapsed via a chevron button.

### Unread Separator

A horizontal `<hr>`-style separator with "New messages" label (CSS `text-transform: uppercase` renders it as "NEW MESSAGES") appears between read and unread messages. Uses `hsl(0 72% 51%)` (danger red). Has no entry animation — it simply renders in place.

### Subspace / Workspace Cards

Agent sub-space attachments render as bordered cards with a colored status dot (green=active, gray=completed, red=failed), title, description, and agent avatar. Clickable to open the subspace.

### Article Attachments

Articles render as horizontal card previews with thumbnail (left), title + description + author (right), hover highlight with accent border.

### Mermaid Diagrams

Rendered inline via the `mermaid` library. Theme: `"dark"` in dark mode, `"neutral"` in light mode. Font: `"Lato, sans-serif"`. Render is debounced 300ms to avoid re-rendering on every keystroke during streaming.

### Math / LaTeX

KaTeX is available via `rehypeKatex` + `remarkMath`. Both inline (`$...$`) and block (`$$...$$`) math are rendered.

### Message Hover Toolbar

On hover, a toolbar floats above the message (top-right) with actions: copy, share link, reactions. Appears via `opacity: 0 → 1` transition (0.15s), z-index 5.

---

## 8. Message Composer

### Editor: Plain `<textarea>`

The composer uses a **plain `<textarea>`** (`<textarea className="composer-raw-textarea" ...>`). It is NOT TipTap or ProseMirror. Markdown formatting is applied via string manipulation helpers.

### Visual Design

```
┌──────────────────────────────────────────┐  ← 8px border-radius box
│  [Formatting toolbar — optional]         │  ← Bold/Italic/Code/Link/List buttons
│  [Placeholder text]                      │  ← 1px border hsl(text/20%)
│  <textarea>                              │  ← Focus: accent border
│                                          │
│ [Tools row] ···  [/skill] [context] [⬆] │  ← Action toolbar row
└──────────────────────────────────────────┘
│ Claw'd can make mistakes. You too.       │  ← Disclaimer, 9px, 20% accent
```

- **Border:** `1px solid hsl(var(--text) / 20%)` → `hsl(var(--accent))` on focus
- **Border-radius:** 8px
- **Send button:**
  - Inactive (empty): muted icon, transparent background
  - Active (has content): `hsl(15 63.1% 45%)` background, white icon
  - Hover: same accent fill (`hsl(15 63.1% 45%)`) + white icon — no opacity change

### Formatting Toolbar

An optional markdown formatting toolbar (toggled via `localStorage` key `chat-composer-toolbar`) with buttons: **Bold**, **Italic**, **Strikethrough**, **Link**, **Bullet list**, **Inline code**, **Code block**.

### Auto-overflow Action Toolbar (`ToolsMenuButton`)

When the composer is narrow, action buttons (file attach, mention, skill, worktree, MCP, tasks) collapse into a `⋮` overflow dropdown (`.composer-overflow-dropdown`) portaled to `document.body`. Icons are 28×28px, same hover style.

### Drag-and-Drop File Upload

The composer supports full drag-and-drop:
- `.dragging` class applied to `.composer-wrapper` during drag
- `.drop-overlay` "Drop files here" indicator rendered over the composer

### Character Counter

When message length ≥ 4,000 characters:
- A counter appears showing char count + token estimate + context % usage

When > 30,000 characters:
- Changes to an orange summarization warning

### Disclaimer

`div.composer-disclaimer` renders `"Claw'd can make mistakes. You too."` below the composer box:
- `font-size: 9px`
- `color: hsl(var(--accent) / 20%)` — very faint

### Keyboard Behavior

- `Enter` — submit message
- `Shift+Enter` — new line within message
- Mentions: `@` triggers mention autocomplete popup

### Context Menu

Custom context menu (not browser default) via `createPortal`. Right-click in composer shows Copy/Paste. Positioned absolutely relative to cursor position.

---

## 9. Artifact System

### What Are Artifacts?

Artifacts are rich content attachments that agents can embed in messages. They have 8 types and can be displayed inline, in a modal, or in the sidebar panel.

### 8 Artifact Types

| Type | Display mode | Color | Description |
|---|---|---|---|
| `html` | Sidebar (artifact renderer / sandboxed iframe) | Orange | Full HTML pages/apps — rendered via `SandboxedIframe` inside the sidebar's `artifact` panel |
| `react` | Sidebar | Blue | React components |
| `svg` | Inline in message | Gold | SVG graphics |
| `chart` | Inline in message | Purple | JSON chart specs (Recharts) |
| `csv` | Sidebar (table) | Green | CSV data tables |
| `markdown` | Sidebar | Blue-gray | Markdown documents |
| `code` | Modal | Teal | Code with syntax highlighting |
| `interactive` | Inline in message | Orange | Declarative interactive forms |

> **Note:** The sidebar's `type: "iframe"` panel mode is exclusively for external URL embeds (Google Docs, Figma links, etc.). HTML/React artifacts use `type: "artifact"` which internally renders via `FullArtifactRenderer` / `SandboxedIframe`.

### Artifact Preview Card

Compact cards appear inside messages:

```
┌─────────────────────────────┐
│ [TYPE BADGE] [Title]  [...] │  ← 40px × 40px badge, 6px radius, type color
│              [Description]  │
└─────────────────────────────┘
```

- **Badge:** 40×40px, `6px border-radius`, type-specific color, white text
- **Card border:** `1px solid hsl(var(--text) / 10%)`
- **Hover:** Full border color shifts to `hsl(var(--accent) / 30%)` — no white background, no left-border-only accent

### Streaming Artifact Card

During generation, a `StreamingArtifactCard` shows:
- Dashed border with `artifact-pulse` animation (border-color oscillates)
- Live content preview in a sandboxed iframe or direct render
- Auto-scrolls to bottom as content grows

### Inline Artifact (Chart/SVG)

Charts and SVGs render directly inside the message column:
- `8px` border-radius wrapper
- Header bar: 12px gray text showing title + type, with action buttons (hidden until hover)
- Streaming skeleton: `inline-artifact-skeleton` shimmer animation until content arrives

### Artifact Modal

Full-screen modal for viewing artifacts:
- Backdrop: blurred (`blur(12px)`) + dot-pattern background matching app
- Content panel: pure white (`hsl(var(--bg-center))`), 8px radius, 90vh height
- Header: type badge + title + actions (download, expand, copy) + close button
- Mobile: full-viewport (no radius)

---

## 10. Interactive Components

The `interactive` artifact type allows agents to embed live form controls inside messages. These **blend seamlessly with message content** — no card border, no background.

### Component Library

| Component | Class prefix | Notes |
|---|---|---|
| Text | `.interactive-text` | Markdown-capable, 15px matches message body |
| Button | `.interactive-btn` | 3 variants: primary, secondary, danger |
| Button Group | `.interactive-btn-group` | Row or stack layout |
| Input | `.interactive-input` | Text/email/URL, accent focus border |
| Select | `.interactive-select` | Custom chevron via CSS mask |
| Checkbox | `.interactive-checkbox-*` | Custom box, accent when checked (`#d97853`) |
| Rating | `.interactive-rating-*` | Star buttons, 24px emoji, accent active (`#d97853`) |
| Divider | `.interactive-divider` | 1px border |
| Slider | `.interactive-slider` | Accent thumb (16px circle, `hsl(var(--accent))`) |
| Toggle | `.interactive-toggle-*` | 36×20px pill, slides thumb on check |
| Radio Group | `.interactive-radio-*` | Custom dot fills with accent |
| Number Input | `.interactive-number-*` | Inc/dec buttons flanking center field |
| Date Picker | `.interactive-date` | Native `<input type="date">` styled |
| Table | `.interactive-table` | Borderless rows, sticky header |
| Tabs | `.interactive-tabs` | Bottom-border active tab in accent |
| Image | `.interactive-image` | Constrained to container width |
| Chart Embed | `.interactive-chart-embed` | Recharts inside interactive artifact |

### States

- **Loading:** `opacity: 0.7 + pointer-events: none` on `.interactive-area--loading`
- **Disabled (one-shot fired):** `opacity: 0.55 + pointer-events: none` on `.interactive-area--disabled`
- **Skeleton (streaming):** 120px height, `skeleton-pulse` shimmer animation

### Checked/Active Color

Interactive form controls use `#d97853` (hex equivalent of the brand accent) when checked/selected:
- Checkbox fill: `#d97853`
- Rating active star: `#d97853`
- Rating hover: `#d97853` scale(1.15)

---

## 11. Sidebar Panel

### Layout

The sidebar slides in from the **right** edge. It is portaled to `document.body` (z-index 200), backed by a blurred backdrop (z-index 199).

```
width:     80vw (min: min(600px, 100vw), max: 95vw)
height:    100vh / 100dvh
transform: translateX(100%) → translateX(0) via CSS transition on .open class
transition: 0.3s ease   ← this is a CSS transition, NOT a keyframe animation
```

Mobile (`max-width: 768px`): full width, no left border.

### Header

- 52px minimum height
- Left: type badge (32×32px, 6px radius) + title (14px/600)
- Right: action buttons (28×28px) + close button (32×32px)
- Bottom border: `hsl(var(--text) / 10%)`

### Content Modes

| Mode | Class | Content |
|---|---|---|
| `iframe` | `.sidebar-panel-iframe` | External URL embed (Google Docs, Figma, etc.) |
| `artifact` | `.sidebar-panel-artifact` | Scrollable artifact content via `FullArtifactRenderer` (16px padding) |
| `file` | `.sidebar-panel-file` | File-specific renderer (see below) |

### File Renderers

| File type | Renderer |
|---|---|
| PDF | `<object>` embed with fallback download link |
| Image | Centered, max-width constrained |
| HTML | iframe with white background |
| Audio/Video | Native `<audio>`/`<video>` with label |
| CSV | Scrollable table (`.csv-table`) |
| Code/text | Syntax-highlighted `<pre>` (Monaco font, 13px) |

### CSV Table

Rendered in sidebar with sticky header row:
- Header: `hsl(var(--text) / 5%)` background, 600 weight
- Cells: 6px × 12px padding, `1px solid hsl(var(--text) / 12%)` borders
- Row hover: `hsl(var(--text) / 3%)` background

---

## 12. Dialogs & Modals

### Base Dialog Pattern

All dialogs follow a consistent structure:

```
┌────────────────────────────┐
│ [Title]           [× Close]│  ← Dialog header, border-bottom
├────────────────────────────┤
│ [Content area]             │  ← Scrollable body
│                            │
├────────────────────────────┤
│ [Cancel] [Primary Action]  │  ← Footer, border-top
└────────────────────────────┘
```

- **Overlay:** `hsl(0 0% 0% / 50%)` + dot-pattern background + blur
- **Panel:** `hsl(var(--bg-center))` (pure white), 12px radius
- **Header padding:** `16px 20px`
- **Body padding:** `16px 20px`
- **Footer padding:** `12px 20px`

### Projects / Agents Dialog

File-tree style left panel (`.projects-tree`) with tree items, section headers (11px uppercase, letter-spacing 0.04em), and status badges.

### Context Menu

Right-click/long-press context menus:
- 8px border-radius
- `context-menu-appear` animation: scale 0.95→1 + fadeIn (0.12s ease-out)
- Items: 14px, 7px 14px padding, hover `hsl(var(--text) / 6%)`
- Danger items: `hsl(0 72% 51%)` color + matching hover bg

### Agent / Skill Config Dialogs

- Labels: 12px, uppercase, letter-spacing 0.04em, `hsl(var(--text) / 50%)`
- Inputs: `border-radius: 6px`, `1px solid hsl(var(--text) / 15%)`
- Trigger pills: `hsl(var(--accent) / 12%)` background, 9px text, 3px radius

---

## 13. Diff Viewer & Worktree

### Diff Viewer

Used inside the sidebar or worktree dialog to show git diffs.

- **Font:** JetBrains Mono / Fira Code / Cascadia Code / Consolas, 12px
- **Line height:** 1.5
- **Line numbers:** 40px wide, right-aligned, `hsl(var(--text) / 30%)`
- **Sign column:** 14px wide, `+`/`-`/` ` signs

#### Diff Line Colors

| Line type | Background | Sign color |
|---|---|---|
| Added `+` | `hsl(142 60% 40% / 10%)` | `hsl(142 60% 40%)` |
| Removed `-` | `hsl(0 70% 55% / 10%)` | `hsl(0 70% 55%)` |
| Context | None | Muted gray |

#### Hunk Header Buttons

| Button | Color |
|---|---|
| Stage | `#4ec94e` (bright green) |
| Unstage | `#6ba3f7` (blue) |
| Revert | `#e55050` (red) |

### Worktree Dialog

Sections: **CHANGES**, **STAGED**, **CONFLICTS**. Per-file hover reveals action buttons (`+`, `−`, `↩`) positioned absolutely. Section headers: 11px uppercase, `hsl(var(--text) / 55%)`, letter-spacing 0.04em.

---

## 14. Animation System

### Keyframe Inventory

| Name | Effect | Context |
|---|---|---|
| `clawd-run-in` | Crab runs in from side | Header/logo on load |
| `leg-run1` / `leg-run2` | Header crab leg running cycle | Header crab legs during stream |
| `clawd-leg-run-1` / `clawd-leg-run-2` | Message avatar crab leg cycle | Message avatar crab legs |
| `clawd-avatar-bounce` | Vertical bounce | `.clawd-avatar-streaming .clawd-avatar-svg` |
| `blink` | Eye scaleY(0.15) at 96–99% | Crab eyes, every 10s |
| `sleeping-blink` | Slower, more exaggerated blink (3s) | `.sleeping-clawd .clawd-eye` |
| `heartbeat-zoom` | scale(1.08) + opacity(1) pulse | `.stream-agent-avatar-dot.heartbeat-pulse` (status dot) |
| `avatarCopied` | Brief scale flash | `.message-avatar.copied` on mention-copy |
| `clawdPulse` | Crab scaling pulse | Home page |
| `clawdSlideIn` | Crab slide-in variant | Home page |
| `leg1` / `leg2` | Home-page crab leg cycles | Home page (different from `leg-run1/2`) |
| `copilotSlideIn` | Copilot area entrance | Home page |
| `plusFadeIn` | "+" button appearance | Home page |
| `inputSlideUp` | Input box entrance | Home page |
| `framePulse` | Frame/border pulse | Home page |
| `flash-connection` | Connection status flash | Header connection indicator |
| `spin` | Generic spinner rotation | Loading spinners |
| `spinner-spin` | Sidebar/panel spinner | Sidebar loading states |
| `link-success` | Link copy success flash | Copy-link feedback |
| `sending-pulse` | Thinking banner opacity pulse | `.thinking-banner` |
| `thinking-pulse` | Thinking state indicator | Thinking state |
| `fadeIn` | opacity 0 → 1 | Various overlays |
| `scaleIn` | Scale-in entrance | Various elements |
| `context-menu-appear` | scale(0.95→1) + fade | Context menus |
| `home-dropdown-appear` | Fade + slight translateY | Dropdown menus |
| `artifact-pulse` | Dashed border color pulse | Streaming artifact cards |
| `artifact-spin` | Artifact loading spinner | Artifact loading |
| `artifact-appear` | Artifact card entrance | Artifact card mount |
| `skeleton-pulse` | Shimmer (L→R gradient) | Interactive artifact loading |
| `inline-artifact-skeleton` | Shimmer (L→R gradient) | Inline chart/SVG loading |
| `lazy-pulse` | Opacity pulse (0.4 ↔ 0.7) | Lazy viewport placeholders |
| `highlight-pulse` | Message/content highlight flash | Jump-to-message highlight |
| `plan-fade-in` | Plan mode fade | Plan mode UI |
| `search-pulse` | Search animation | Search overlay |
| `stream-dialog-fade-in` | Stream dialog entrance | Stream dialog |
| `stream-dialog-slide-up` | Stream dialog slide | Stream dialog |

> **Note:** The sidebar panel open/close is a **CSS transition** (`transition: transform 0.3s ease`), NOT a keyframe animation. `translateX(100%)` → `translateX(0)` is driven by the `.open` class toggle.

### Transition Conventions

- **Hover state changes:** `0.1–0.15s`
- **Color transitions:** `0.15s`
- **Sidebar open/close:** `0.3s ease` (CSS transition)
- **Context menu appear:** `0.12s ease-out`

---

## 15. Dark Mode & Responsive

### Dark Mode Status

**Claw'd has full user-toggleable dark mode** via a Moon/Sun button in the composer action toolbar.

**Architecture:**
- `<html data-theme="dark">` — CSS-only theming via attribute selector
- `localStorage["clawd-theme"]` — persists user preference; written only on explicit toggle
- First-visit default: **light** (no OS preference used)
- FOUC prevention: inline `<script>` in `<head>` applies theme before first paint
- Toggle animation: **View Transitions API** (`document.startViewTransition`) — GPU-composited 0.25s cross-fade; falls back to instant switch on unsupported browsers
- Element transitions: 0.2s ease on `background-color`, `color`, `border-color`, `box-shadow`; `prefers-reduced-motion` guard disables all transitions

**Dark palette (`#0d1117` GitHub near-black):**

| Token | Light | Dark |
|---|---|---|
| `--bg` | `48 33.3% 97.1%` | `216 28% 7%` (#0d1117) |
| `--bg-center` | `0 0% 100%` | `215 21% 11%` (#161b22) |
| `--text` | `60 2.6% 7.6%` | `210 17% 88%` |
| `--accent` | `15 63.1% 59.6%` | **unchanged** (coral orange branding) |
| `--text-dim` | `210 10% 45%` | `210 10% 50%` |
| `--border-dim` | `210 10% 82%` | `222 14% 28%` |
| `--bg-dim` | `48 20% 92%` | `222 14% 9%` |
| `--bg-highlight` | `48 33% 90%` | `222 14% 20%` |
| `color-scheme` | `light` | `dark` |

**Avatar inversion in dark mode:**
- `WorkerClawdAvatar` and `BlackClawdIcon`: body `#333` → `#e8e8e8`, eyes `#fff` → `#1a1a1a`
- All coral orange avatars (`ClawdAvatar`, `ClawdLogo`, etc.) — **unchanged** (brand color)

**Out of scope:**
- `<iframe>` document backgrounds (`.html-preview-frame`, `.sidebar-html-iframe` content)
- Artifact iframe sandboxed content
- Custom agent avatar colors

### Responsive Breakpoints

| Breakpoint | Effect |
|---|---|
| `max-width: 768px` | Sidebar panel takes full width; interactive buttons stack; message padding reduced |
| `max-width: 640px` | Artifact modal goes full-viewport (no radius) |

### Mobile-specific

- Sidebar: full width, no left border
- Interactive area: max-width 100%
- Interactive buttons: full width, stacked vertically
- Hover effects: disabled via `@media (hover: hover)` guard on rating stars

---

## 16. Markdown & Code Rendering

### Markdown Pipeline

Messages render via `react-markdown` with these plugins:
- `remark-gfm` — GitHub Flavored Markdown (tables, strikethrough, task lists)
- `remark-math` — LaTeX math syntax
- `rehype-katex` — KaTeX renderer
- `rehype-raw` — Pass raw HTML
- `rehype-sanitize` — Custom sanitize schema (`sanitize-schema.ts`)

A 10,000-character cutoff applies to code block content before Prism rendering.

### Inline Code

```
font-family: Monaco, Menlo, Consolas, "Courier New", monospace
background: #f4f4f4
color: #e01e5a
font-size: 0.875em of parent
padding: 2px 5px
border-radius: 3px
```

### Code Blocks

Code blocks use `<PreBlock>` wrapper (`ui-primitives.ts`):
- Copy button (hidden until hover) in top-right corner
- Syntax highlighting via **Prism.js** (38 languages registered)
- Prism theme: GitHub Light in light mode, GitHub Dark in dark mode

### Recharts

The `chart` artifact type uses Recharts with 6 chart types available. Lazy-loaded (`React.lazy`).

---

## 17. Icons & SVGs

Claw'd does **not** use an icon library (no Lucide, Heroicons, Font Awesome). All icons are:
1. **Inline SVG** — defined as local components in the file that uses them
2. **Shared primitives** — `CopyIcon`, `CheckIcon`, `CloseIcon`, `DownloadIcon`, `AlertIcon` in `ui-primitives.ts`

### Icon Sizing

| Context | Size |
|---|---|
| Action buttons in toolbars | 16×16px |
| Header icons | 18–20px |
| Sidebar action icons | 16px |
| Composer toolbar | 16–18px |
| Small interactive indicators | 14px |
| Rating stars | 24px (font-size emoji) |

---

## 18. Accessibility Primitives

### `.sr-only`

```css
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border: 0;
}
```

### Touch Targets

Interactive rating stars and checkboxes enforce `min-height: 44px` / `min-width: 44px`.

### Focus Management

- Inputs/selects: `hsl(var(--accent) / 60%)` focus border
- Sidebar panel: Escape key closes
- Dialogs: Escape key closes

### Disabled States

All interactive components have explicit `opacity: 0.4–0.5` + `cursor: not-allowed` when disabled. One-shot interactive areas become `pointer-events: none` after submission.

---

## 19. Additional UI Surfaces

### Home Page / Landing Input

When no channel is selected, a home page (`.home-page`) renders with:
- A large composer-style input (`.home-input-wrapper`) with spaces list
- A dropdown (`.home-dropdown`) for quick channel/space navigation — 6px scrollbar
- Animations: `clawdPulse`, `clawdSlideIn`, `plusFadeIn`, `inputSlideUp`, `framePulse`, `leg1`, `leg2`, `copilotSlideIn`

### Stream Dialog / Thinking Banner

When an agent is actively streaming:
- **Thinking banner** (`.thinking-banner`): shown above the message list with a small Claw'd avatar, pulsing with `sending-pulse` animation
- **Stream dialog** (`.stream-dialog`): modal-style overlay for watching long tool operations; uses `stream-dialog-fade-in` + `stream-dialog-slide-up` animations; monospace font ("SF Mono", "Fira Code", etc.)
- **`.thinking-clawd`**: animated claw'd inside the thinking banner, using `thinking-pulse`

### Plan Mode

Plan mode has dedicated UI (`.plan-mode-*`) that fades in via `plan-fade-in`. Used when an agent is in planning/analysis phase.

### Search Overlay

A full-screen search UI (`.search-overlay`) with `search-pulse` animation. Similar to Slack's Cmd+K. Slides in from top.

### Projects Sidebar Tree

The file/project tree (`.projects-sidebar`, `.projects-tree`) uses:
- Tree items with hover highlight and active accent color
- Worktree status indicators
- Section labels at 11px uppercase

---

## Appendix: File Map

```
packages/ui/src/
  App.tsx                          — Root app, WebSocket, channel state
  MessageList.tsx                  — All message rendering logic
  MessageComposer.tsx              — Plain textarea editor, file uploads, mentions
  SidebarPanel.tsx                 — Slide-out right panel (iframe/artifact/file modes)
  artifact-card.tsx                — ArtifactPreviewCard, StreamingArtifactCard
  artifact-types.ts                — TYPE_CONFIG: 8 types with labels/colors/icons
  artifact-renderer.tsx            — FullArtifactRenderer used by sidebar + modal
  artifact-modal.tsx               — Artifact modal dialog component
  artifact-sandbox.tsx             — SandboxedIframe for HTML/React artifacts
  artifact-bridge.ts               — postMessage bridge API between host and artifact iframe
  artifact-templates.ts            — Artifact template utilities
  interactive-renderer.tsx         — Interactive form component renderer (dispatch)
  interactive-components-extended.tsx — Extended interactive component types
  interactive-types.ts             — TypeScript types for interactive component spec
  chart-renderer.tsx               — Recharts wrapper (lazy-loaded)
  file-preview.tsx                 — FilePreviewCard, isPreviewableFile
  MarkdownContent.tsx              — Shared markdown rendering component
  csv-table.tsx                    — CSV table renderer for sidebar
  worktree-diff-viewer.tsx         — Diff viewer (hunk-based, staging actions)
  worktree-file-list.tsx           — Worktree file list with staged/unstaged sections
  ui-primitives.ts                 — Shared icons, PreBlock copy wrapper
  sanitize-schema.ts               — rehype-sanitize custom schema
  prism-setup.ts                   — Prism language registration (38 languages)
  lazy-viewport.tsx                — Viewport-aware lazy rendering (200px pre-load)
  UnreadSeparator.tsx              — "NEW MESSAGES" separator component
  styles.css                       — All CSS (8,929 lines, single file)
```

---

*Last updated: 2026-03-31. Verified by 3 independent review agents (reviewer-1-colors-typography, reviewer-2-components, reviewer-3-layout-misc) against `packages/ui/src/styles.css` (8,929 lines) and all UI component source files.*
