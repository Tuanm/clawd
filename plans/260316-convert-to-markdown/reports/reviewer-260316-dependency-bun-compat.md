# Dependency & Bun Compatibility Review

**Date:** 2026-03-16
**Scope:** Plan file `plans/260316-convert-to-markdown/plan.md` -- dependency choices, Bun runtime/compile compatibility, bundle size, licenses, integration points.
**Action:** Report only, no edits.

---

## Overall Assessment

The plan is well-structured with good risk awareness. However, there are **two critical compatibility risks** (pdfjs-dist WASM, turndown DOM) and **one high-priority alternative** (unpdf) that should be evaluated before implementation begins.

---

## 1. pdfjs-dist -- CRITICAL RISK

**Verdict:** High risk for `bun build --compile`. Recommend replacing with `unpdf`.

**Issues found:**
- pdfjs-dist v5 introduced separate WASM files (`qcms_bg.wasm`, `openjpeg.wasm`) that must be located at runtime. In a single-binary build, these files are not available on disk.
- Worker threads (`pdf.worker.min.mjs`) need explicit disabling. The plan mentions this but the WASM file issue is separate and harder to work around.
- pdfjs-dist is ~4MB -- the heaviest single dependency.
- The plan's own "Unresolved Question #1" acknowledges this risk but defers testing to Phase 2. This should be resolved *before* committing to the dependency.

**Recommendation:** Use [`unpdf`](https://github.com/unjs/unpdf) instead.
- Built by UnJS specifically for serverless/edge/Bun environments.
- Ships a pre-bundled serverless build of PDF.js with worker inlined and WASM polyfilled.
- Explicitly supports Bun.
- Zero external dependencies (PDF.js is bundled internally).
- API: `import { extractText } from 'unpdf'` -- simpler than raw pdfjs-dist.
- Lighter footprint since the serverless build strips rendering code.

**Fallback:** If unpdf proves insufficient, the plan's own fallback (`Bun.spawn(["pdftotext", ...])`) is viable but violates the "single binary, zero external tools" principle.

---

## 2. mammoth -- LOW RISK

**Verdict:** Should work fine in Bun.

- Pure JavaScript, relies on `node:fs`, `Buffer`, and `jszip` (which it bundles internally).
- Bun implements `node:fs` and `Buffer` natively.
- No WASM, no native addons, no worker threads.
- ~200KB -- acceptable size.
- License: BSD-2-Clause -- fully compatible.

**One concern:** mammoth bundles its own jszip internally. If the plan also adds jszip as a direct dependency (for PPTX/EPUB), there will be two copies of jszip in the bundle. Not a blocker but adds ~100KB redundancy.

---

## 3. xlsx (SheetJS) -- MEDIUM RISK

**Verdict:** Works in Bun but requires CommonJS import pattern.

**Issues found:**
- SheetJS official docs have a [dedicated Bun SEA page](https://docs.sheetjs.com/docs/demos/cli/bunsea/) confirming `bun build --compile` support, but they **strongly recommend CommonJS `require()` over ESM `import`**. The plan uses ESM: `import * as XLSX from "xlsx"` -- this may cause the native Node.js modules to not load.
- SheetJS uses dynamic `require()` calls internally for codepage support. With `bun build --compile` and ESM imports, these dynamic requires may fail silently, causing charset issues with non-UTF8 spreadsheets.
- ~1.5MB is significant but acceptable given the 108MB binary baseline.

**Recommendation:** Use `const XLSX = require("xlsx")` or test ESM import thoroughly. Alternatively, if only basic .xlsx reading is needed, consider `xlsx-parse-json` or similar lighter libs. But SheetJS is the most battle-tested option.

**License:** Apache 2.0 (community edition) -- compatible. Note: the "Pro" edition has a commercial license, but npm `xlsx` is the community edition.

---

## 4. turndown -- HIGH RISK

**Verdict:** Requires a DOM implementation. Will NOT work server-side in Bun without one.

**Issues found:**
- turndown operates on a DOM tree. When you pass an HTML string, it internally calls `document.createElement()` to parse it. In a browser this works. In Node.js/Bun there is no `document` global.
- The plan shows `turndown.turndown(html)` with a raw string -- this will throw `ReferenceError: document is not defined` at runtime.
- turndown is used by 3 converters (DOCX via mammoth, HTML, EPUB), making this a cross-cutting issue.

**Recommendations (pick one):**
1. **Add `linkedom` (~40KB)** as a lightweight DOM shim. Before calling turndown, parse HTML with linkedom and pass the DOM node. Lighter and faster than jsdom.
2. **Replace turndown with `node-html-markdown`** (~113KB, zero DOM dependency). It uses a streaming HTML tokenizer instead of DOM parsing. Faster, no DOM shim needed. Drop-in replacement for the HTML-to-markdown use case.
3. **Use `@joplin/turndown`** (fork) which may handle string input better, but still likely needs DOM.

**Strongest recommendation:** Option 2 (`node-html-markdown`). Eliminates the DOM dependency entirely, smaller total footprint, and avoids a class of Bun compatibility issues.

---

## 5. jszip -- LOW RISK

**Verdict:** Works in Bun. License is fine.

- Pure JavaScript, widely used, no native deps.
- ~100KB -- negligible.
- **License:** Dual MIT/GPLv3. User can choose MIT. This is standard dual-licensing -- choosing MIT means no copyleft obligation. The plan's "Unresolved Question #3" is already answered: use under MIT.

**Note:** mammoth bundles its own jszip. Consider whether you need jszip as a direct dependency or can extract mammoth's internal jszip for PPTX/EPUB use. Probably not worth the coupling -- keep them separate.

---

## 6. fast-xml-parser -- LOW RISK

**Verdict:** Works in Bun. No issues.

- Pure JavaScript, no native deps, no WASM.
- ~100KB.
- License: MIT -- compatible.
- Well-maintained, widely used.

---

## 7. js-yaml -- LOW RISK (but unnecessary)

**Verdict:** Works fine, but consider dropping it.

- Pure JavaScript, ~50KB, MIT license.
- **However:** The plan's YAML converter just validates and returns the raw text in a code fence. `yaml.load(text)` is used only for validation. Bun has no built-in YAML parser, but you could skip validation entirely (just return the text) or use a simpler check. Not worth a dependency for validation-only use.

**Recommendation:** Drop `js-yaml`. Return YAML files as code blocks without validation (same as the XML converter does). If validation is desired later, add it then.

---

## 8. Bundle Size Impact

| Package | Size | Replacement | New Size |
|---------|------|-------------|----------|
| pdfjs-dist | ~4MB | unpdf | ~1-2MB |
| mammoth | ~200KB | (keep) | ~200KB |
| xlsx | ~1.5MB | (keep) | ~1.5MB |
| turndown | ~50KB | node-html-markdown | ~113KB |
| jszip | ~100KB | (keep) | ~100KB |
| fast-xml-parser | ~100KB | (keep) | ~100KB |
| js-yaml | ~50KB | (drop) | 0 |
| **Total** | **~6MB** | | **~4MB** |

Current binary is 108MB. Adding ~4MB (3.7%) is acceptable. Original estimate of ~6MB can be reduced to ~4MB with recommended substitutions.

---

## 9. License Summary

| Package | License | Compatible |
|---------|---------|-----------|
| unpdf (replaces pdfjs-dist) | MIT | Yes |
| mammoth | BSD-2-Clause | Yes |
| xlsx | Apache 2.0 | Yes |
| node-html-markdown (replaces turndown) | MIT | Yes |
| jszip | MIT (dual MIT/GPLv3, choose MIT) | Yes |
| fast-xml-parser | MIT | Yes |

All licenses are permissive and compatible with each other and with the project.

---

## 10. MCP Integration (`src/server/mcp.ts`)

**Yes, it needs updating.** The plan correctly identifies this in Phase 5b.

Current state (lines 2897-2991):
- Shells out to Python `markitdown` CLI via `Bun.spawn`
- Searches multiple paths for the binary
- Sets up Python PATH environment
- Returns markdown with 50K char truncation
- Saves .md file to `{projectRoot}/.clawd/files/`

The plan's Phase 5b replacement is straightforward: import `convertToMarkdown()` and call it directly. The save-to-file logic and file_id resolution should be preserved.

**Additional integration points not fully covered in plan:**
- `src/agent/src/utils/output-compressor.ts` line 19: already has `convert_to_markdown: 20480` limit. No change needed, but verify the agent tool output respects this compressor.
- The tool description in `src/server/mcp.ts` line 1388 says "Requires: markitdown CLI installed" -- must be removed.
- Tool description at line 1367-1399 needs schema update (already noted in plan).

---

## 11. Edge Cases and Risks Not in Plan

1. **`bun build --compile` tree-shaking:** Bun's bundler may tree-shake unused code paths in xlsx/mammoth if the imports look unused. Test the compiled binary, not just `bun run`.

2. **Memory pressure with concurrent conversions:** The plan mentions "concurrent conversions" in test matrix but doesn't address memory. PDF.js and SheetJS both load entire files into memory. With the agent tool accessible to multiple workers, simultaneous 50MB file conversions could spike memory. Consider a simple semaphore or queue.

3. **The 100MB file size limit** (Phase 5a) is generous. SheetJS and PDF.js will struggle with files over 20-30MB. Consider 50MB as the practical limit.

4. **mammoth's `convertToHtml({ buffer })` signature:** mammoth expects `{ buffer: Buffer }` not `{ buffer: ArrayBuffer }`. The plan uses `Bun.file(filePath).arrayBuffer()` which returns `ArrayBuffer`. Needs `Buffer.from(await Bun.file(filePath).arrayBuffer())` or use `{ path: filePath }` directly.

5. **CSV parser edge case:** The plan's "simple split" CSV parser won't handle embedded newlines in quoted fields (acknowledged but understated). This is common in real-world CSVs exported from Excel. Consider using Bun's built-in CSV support if available, or a 20-line state machine.

---

## Recommended Dependency List (Revised)

```bash
bun add unpdf mammoth xlsx jszip fast-xml-parser node-html-markdown
bun add -d @types/node-html-markdown  # if needed
```

**Dropped:** pdfjs-dist (replaced by unpdf), turndown (replaced by node-html-markdown), js-yaml (unnecessary).

---

## Summary of Recommendations

| Priority | Issue | Action |
|----------|-------|--------|
| **Critical** | pdfjs-dist WASM won't survive `bun build --compile` | Replace with `unpdf` |
| **Critical** | turndown needs DOM, unavailable in Bun server runtime | Replace with `node-html-markdown` |
| **High** | xlsx ESM import may break dynamic requires in compiled binary | Use CommonJS require or test thoroughly |
| **Medium** | mammoth `{ buffer }` type mismatch (ArrayBuffer vs Buffer) | Use `{ path: filePath }` or wrap with `Buffer.from()` |
| **Medium** | js-yaml adds dependency for validation-only use | Drop it, return raw YAML in code fence |
| **Low** | 100MB file limit too generous for in-memory parsers | Lower to 50MB |
| **Low** | Duplicate jszip (mammoth internal + direct dep) | Accept ~100KB redundancy |

---

## Unresolved Questions

1. Has `unpdf` been tested with `bun build --compile`? The UnJS docs claim Bun support but compiled single-binary is a stricter environment. Recommend a 30-minute spike: install unpdf, extract text from a PDF, compile, run the binary.
2. Does `node-html-markdown` handle mammoth's HTML output well? mammoth produces clean semantic HTML, so it should be fine, but test with a real DOCX conversion.
3. SheetJS CommonJS vs ESM: does the project's `"type": "module"` in package.json conflict with `require("xlsx")`? Bun supports both, but test this combination with `--compile`.
