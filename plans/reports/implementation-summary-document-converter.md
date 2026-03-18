---
title: "Document Converter Implementation Summary"
date: 2026-03-16
status: Ready for Implementation
priority: Medium
---

# Document Converter Implementation Summary

## Quick Decision

✅ **PRIMARY CHOICE: TypeScript/npm Stack** (pure JavaScript, zero Python, zero Docker)

**Why:** Aligns with Claw'd's "single binary" philosophy while providing 90%+ format coverage

---

## What to Build

A native Bun `convert_to_markdown` tool that agents can use to convert documents to markdown text without external dependencies.

**Supported Formats:**
- PDF (via pdfjs-dist)
- DOCX (via mammoth)
- XLSX/XLS (via SheetJS)
- PPTX (via node-pptx-parser)
- HTML (via turndown)
- CSV, JSON, XML (via native parsers)
- PNG/JPG/GIF (OCR via Tesseract.js)
- Plain text files

---

## What NOT to Do

❌ **Don't use Python/markitdown directly** — requires external runtime
❌ **Don't add Docker dependency** — conflicts with single-binary design
❌ **Don't use MCP wrapper** — adds unnecessary protocol overhead
❌ **Don't wait for perfect solution** — 90% coverage is enough

---

## Implementation Roadmap

### Phase 1: Foundation (Days 1-3)
```bash
bun add pdfjs-dist mammoth xlsx node-pptx-parser turndown \
  tesseract.js csv-parse fast-xml-parser js-yaml papaparse
```

Create `/src/tools/document-converter/`:
- `types.ts` — ConversionOptions, ConversionResult interfaces
- `pdf-converter.ts` — pdfjs-dist wrapper
- `docx-converter.ts` — mammoth wrapper
- `xlsx-converter.ts` — SheetJS wrapper
- `pptx-converter.ts` — node-pptx-parser wrapper
- `html-converter.ts` — turndown wrapper
- `csv-converter.ts` — csv-parse wrapper
- `image-converter.ts` — Tesseract.js OCR wrapper
- `index.ts` — Main dispatcher function

### Phase 2: Integration (Days 4-5)
- Register `convert_to_markdown` tool in agent plugin system
- Add to tool schema with proper input/output validation
- Write unit tests for each converter

### Phase 3: Polish (Days 6-7)
- Error handling + edge cases
- Performance optimization (caching, streaming for large files)
- Integration tests with agent workflow
- Documentation

---

## Code Template

```typescript
// src/tools/document-converter/index.ts
export interface ConversionOptions {
  includeTables?: boolean;
  extractMetadata?: boolean;
  ocrLanguage?: string;
  maxSize?: number; // bytes
}

export interface ConversionResult {
  markdown: string;
  format: string;
  pages?: number;
  error?: string;
}

export async function convertToMarkdown(
  filePath: string,
  options: ConversionOptions = {}
): Promise<ConversionResult> {
  const ext = filePath.split('.').pop()?.toLowerCase();

  try {
    const result = await dispatch(ext, filePath, options);
    return { ...result, format: ext || 'unknown' };
  } catch (error) {
    return {
      markdown: '',
      format: ext || 'unknown',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function dispatch(
  format: string | undefined,
  filePath: string,
  options: ConversionOptions
): Promise<Omit<ConversionResult, 'format'>> {
  switch (format) {
    case 'pdf':
      return convertPdf(filePath);
    case 'docx':
    case 'doc':
      return convertDocx(filePath);
    case 'xlsx':
    case 'xls':
      return convertXlsx(filePath);
    case 'pptx':
      return convertPptx(filePath);
    case 'html':
      return convertHtml(filePath);
    case 'csv':
      return convertCsv(filePath);
    case 'json':
      return convertJson(filePath);
    case 'xml':
      return convertXml(filePath);
    case 'txt':
      return convertTxt(filePath);
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return convertImage(filePath, options);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// Implement each converter...
```

---

## Agent Tool Schema

```typescript
{
  id: 'convert_to_markdown',
  name: 'Convert Document to Markdown',
  description: 'Convert PDF, DOCX, XLSX, PPTX, HTML, CSV, JSON, XML, or images to markdown text. Supports OCR for image files.',
  category: 'documents',
  inputSchema: {
    type: 'object',
    properties: {
      file_uri: {
        type: 'string',
        description: 'Path to file (file:// or http://) or local path'
      },
      include_tables: {
        type: 'boolean',
        description: 'Extract table data (default: true)'
      },
      ocr_language: {
        type: 'string',
        enum: ['eng', 'fra', 'deu', 'spa', 'chi_sim', 'jpn', 'kor'],
        description: 'OCR language for images (default: eng)'
      }
    },
    required: ['file_uri']
  }
}
```

---

## Testing Strategy

```typescript
// __tests__/document-converter.test.ts
describe('convertToMarkdown', () => {
  it('converts PDF to markdown', async () => {
    const result = await convertToMarkdown('test.pdf');
    expect(result.format).toBe('pdf');
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it('converts DOCX to markdown', async () => {
    const result = await convertToMarkdown('test.docx');
    expect(result.format).toBe('docx');
    expect(result.markdown).toContain('heading');
  });

  // ... more tests
});
```

---

## Performance Targets

| Format | Target Time | Reality Check |
|--------|------------|---------------|
| PDF (5MB) | <2s | ✅ pdfjs-dist is fast |
| DOCX (2MB) | <500ms | ✅ mammoth is lightweight |
| XLSX (10MB) | <1s | ✅ SheetJS optimized |
| Image OCR | <5s | ⚠️ Tesseract.js slower, but acceptable |

---

## Fallback Strategy for Future

If OCR performance becomes critical:

```typescript
const ENABLE_DOCKER_FALLBACK = false; // Set true later if needed

async function convertImage(filePath: string, options: ConversionOptions) {
  if (ENABLE_DOCKER_FALLBACK && isComplexImage(filePath)) {
    try {
      return await callMarkItDownApi(filePath);
    } catch (e) {
      // Fall back to local Tesseract.js
    }
  }
  return await ocr(filePath, options.ocrLanguage);
}
```

---

## What Gets Added to Package.json

```json
{
  "dependencies": {
    "pdfjs-dist": "^3.11.174",
    "mammoth": "^1.7.2",
    "xlsx": "^0.18.5",
    "node-pptx-parser": "^1.1.2",
    "turndown": "^7.2.2",
    "tesseract.js": "^4.1.1",
    "csv-parse": "^5.5.6",
    "fast-xml-parser": "^4.4.1",
    "js-yaml": "^4.1.0",
    "papaparse": "^5.4.1"
  }
}
```

**Total bundle size added:** ~10-12MB (mostly Tesseract.js WASM)
**Acceptable for Claw'd:** Yes (already ~50MB+ with UI + extension)

---

## Integration Points

1. **Agent Tools Plugin** — Register `convert_to_markdown`
2. **Agent Memory** — Store conversion results for retrieval
3. **File Upload Workflow** — Auto-convert uploaded docs
4. **Knowledge Base** — Index converted document text

---

## Success Metrics

✅ Agent can convert any common document format
✅ Conversion completes in <5s for typical files
✅ No external dependencies (no Python, no Docker)
✅ Error handling + fallback strategies
✅ Unit test coverage >90%
✅ Integration tests passing

---

## References

- Report: `/plans/reports/researcher-markitdown-2026-03-16.md`
- Memory: `~/.claude/agent-memory/researcher/markitdown-research.md`

---

## Next Steps

1. **Read full report** for detailed comparison of all approaches
2. **Confirm recommendation** with team (TypeScript stack primary)
3. **Delegate to implementation** — create planner task for feature development
4. **Set up testing environment** — gather sample PDFs, Word docs, etc.
5. **Begin Phase 1** — npm dependencies + converter stubs

---

## Questions to Resolve Before Starting

1. **Audio transcription?** If critical, need to plan Whisper API integration
2. **Image/PDF complexity?** If vision-enhanced OCR required, consider Docker fallback
3. **Batch processing?** Should converter support multiple files?
4. **File size limits?** Any restrictions on document sizes?
5. **Error handling?** Should partial conversions fail or return partial markdown?

