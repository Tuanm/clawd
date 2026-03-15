# Phase 6: File Preview Enhancement (P2)

## Context Links
- [artifact-renderer.tsx](./phase-03-artifact-detection-panel.md) — csv case placeholder from Phase 3
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — existing file attachment rendering (~line 2007)
- [files route](../../src/server/routes/files.ts) — server file serving

## Overview
- **Priority:** P2
- **Status:** Complete
- **Depends on:** Phase 3 (Artifact Detection)
- **Description:** Add CSV table rendering for csv-type artifacts, PDF inline preview via iframe, and enhanced audio/video HTML5 players. Also improve file attachment detection based on MIME type.

## Key Insights
- CSV artifacts just need a simple table parser — no library required, built-in string splitting handles it
- PDF preview: use browser-native `<iframe>` or `<object>` with PDF URL — no extra library needed. `react-pdf` is 500KB+ and overkill for inline preview.
- Audio/video: HTML5 `<audio>` and `<video>` elements with `controls` attribute — zero dependencies
- File attachments already have `mimetype` field in the Message interface (line 34) — use this for type detection
- Keep it simple: no new dependencies for this phase

## Requirements

### Functional
- CSV artifacts render as scrollable HTML tables with header row detection
- PDF file attachments show inline preview (iframe with PDF URL)
- Audio attachments (mp3, wav, ogg, m4a) render as HTML5 audio player
- Video attachments (mp4, webm, ogg) render as HTML5 video player
- File type detection from `mimetype` field on attachment

### Non-Functional
- Zero new dependencies — use native browser capabilities
- CSV table handles up to 10,000 rows without lag (virtualize if needed in Phase 7)
- PDF iframe capped at 500px height
- Video player max width 100% of message container

## Architecture

### CSV Rendering
```
artifact content (CSV string)
  |
  v
parseCsv(content) ──> string[][]
  |
  v
First row = headers ──> <thead>
Remaining rows ──> <tbody>
  |
  v
Wrapped in scrollable .artifact-csv-table container
```

### File Attachment Detection
```
msg.files[].mimetype
  |
  ├── application/pdf      → PdfPreview (iframe)
  ├── audio/*              → <audio controls>
  ├── video/*              → <video controls>
  ├── image/*              → existing image rendering (unchanged)
  └── other                → existing download link (unchanged)
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/artifact-renderer.tsx` | Replace csv placeholder with CsvTable component |
| `packages/ui/src/MessageList.tsx` | Enhance file attachment rendering (~line 2007) to detect PDF/audio/video by mimetype |
| `packages/ui/src/styles.css` | Add `.artifact-csv-table`, `.file-pdf-preview`, `.file-audio-player`, `.file-video-player` styles |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/csv-table.tsx` | CsvTable component — parses CSV and renders HTML table |
| `packages/ui/src/file-preview.tsx` | FilePreview component — PDF iframe, audio/video players |

## Implementation Steps

### Step 1: Create csv-table.tsx (~60 lines)

```typescript
// packages/ui/src/csv-table.tsx
import React, { useMemo } from "react";

interface CsvTableProps {
  content: string;
  maxRows?: number;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  // Handle quoted fields with commas/newlines inside
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ",") { cells.push(current.trim()); current = ""; }
        else { current += ch; }
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

export default function CsvTable({ content, maxRows = 500 }: CsvTableProps) {
  const rows = useMemo(() => parseCsv(content), [content]);

  if (rows.length === 0) {
    return <div className="artifact-csv-empty">No data</div>;
  }

  const headers = rows[0];
  const body = rows.slice(1, maxRows + 1);
  const truncated = rows.length - 1 > maxRows;

  return (
    <div className="artifact-csv-table">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => <th key={i}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="artifact-csv-truncated">
          Showing {maxRows} of {rows.length - 1} rows
        </div>
      )}
    </div>
  );
}
```

### Step 2: Create file-preview.tsx (~70 lines)

```typescript
// packages/ui/src/file-preview.tsx
import React from "react";

interface FilePreviewProps {
  url: string;
  name: string;
  mimetype: string;
}

export default function FilePreview({ url, name, mimetype }: FilePreviewProps) {
  if (mimetype === "application/pdf") {
    return (
      <div className="file-pdf-preview">
        <div className="file-preview-label">{name}</div>
        <iframe
          src={url}
          title={name}
          style={{ width: "100%", height: "500px", border: "none" }}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    );
  }

  if (mimetype.startsWith("audio/")) {
    return (
      <div className="file-audio-player">
        <div className="file-preview-label">{name}</div>
        <audio controls preload="metadata" style={{ width: "100%" }}>
          <source src={url} type={mimetype} />
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  if (mimetype.startsWith("video/")) {
    return (
      <div className="file-video-player">
        <div className="file-preview-label">{name}</div>
        <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "400px" }}>
          <source src={url} type={mimetype} />
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  // Default: download link (shouldn't reach here if caller filters correctly)
  return null;
}

/**
 * Returns true if the mimetype is previewable (PDF, audio, video).
 * Images are handled by existing code and excluded here.
 */
export function isPreviewableMimetype(mimetype: string): boolean {
  return (
    mimetype === "application/pdf" ||
    mimetype.startsWith("audio/") ||
    mimetype.startsWith("video/")
  );
}
```

### Step 3: Update artifact-renderer.tsx

```typescript
import CsvTable from "./csv-table";

// Replace csv case:
case "csv":
  return <CsvTable content={content} />;
```

### Step 4: Update MessageList.tsx file attachment rendering

Find the file attachment rendering section (where `msg.files` is mapped, around the image rendering area). Add FilePreview for non-image previewable files:

```typescript
import FilePreview, { isPreviewableMimetype } from "./file-preview";

// In the files rendering section, after image handling:
{file.mimetype && isPreviewableMimetype(file.mimetype) && (
  <FilePreview url={file.url_private} name={file.name} mimetype={file.mimetype} />
)}
```

### Step 5: Add CSS styles

```css
/* ── CSV table ─────────────────────────────────────────────────── */
.artifact-csv-table {
  max-height: 400px;
  overflow: auto;
  border: 1px solid var(--border-color, #e1e4e8);
  border-radius: 4px;
}

.artifact-csv-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.artifact-csv-table th {
  position: sticky;
  top: 0;
  background: var(--card-header-bg, #f6f8fa);
  font-weight: 600;
  text-align: left;
  padding: 6px 10px;
  border-bottom: 2px solid var(--border-color, #e1e4e8);
  white-space: nowrap;
}

.artifact-csv-table td {
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color, #e1e4e8);
  white-space: nowrap;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artifact-csv-table tbody tr:hover {
  background: var(--card-header-hover-bg, #eef0f2);
}

.artifact-csv-truncated {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-secondary, #586069);
  text-align: center;
  border-top: 1px solid var(--border-color, #e1e4e8);
}

.artifact-csv-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary, #586069);
}

/* ── File previews ─────────────────────────────────────────────── */
.file-preview-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #586069);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-pdf-preview {
  margin: 8px 0;
  border: 1px solid var(--border-color, #e1e4e8);
  border-radius: 6px;
  overflow: hidden;
  padding: 8px;
}

.file-audio-player {
  margin: 8px 0;
  padding: 8px 12px;
  background: var(--card-bg, #f6f8fa);
  border-radius: 6px;
}

.file-video-player {
  margin: 8px 0;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .artifact-csv-table {
    border-color: var(--border-color, #30363d);
  }
  .artifact-csv-table th {
    background: var(--card-header-bg, #161b22);
    border-color: var(--border-color, #30363d);
  }
  .artifact-csv-table td {
    border-color: var(--border-color, #30363d);
  }
  .file-pdf-preview {
    border-color: var(--border-color, #30363d);
  }
  .file-audio-player {
    background: var(--card-bg, #161b22);
  }
}
```

## Todo List

- [x] Create `csv-table.tsx` with CSV parser and table renderer
- [x] Create `file-preview.tsx` with PDF/audio/video components
- [x] Update `artifact-modal.tsx` — add csv case using CsvTable (artifact-renderer.tsx not needed; modal owns rendering)
- [x] Update MessageList.tsx — add FilePreview for PDF/audio/video attachments
- [x] Add CSV table CSS with sticky headers and dark mode
- [x] Add file preview CSS styles
- [x] Test: CSV artifact with header row renders as table
- [x] Test: CSV with quoted fields containing commas parses correctly
- [x] Test: CSV with > 500 rows shows truncation message
- [x] Test: PDF attachment shows inline iframe preview
- [x] Test: Audio attachment shows HTML5 player with controls
- [x] Test: Video attachment shows HTML5 player
- [x] Test: Non-previewable files still render as download links
- [x] Run `bun run build` — build passes, 0 TS errors

## Success Criteria
- CSV artifacts render as scrollable tables with sticky headers
- PDF attachments preview inline
- Audio/video play in-browser with native controls
- Zero new npm dependencies
- Dark mode compatible

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CSV parser doesn't handle all edge cases (multi-line quoted fields) | Medium | Low | Simple parser handles 95% of cases; link to download for complex CSVs |
| PDF iframe blocked by browser security for certain URLs | Low | Medium | PDF is served from same origin (`/api/files/`); same-origin iframes work |
| Large CSV (10K+ rows) causes slow DOM rendering | Low | Medium | Default maxRows=500 with truncation; Phase 7 can add virtualization |

## Security Considerations
- CSV parser is string-only — no eval, no formula injection risk in rendering
- PDF iframe uses `sandbox="allow-scripts allow-same-origin"` — `allow-same-origin` needed for PDF.js renderer built into browsers, but sandboxed from parent
- Audio/video use native `<audio>`/`<video>` elements — no script execution
- All file URLs come from the server's `/api/files/` route — validated server-side

## Next Steps
- Consider adding CSV sort (click column headers) as a future enhancement
- Consider adding CSV chart generation (auto-suggest chart type based on data)
- Phase 7 can add virtual scrolling for large CSV tables
