# Phase 2: Syntax Highlighting (P1)

## Context Links
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — PreBlock component (line 215), MARKDOWN_COMPONENTS (line 547)
- [package.json](../../packages/ui/package.json) — prismjs v1.30 + @types/prismjs already installed
- [styles.css](../../packages/ui/src/styles.css) — `.code-block-wrapper` styles (line 1651)

## Overview
- **Priority:** P1 — independent of other phases
- **Status:** Complete
- **Description:** Activate syntax highlighting for all code blocks. Prismjs is already installed but unused. Evaluate Prism vs Shiki; recommend Prism since it's already a dependency.

## Key Insights
- Prismjs v1.30 and @types/prismjs are in `packages/ui/package.json` but never imported
- Code blocks currently render as plain `<code className="language-xxx">` with no highlighting
- `PreBlock` component (line 215) handles copy-to-clipboard and language label — highlighting integrates here
- `MARKDOWN_COMPONENTS.code` (line 549-554) creates code elements — this is where Prism.highlight() should run
- Shiki would require replacing Prism entirely (~200KB vs Prism's ~30KB with languages). Not worth it — Prism is already installed and sufficient.

## Requirements

### Functional
- Syntax highlighting for 30+ languages in all code blocks
- Language auto-detection fallback when no language specified
- Dark and light theme support matching existing UI theme
- Highlight applied in both MessageList and MarkdownContent renderers

### Non-Functional
- Prism core + 30 languages < 50KB gzipped
- No flash of unstyled code (highlight runs synchronously on render)
- No impact on streaming performance — Prism.highlight is fast for typical code blocks

## Architecture

```
code block with className="language-python"
  |
  v
MARKDOWN_COMPONENTS.code handler
  |
  v
Prism.highlight(code, grammar, lang) ──> highlighted HTML string
  |
  v
<code dangerouslySetInnerHTML={highlighted} />
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/MessageList.tsx` | Import Prism + languages; update MARKDOWN_COMPONENTS.code (line 549-554); update PreBlock language label |
| `packages/ui/src/MarkdownContent.tsx` | Update code component to use Prism (line 21-29) |
| `packages/ui/src/styles.css` | Add Prism token styles for dark/light themes |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/prism-setup.ts` | Central Prism import with language registrations |

## Implementation Steps

### Step 1: Create prism-setup.ts (~40 lines)

```typescript
// packages/ui/src/prism-setup.ts
import Prism from "prismjs";

// Core languages (auto-included): markup, css, clike, javascript

// Import additional languages — order matters for dependencies
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-shell-session";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-nginx";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-git";
import "prismjs/components/prism-regex";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-elixir";
import "prismjs/components/prism-hcl";

// Language aliases
Prism.languages.sh = Prism.languages.bash;
Prism.languages.zsh = Prism.languages.bash;
Prism.languages.ts = Prism.languages.typescript;
Prism.languages.js = Prism.languages.javascript;
Prism.languages.py = Prism.languages.python;
Prism.languages.rb = Prism.languages.ruby;
Prism.languages.yml = Prism.languages.yaml;
Prism.languages.dockerfile = Prism.languages.docker;
Prism.languages.tf = Prism.languages.hcl;
Prism.languages.terraform = Prism.languages.hcl;

export { Prism };

/**
 * Highlight code string. Returns HTML string or null if language unknown.
 */
export function highlightCode(code: string, lang: string): string | null {
  const grammar = Prism.languages[lang.toLowerCase()];
  if (!grammar) return null;
  return Prism.highlight(code, grammar, lang.toLowerCase());
}
```

### Step 2: Update MARKDOWN_COMPONENTS.code in MessageList.tsx

Replace lines 549-554:
```typescript
// Before:
code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidDiagram chart={code} />;
  return <code className={className}>{children}</code>;
},

// After:
code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidDiagram chart={code} />;
  const highlighted = lang ? highlightCode(code, lang) : null;
  if (highlighted) {
    return (
      <code
        className={className}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  }
  return <code className={className}>{children}</code>;
},
```

Add import at top of file:
```typescript
import { highlightCode } from "./prism-setup";
```

### Step 3: Update MarkdownContent.tsx identically

Same pattern — import `highlightCode` and update the code component handler.

### Step 4: Add Prism token styles to styles.css

Add at end of styles.css (~100 lines). Use CSS custom properties for dark/light theming:

```css
/* ── Syntax highlighting tokens ─────────────────────────────────── */
/* Light theme (default) */
:root {
  --prism-comment: #6a737d;
  --prism-keyword: #d73a49;
  --prism-string: #032f62;
  --prism-function: #6f42c1;
  --prism-number: #005cc5;
  --prism-operator: #d73a49;
  --prism-class: #6f42c1;
  --prism-punctuation: #24292e;
  --prism-property: #005cc5;
  --prism-tag: #22863a;
  --prism-attr-name: #6f42c1;
  --prism-attr-value: #032f62;
  --prism-builtin: #e36209;
  --prism-inserted: #22863a;
  --prism-deleted: #b31d28;
  --prism-changed: #e36209;
}

/* Dark theme */
@media (prefers-color-scheme: dark) {
  :root {
    --prism-comment: #8b949e;
    --prism-keyword: #ff7b72;
    --prism-string: #a5d6ff;
    --prism-function: #d2a8ff;
    --prism-number: #79c0ff;
    --prism-operator: #ff7b72;
    --prism-class: #f0883e;
    --prism-punctuation: #c9d1d9;
    --prism-property: #79c0ff;
    --prism-tag: #7ee787;
    --prism-attr-name: #d2a8ff;
    --prism-attr-value: #a5d6ff;
    --prism-builtin: #ffa657;
    --prism-inserted: #aff5b4;
    --prism-deleted: #ffa198;
    --prism-changed: #ffa657;
  }
}

.token.comment, .token.prolog, .token.doctype, .token.cdata { color: var(--prism-comment); font-style: italic; }
.token.keyword, .token.control, .token.directive { color: var(--prism-keyword); }
.token.string, .token.char, .token.template-string, .token.url { color: var(--prism-string); }
.token.function { color: var(--prism-function); }
.token.number, .token.boolean { color: var(--prism-number); }
.token.operator, .token.entity { color: var(--prism-operator); }
.token.class-name, .token.maybe-class-name { color: var(--prism-class); }
.token.punctuation { color: var(--prism-punctuation); }
.token.property, .token.constant, .token.variable { color: var(--prism-property); }
.token.tag { color: var(--prism-tag); }
.token.attr-name { color: var(--prism-attr-name); }
.token.attr-value { color: var(--prism-attr-value); }
.token.builtin, .token.symbol { color: var(--prism-builtin); }
.token.inserted { color: var(--prism-inserted); }
.token.deleted { color: var(--prism-deleted); }
.token.changed { color: var(--prism-changed); }
.token.important, .token.bold { font-weight: bold; }
.token.italic { font-style: italic; }
```

**Note:** Do NOT import Prism's built-in CSS themes — they conflict with the app's dark/light mode. Custom token styles using CSS variables ensure theme consistency.

### Step 5: Verify build

```bash
cd packages/ui && bun run build
```

## Todo List

- [x] Create `prism-setup.ts` with language imports and aliases
- [x] Import `highlightCode` in MessageList.tsx
- [x] Update `MARKDOWN_COMPONENTS.code` to use Prism highlighting
- [x] Update MarkdownContent.tsx code handler identically
- [x] Add Prism token CSS variables for light/dark themes
- [x] Add Prism token style rules to styles.css
- [ ] Test: Python, TypeScript, Bash, JSON, YAML code blocks are highlighted
- [ ] Test: Unknown languages fall back to plain text (no crash)
- [ ] Test: Mermaid blocks still route to MermaidDiagram (not highlighted)
- [ ] Test: Copy-to-clipboard in PreBlock still works with highlighted code
- [ ] Test: Dark mode token colors are readable
- [x] Run `bun run build:ui` to verify no compile errors

## Success Criteria
- Code blocks with recognized languages show syntax-colored tokens
- Unknown languages render as plain monospace (no error)
- Mermaid code blocks still render as diagrams
- Copy button copies plain text (not HTML markup)
- Light and dark themes both have readable token colors
- Build passes

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `dangerouslySetInnerHTML` for highlighted code is XSS vector | Low | High | Prism.highlight escapes HTML entities before tokenizing; input is already from code blocks (not arbitrary HTML). Phase 1 sanitization also applies to surrounding context. |
| Prism language imports bloat bundle | Low | Low | ~30KB gzipped for 30 languages — acceptable. Tree-shaking not possible with side-effect imports, but Vite handles chunking. |
| Copy-to-clipboard copies HTML tags instead of plain text | Medium | Medium | PreBlock already uses `textContent` for copy — `dangerouslySetInnerHTML` renders span tags, and `textContent` strips them correctly. |

## Security Considerations
- `dangerouslySetInnerHTML` is safe here because Prism.highlight() escapes all HTML entities in the source code before wrapping tokens in `<span>` tags.
- The code string comes from fenced code blocks, already isolated by parseMessageBlocks().

## Next Steps
- This phase is independent. Can be implemented in parallel with Phase 1.
- Phase 3 (Artifact Detection) will reuse `highlightCode` for code-type artifacts.
