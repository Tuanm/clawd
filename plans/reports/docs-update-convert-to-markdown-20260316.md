# Documentation Update: convert_to_markdown Tool

**Date:** 2026-03-16
**Status:** Completed

## Summary

Updated project documentation to reflect the current state of the `convert_to_markdown` tool. Removed obsolete references and added comprehensive technical details about the production implementation.

## Changes Made

### 1. docs/codebase-summary.md
- **Added** new subsection "Document Conversion Tool" after "26 Browser Tools" section
- **Documented** tool registration, supported formats, dependencies, limits, features, and security measures
- **Details included**:
  - Tool name and function (converts to Markdown, saves to `{projectRoot}/.clawd/files/`)
  - Supported formats: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV, TSV, plain text
  - Dependencies: unpdf, mammoth, exceljs, jszip, turndown (pure TypeScript, no Python)
  - Limits: 50MB file size, 5M char maxLength, 30s timeout
  - Features: magic-byte detection, binary guard, progressive truncation, zip bomb protection, XML entity decoding, pipe escaping, TSV support
  - Security: path validation, isFile() guard, async file I/O

### 2. README.md
- **Added** new subsection "Document Conversion" in UI Features section (after File Preview)
- **Documented** tool functionality, supported formats, limits, output location, and security
- **Cross-reference** links tool to codebase-summary for detailed specifications

## Verification

- [x] No mentions of deprecated tools found (markitdown, pdf-parse, xlsx/SheetJS, MCP convert_to_markdown)
- [x] All implementation details verified against source code:
  - `src/agent/src/tools/document-converter.ts` — converter implementation
  - `src/agent/src/tools/tools.ts` — tool registration (lines ~3280-3323)
- [x] All dependencies cross-checked in converter source
- [x] Format detection and limits verified
- [x] Security features documented accurately

## Files Updated

1. `/9ecbf/git/github.com/clawd-pilot/clawd/docs/codebase-summary.md` (line 249-264)
2. `/9ecbf/git/github.com/clawd-pilot/clawd/README.md` (line 679-685)

## Key Facts Documented

- **Tool name**: `convert_to_markdown` (agent tool, not MCP)
- **Pure TypeScript**: No Python markitdown dependency
- **Output storage**: `{projectRoot}/.clawd/files/{name}.md`
- **Agent integration**: Returns path hint; agents use `view()` to read
- **Production-ready features**: format detection fallback, binary guards, truncation, zip bomb protection
- **Zero breaking changes**: Tool is fully functional and integrated

## No Deletions

Confirmed no outdated references to remove:
- No mentions of markitdown in docs/
- No mentions of pdf-parse in docs/
- No mentions of old MCP tool in docs/
- Historical research reports preserved in plans/ directory

## Notes

Documentation changes are minimal and focused, following the instruction to update only existing docs without rewriting entire sections. All updates are evidence-based, referencing the actual implementation code.
