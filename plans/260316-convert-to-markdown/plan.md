---
title: "Native convert_to_markdown Agent Tool"
description: "Replace Python markitdown dependency with pure TypeScript document converters for PDF, DOCX, XLSX, PPTX, HTML, EPUB, RTF, CSV, JSON, XML, YAML"
status: pending
priority: P1
effort: 10h
branch: main
tags: [agent-tools, document-conversion, typescript]
created: 2026-03-16
---

# Native `convert_to_markdown` Agent Tool

## Context

Currently `convert_to_markdown` exists only as an MCP tool in `src/server/mcp.ts` (lines 1367-1399, 2897-2991). It shells out to Python's `markitdown` CLI -- violating Claw'd's "single binary, zero Python" principle. The tool also only works via the MCP/chat-plugin path (file_id based), not as a core agent tool in `src/agent/src/tools/tools.ts`.

**Goal:** Build a pure TypeScript converter module and register it as a first-class agent tool alongside `view`, `bash`, `grep`, etc. Remove the Python dependency.

## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Dependencies + Module Scaffold](#phase-1) | pending | 1h |
| 2 | [Core Converters (PDF, DOCX, XLSX)](#phase-2) | pending | 3h |
| 3 | [Additional Converters (PPTX, HTML, EPUB, RTF)](#phase-3) | pending | 2.5h |
| 4 | [Text Formats (CSV, JSON, XML, YAML)](#phase-4) | pending | 1h |
| 5 | [Tool Registration + Integration](#phase-5) | pending | 1.5h |
| 6 | [Testing + Edge Cases](#phase-6) | pending | 1h |

---

## Phase 1: Dependencies + Module Scaffold {#phase-1}

### Overview
Install npm packages and create the converter module structure.

### Files to Create
- `src/agent/src/tools/document-converter/index.ts` -- main entry point + dispatcher
- `src/agent/src/tools/document-converter/types.ts` -- shared types

### Files to Modify
- `package.json` -- add dependencies

### Implementation Steps

1. **Add dependencies to root `package.json`:**
   ```bash
   bun add pdfjs-dist mammoth xlsx turndown jszip fast-xml-parser js-yaml
   ```
   - `pdfjs-dist` ~4MB -- Mozilla PDF.js, WASM-based text extraction
   - `mammoth` ~200KB -- DOCX to HTML (pure JS)
   - `xlsx` ~1.5MB -- SheetJS spreadsheet parser
   - `turndown` ~50KB -- HTML to markdown
   - `jszip` ~100KB -- ZIP reading (for PPTX, EPUB)
   - `fast-xml-parser` ~100KB -- XML parsing
   - `js-yaml` ~50KB -- YAML parsing

   **NOT adding:** `tesseract.js` (OCR is out of scope per requirements -- use `read_image` tool for images), `node-pptx-parser` (manual ZIP+XML is simpler and has no deps), `papaparse`/`csv-parse` (CSV parsing is trivial with built-in split).

2. **Add type declarations** (if needed):
   ```bash
   bun add -d @types/turndown
   ```
   Note: `mammoth`, `xlsx`, `jszip`, `fast-xml-parser` ship their own types. `pdfjs-dist` ships types. Check if `@types/js-yaml` is needed.

3. **Create `types.ts`:**
   ```typescript
   export interface ConversionResult {
     success: boolean;
     markdown: string;
     format: string;
     metadata?: Record<string, unknown>;
     truncated?: boolean;
     error?: string;
   }
   ```

4. **Create `index.ts` scaffold:**
   ```typescript
   export async function convertToMarkdown(
     filePath: string,
     maxLength: number = 50000
   ): Promise<ConversionResult>
   ```
   - Auto-detect format from file extension
   - Switch/dispatch to format-specific converter
   - Apply maxLength truncation to final output
   - Wrap all errors gracefully

### Success Criteria
- `bun install` succeeds with new deps
- Module compiles without errors
- Dispatcher returns "unsupported format" for unknown extensions

### Risks
- `pdfjs-dist` WASM may need special handling in Bun (test early)
- `xlsx` is large; verify it doesn't break `bun build --compile`
- SheetJS license (Apache 2.0 community edition) -- verify compatibility

---

## Phase 2: Core Converters (PDF, DOCX, XLSX) {#phase-2}

### Overview
Implement the three most-requested document converters.

### Files to Create
- `src/agent/src/tools/document-converter/pdf-converter.ts`
- `src/agent/src/tools/document-converter/docx-converter.ts`
- `src/agent/src/tools/document-converter/xlsx-converter.ts`

### Implementation Steps

#### 2a. PDF Converter (`pdf-converter.ts`)
```typescript
import { getDocument } from "pdfjs-dist";

export async function convertPdf(filePath: string): Promise<ConversionResult> {
  const data = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  const doc = await getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(" ");
    pages.push(`## Page ${i}\n\n${text}`);
  }
  return { success: true, markdown: pages.join("\n\n"), format: "pdf",
    metadata: { pages: doc.numPages } };
}
```

**Key considerations:**
- pdfjs-dist worker: Disable worker threads (`workerSrc` not needed for server-side)
- Set `disableFontFace: true`, `useSystemFonts: false` for sandbox compatibility
- WASM file location: pdfjs-dist includes `pdf.worker.min.mjs` -- may need to copy to build output or set `GlobalWorkerOptions.workerSrc`
- For Bun: use `getDocument({ data, useWorkerFetch: false, isEvalSupported: false })` to avoid worker/eval issues

#### 2b. DOCX Converter (`docx-converter.ts`)
```typescript
import mammoth from "mammoth";
import TurndownService from "turndown";

export async function convertDocx(filePath: string): Promise<ConversionResult> {
  const buffer = await Bun.file(filePath).arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const turndown = new TurndownService({ headingStyle: "atx" });
  const markdown = turndown.turndown(html);
  return { success: true, markdown, format: "docx" };
}
```

**Key considerations:**
- mammoth outputs clean HTML with headings, lists, tables
- turndown converts HTML to markdown (reuse for Phase 3 HTML converter)
- mammoth supports `styleMap` for custom style-to-markdown mappings if needed later

#### 2c. XLSX Converter (`xlsx-converter.ts`)
```typescript
import * as XLSX from "xlsx";

export async function convertXlsx(filePath: string): Promise<ConversionResult> {
  const data = await Bun.file(filePath).arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const sheets: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (rows.length === 0) continue;
    // Build markdown table
    const header = rows[0].map(String);
    const separator = header.map(() => "---");
    const body = rows.slice(1).map(row => row.map(c => String(c ?? "")));
    const table = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map(row => `| ${row.join(" | ")} |`)
    ].join("\n");
    sheets.push(`### Sheet: ${name}\n\n${table}`);
  }
  return { success: true, markdown: sheets.join("\n\n"), format: "xlsx" };
}
```

**Key considerations:**
- SheetJS community edition (`xlsx` on npm) is Apache 2.0
- Handle multiple sheets, empty sheets, very wide tables
- Cap rows at ~500 per sheet to prevent token explosion (configurable via maxLength)

### Success Criteria
- PDF with 5+ pages converts correctly, text extracted from each page
- DOCX with headings, lists, tables converts to clean markdown
- XLSX with multiple sheets produces valid markdown tables
- All converters handle empty/corrupt files gracefully (return error, no crash)

### Risks
- pdfjs-dist WASM in Bun: may need `--conditions=node` or explicit WASM import
- pdfjs-dist in bwrap sandbox: WASM needs `/proc` access sometimes -- test in sandbox mode
- XLSX large files: SheetJS loads entire file in memory -- enforce file size check (e.g., 50MB limit)

---

## Phase 3: Additional Converters (PPTX, HTML, EPUB, RTF) {#phase-3}

### Overview
Implement converters for presentation, web, ebook, and rich text formats.

### Files to Create
- `src/agent/src/tools/document-converter/pptx-converter.ts`
- `src/agent/src/tools/document-converter/html-converter.ts`
- `src/agent/src/tools/document-converter/epub-converter.ts`
- `src/agent/src/tools/document-converter/rtf-converter.ts`

### Implementation Steps

#### 3a. PPTX Converter (`pptx-converter.ts`)
Manual ZIP+XML approach using jszip + fast-xml-parser.

```typescript
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export async function convertPptx(filePath: string): Promise<ConversionResult> {
  const data = await Bun.file(filePath).arrayBuffer();
  const zip = await JSZip.loadAsync(data);
  const parser = new XMLParser({ ignoreAttributes: false });
  const slides: string[] = [];
  // Iterate ppt/slides/slide{N}.xml in order
  const slideFiles = Object.keys(zip.files)
    .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
      return numA - numB;
    });
  for (const slideFile of slideFiles) {
    const xml = await zip.files[slideFile].async("text");
    const parsed = parser.parse(xml);
    // Extract text from <a:t> tags recursively
    const texts = extractTexts(parsed);
    const num = slideFile.match(/slide(\d+)/)?.[1];
    slides.push(`## Slide ${num}\n\n${texts.join("\n")}`);
  }
  return { success: true, markdown: slides.join("\n\n"), format: "pptx" };
}

function extractTexts(obj: any): string[] { /* recursive walk for a:t values */ }
```

**Key considerations:**
- PPTX is a ZIP containing XML files
- Text lives in `<a:t>` elements inside `<p:sp>` (shape) elements
- Also extract from `ppt/notesSlides/` if present (speaker notes)
- Handle missing slides gracefully

#### 3b. HTML Converter (`html-converter.ts`)
```typescript
import TurndownService from "turndown";

export async function convertHtml(filePath: string): Promise<ConversionResult> {
  const html = await Bun.file(filePath).text();
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const markdown = turndown.turndown(html);
  return { success: true, markdown, format: "html" };
}
```

Simple wrapper around turndown. Consider stripping `<script>`, `<style>` tags before conversion.

#### 3c. EPUB Converter (`epub-converter.ts`)
EPUB is a ZIP with XHTML chapters.

```typescript
import JSZip from "jszip";
import TurndownService from "turndown";

export async function convertEpub(filePath: string): Promise<ConversionResult> {
  const data = await Bun.file(filePath).arrayBuffer();
  const zip = await JSZip.loadAsync(data);
  // Parse container.xml to find content.opf
  // Parse content.opf to get spine (reading order)
  // For each spine item, extract XHTML and convert to markdown
  const turndown = new TurndownService({ headingStyle: "atx" });
  // ... extract chapters in spine order
  return { success: true, markdown: chapters.join("\n\n---\n\n"), format: "epub" };
}
```

**Key considerations:**
- Follow EPUB spec: container.xml -> content.opf -> spine -> manifest items
- Only extract text/xhtml items (skip images, CSS, fonts)
- Preserve chapter ordering from spine

#### 3d. RTF Converter (`rtf-converter.ts`)
Basic regex parser -- RTF is mostly `{\rtf1 ... }` with control words.

```typescript
export async function convertRtf(filePath: string): Promise<ConversionResult> {
  const rtf = await Bun.file(filePath).text();
  // Strip RTF control groups and extract text
  let text = rtf
    .replace(/\{\\[^}]*\}/g, "")      // Remove control groups
    .replace(/\\[a-z]+\d* ?/gi, "")   // Remove control words
    .replace(/[{}]/g, "")              // Remove remaining braces
    .replace(/\\\'/([0-9a-f]{2})/gi,  // Convert hex escapes
      (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
  return { success: true, markdown: text, format: "rtf" };
}
```

**Key considerations:**
- RTF parsing is lossy with regex -- this handles 80% of common RTF files
- Won't preserve formatting (bold, italic, tables) -- acceptable for text extraction
- Complex RTF (nested tables, images) will have artifacts

### Success Criteria
- PPTX extracts text from all slides in order
- HTML converts to clean markdown preserving structure
- EPUB extracts chapters in reading order
- RTF extracts readable text (formatting loss is acceptable)
- All handle empty/corrupt/password-protected files gracefully

### Risks
- PPTX XML structure varies by PowerPoint version -- test with multiple PPTX sources
- EPUB container.xml parsing -- edge cases with non-standard EPUBs
- RTF regex approach may fail on complex documents -- acceptable tradeoff

---

## Phase 4: Text Formats (CSV, JSON, XML, YAML) {#phase-4}

### Overview
Implement converters for structured text formats using built-ins + fast-xml-parser + js-yaml.

### Files to Create
- `src/agent/src/tools/document-converter/text-converters.ts` -- all text formats in one file (each is <30 lines)

### Implementation Steps

All in one file since each converter is trivial:

```typescript
// CSV -> markdown table
export async function convertCsv(filePath: string): Promise<ConversionResult> {
  const text = await Bun.file(filePath).text();
  const lines = text.trim().split("\n");
  if (lines.length === 0) return { success: true, markdown: "(empty file)", format: "csv" };
  // Simple CSV parse (handles quoted fields)
  const rows = lines.map(line => parseCSVLine(line));
  // Build markdown table from rows[0] as header
  // ...
}

// JSON -> fenced code block
export async function convertJson(filePath: string): Promise<ConversionResult> {
  const text = await Bun.file(filePath).text();
  const parsed = JSON.parse(text);
  const formatted = JSON.stringify(parsed, null, 2);
  return { success: true, markdown: "```json\n" + formatted + "\n```", format: "json" };
}

// XML -> fenced code block (or structured extraction)
export async function convertXml(filePath: string): Promise<ConversionResult> {
  const text = await Bun.file(filePath).text();
  // Option A: return as code block
  return { success: true, markdown: "```xml\n" + text + "\n```", format: "xml" };
  // Option B: parse and extract text content (if primarily text XML like RSS/Atom)
}

// YAML -> fenced code block
export async function convertYaml(filePath: string): Promise<ConversionResult> {
  const text = await Bun.file(filePath).text();
  // Validate it's valid YAML
  const yaml = await import("js-yaml");
  yaml.load(text); // throws on invalid
  return { success: true, markdown: "```yaml\n" + text + "\n```", format: "yaml" };
}
```

**CSV parsing note:** Implement a simple `parseCSVLine()` that handles quoted fields with commas. No need for a full CSV library -- the built-in approach handles 95% of real CSV files.

### Success Criteria
- CSV with headers produces valid markdown table
- JSON is pretty-printed in fenced code block
- XML returned as code block (or text extracted for RSS/Atom feeds)
- YAML validated and returned as code block
- Invalid files return clear error messages

### Risks
- CSV edge cases: embedded newlines in quoted fields, different delimiters (;, tab)
- Very large JSON/XML files: enforce maxLength truncation

---

## Phase 5: Tool Registration + Integration {#phase-5}

### Overview
Register as core agent tool and update MCP implementation to use the same converter.

### Files to Modify
- `src/agent/src/tools/tools.ts` -- register `convert_to_markdown` tool
- `src/server/mcp.ts` -- replace markitdown shell-out with native converter
- `src/agent/plugins/clawd-chat/agent.ts` -- update tool reference if needed
- `src/agent/workers/clawd-chat/index.ts` -- update system prompt reference

### Implementation Steps

#### 5a. Register in `tools.ts`

Add after the `view` tool (around line 645):

```typescript
import { convertToMarkdown } from "./document-converter";

registerTool(
  "convert_to_markdown",
  `Convert a file to markdown text. Supports: PDF, DOCX, XLSX, PPTX, HTML, EPUB, RTF, CSV, JSON, XML, YAML.

Use this tool to read document files that the view tool cannot handle (binary formats like PDF, DOCX, XLSX, PPTX).
Returns the document content as readable markdown text.

For images, use the read_image tool instead.`,
  {
    path: {
      type: "string",
      description: "Absolute path to the file to convert",
    },
    max_length: {
      type: "number",
      description: "Maximum output length in characters (default: 50000)",
    },
  },
  ["path"],
  async ({ path: filePath, max_length }) => {
    const resolvedPath = resolve(filePath);
    const pathError = validatePath(resolvedPath, "convert_to_markdown");
    if (pathError) return { success: false, output: "", error: pathError };

    if (!existsSync(resolvedPath)) {
      return { success: false, output: "", error: `File not found: ${filePath}` };
    }

    const stat = statSync(resolvedPath);
    if (stat.size > 100 * 1024 * 1024) {
      return { success: false, output: "", error: "File too large (>100MB). Use a smaller file." };
    }

    const result = await convertToMarkdown(resolvedPath, max_length ?? 50000);
    if (!result.success) {
      return { success: false, output: "", error: result.error || "Conversion failed" };
    }

    let output = result.markdown;
    if (result.truncated) {
      output += "\n\n[TRUNCATED -- output exceeded max_length]";
    }
    if (result.metadata) {
      output = `**Format:** ${result.format}${result.metadata.pages ? ` | **Pages:** ${result.metadata.pages}` : ""}\n\n${output}`;
    }
    return { success: true, output };
  },
);
```

#### 5b. Update MCP tool (`src/server/mcp.ts`)

Replace the markitdown shell-out (lines 2910-2988) with:

```typescript
import { convertToMarkdown } from "../agent/src/tools/document-converter";

// In the convert_to_markdown case:
const result = await convertToMarkdown(file.path);
if (!result.success) {
  resultText = JSON.stringify({ ok: false, error: result.error });
} else {
  // ... same save-to-file logic, use result.markdown
}
```

Remove: markitdown binary search, Python PATH setup, Bun.spawn markitdown call.
Update: tool description to remove "Requires: markitdown CLI installed" line.

#### 5c. Update system prompt in `src/agent/workers/clawd-chat/index.ts`

Line 429 references `convert_to_markdown(file_id="F123")`. The agent tool uses `path` not `file_id`. Update the system prompt guidance:

```
- Use convert_to_markdown(path="/path/to/file.pdf") to convert to readable Markdown text
```

The MCP tool still accepts `file_id` (it resolves to a path internally), so both entry points are valid.

### Success Criteria
- `convert_to_markdown` appears in agent tool list
- Agent can call it with a file path and get markdown back
- MCP `convert_to_markdown` still works (now using native converter)
- No Python/markitdown dependency needed
- Sandbox path validation works correctly
- `bun run build` compiles successfully

### Risks
- Import path: `tools.ts` imports from `./document-converter` -- verify Bun resolves this correctly at build time
- Large tools.ts file: already ~3400 lines. Adding ~30 lines for registration is fine; the converter logic is in separate files
- MCP import path: `src/server/mcp.ts` needs to import from `../agent/src/tools/document-converter` -- verify the path is correct

---

## Phase 6: Testing + Edge Cases {#phase-6}

### Overview
Validate all converters work correctly and handle edge cases.

### Files to Create
- `src/agent/src/tools/document-converter/document-converter.test.ts`

### Test Matrix

| Format | Happy Path | Empty File | Corrupt File | Large File | Notes |
|--------|-----------|------------|-------------|------------|-------|
| PDF | Multi-page text | 0-page PDF | Invalid header | 50MB+ | Test scanned-image PDFs (will return empty) |
| DOCX | Headings+lists+tables | Empty doc | Invalid ZIP | 10MB+ | |
| XLSX | Multi-sheet with data | Empty workbook | Invalid ZIP | 1000+ rows | Test formulas (expect calculated values) |
| PPTX | 10+ slides with text | Empty pres | Invalid ZIP | | Test speaker notes |
| HTML | Full page with nav | Empty HTML | Malformed tags | | Test script/style stripping |
| EPUB | Multi-chapter book | Minimal EPUB | Missing spine | | |
| RTF | Formatted text | Empty RTF | Binary file | | |
| CSV | Header + 100 rows | Empty CSV | No header | 10k rows | Test quoted fields with commas |
| JSON | Nested object | `{}` | Invalid JSON | | |
| XML | RSS feed | `<root/>` | Malformed | | |
| YAML | Config file | Empty | Invalid syntax | | |

### Edge Cases to Test
1. **File extension mismatch** -- .txt file that's actually JSON
2. **Password-protected** PDF/DOCX/XLSX -- should return clear error
3. **maxLength truncation** -- verify truncation works and flag is set
4. **Path traversal** -- `../../etc/passwd` blocked by sandbox validation
5. **Binary files** -- .exe, .png etc. return "unsupported format"
6. **Unicode content** -- CJK, Arabic, emoji in documents
7. **Concurrent conversions** -- multiple agents converting simultaneously

### Implementation Steps
1. Create test fixtures directory with sample files (or generate them programmatically)
2. Write tests using `bun:test`
3. Test each converter in isolation
4. Test the dispatcher (format detection, error routing)
5. Test tool registration (mock tool call)
6. Run `bun run build` to verify compilation

### Success Criteria
- All tests pass
- No crashes on corrupt/empty files
- maxLength truncation works correctly
- `bun run build` produces working binary
- Sandbox restrictions enforced

---

## Architecture Summary

```
src/agent/src/tools/
├── tools.ts                          # registers convert_to_markdown (handler)
├── plugin.ts                         # existing plugin system
└── document-converter/
    ├── index.ts                      # convertToMarkdown() dispatcher
    ├── types.ts                      # ConversionResult interface
    ├── pdf-converter.ts              # pdfjs-dist
    ├── docx-converter.ts             # mammoth + turndown
    ├── xlsx-converter.ts             # SheetJS
    ├── pptx-converter.ts             # jszip + fast-xml-parser
    ├── html-converter.ts             # turndown
    ├── epub-converter.ts             # jszip + turndown
    ├── rtf-converter.ts              # regex parser
    ├── text-converters.ts            # CSV, JSON, XML, YAML
    └── document-converter.test.ts    # tests
```

## Dependencies Added

| Package | Size | Purpose | License |
|---------|------|---------|---------|
| pdfjs-dist | ~4MB | PDF text extraction | Apache 2.0 |
| mammoth | ~200KB | DOCX to HTML | BSD-2 |
| xlsx | ~1.5MB | Spreadsheet parsing | Apache 2.0 |
| turndown | ~50KB | HTML to markdown | MIT |
| jszip | ~100KB | ZIP reading | MIT/GPLv3 dual |
| fast-xml-parser | ~100KB | XML parsing | MIT |
| js-yaml | ~50KB | YAML parsing | MIT |

**Total:** ~6MB added to node_modules. Acceptable given current binary is 50MB+.

**Not added:**
- `tesseract.js` -- OCR is separate concern, use `read_image` tool
- `node-pptx-parser` -- manual ZIP+XML is simpler, fewer deps
- `papaparse` / `csv-parse` -- CSV parsing is trivial built-in
- `@types/turndown` -- only if TS compilation requires it

## Integration Points

1. **Agent tool** (`tools.ts`) -- direct file path access, runs in sandbox
2. **MCP tool** (`mcp.ts`) -- file_id lookup -> resolve path -> call same converter
3. **Output compressor** (`output-compressor.ts`) -- already has 20480 char limit for convert_to_markdown (line 19)
4. **Chat plugin** (`clawd-chat/agent.ts`) -- auto-injects project_root for MCP path

## Unresolved Questions

1. **pdfjs-dist in Bun compiled binary** -- Does the WASM load correctly? Need to test early in Phase 2. If it fails, fallback option: use `Bun.spawn(["pdftotext", ...])` if poppler-utils is installed, with pdfjs-dist as secondary.
2. **SheetJS in `bun build --compile`** -- SheetJS uses dynamic requires internally. May need `--external xlsx` flag or a shim. Test during Phase 2.
3. **jszip license** -- Dual MIT/GPLv3. Using under MIT is fine for Apache/MIT projects, but verify no GPLv3 copyleft triggers.
4. **Scanned PDFs** -- pdfjs-dist extracts text layers only. Scanned PDFs with no text layer will return empty. This is acceptable -- document in tool description. Future: add OCR capability via vision model.
5. **Should the MCP tool keep the file_id interface?** -- Yes, for backward compatibility. It resolves file_id to path, then calls the same converter. Both entry points (path for agent tool, file_id for MCP) use the same underlying code.
