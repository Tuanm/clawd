# Artifact Protocol

Agents can output structured content using `<artifact>` tags. The chat UI detects these
markers and renders them as interactive visual cards with copy, download, and fullscreen controls.

## Syntax

    <artifact type="TYPE" title="TITLE">
    CONTENT
    </artifact>

## Supported Types

| Type | Content | Rendering |
|------|---------|-----------|
| `html` | HTML markup | Sandboxed iframe, DOMPurify-sanitized |
| `react` | JSX component (function App) | Babel + Tailwind in sandboxed iframe |
| `svg` | SVG markup | Inline, DOMPurify-sanitized |
| `chart` | JSON spec | Interactive Recharts component |
| `csv` | CSV with header row | Sortable data table |
| `markdown` | Markdown text | Full markdown pipeline |
| `code` | Source code | Prism syntax highlighting |
| `interactive` | JSON component spec | Rendered inline as interactive UI widgets |

## Chart JSON Format

```json
{
  "type": "line",
  "data": [{"month": "Jan", "sales": 100}, {"month": "Feb", "sales": 150}],
  "xKey": "month",
  "series": [{"key": "sales", "color": "#8884d8", "name": "Sales"}],
  "title": "Monthly Sales"
}
```

Chart types: `line`, `bar`, `pie`, `area`, `scatter`, `composed`. Max 1000 data points, 10 series.

**Pie chart** uses different fields: `{"type":"pie","data":[{"name":"A","value":100}],"dataKey":"value","nameKey":"name"}`

**Composed chart** mixes types: series items can have `"type":"line"|"bar"|"area"` to overlay different chart types on the same axes.

## When to Use Artifacts

**Use artifacts for:**
- Interactive HTML pages, dashboards
- React components (prototypes, UI demos)
- SVG diagrams (architecture, flowcharts)
- Charts and data visualizations
- CSV/tabular data exploration
- Formatted documents (reports, meeting notes)
- Code files with syntax highlighting

**Do NOT use artifacts for:**
- Simple text replies
- Short inline code (use markdown code blocks)
- Regular conversational messages

## Code Artifact Extras

The `code` type accepts an optional `language` attribute:

    <artifact type="code" language="python" title="Data Processor">
    def process(items):
        return [transform(i) for i in items]
    </artifact>

## React Artifact Environment

React artifacts run in a sandboxed iframe with:
- React 18 (available as global `React`)
- Tailwind CSS v3
- Top-level function should be named `App`

No imports needed — React and ReactDOM are pre-loaded.

## Escaping

Content must NOT contain literal `</artifact>`. Use `&lt;/artifact&gt;` if documenting the protocol itself.

## Rendering Locations

| Type | Renders | On Click |
|------|---------|----------|
| `chart` | Inline in message (interactive Recharts) | — |
| `svg` | Inline in message (DOMPurify sanitized) | — |
| `code` | Inline in message (Prism highlighting) | — |
| `html`, `react`, `markdown` | Preview card in message | Opens sidebar panel |
| `csv` | Preview card in message | Sortable data table in sidebar |
| `interactive` | Rendered inline in message | No modal — widgets render directly in chat |

When `series` is omitted from chart specs, series are auto-inferred from numeric data keys.

## React Artifacts

- Top-level function should be named `App` (or `Default` as fallback)
- Available in sandbox: React 18, ReactDOM, Tailwind CSS
- Prism is NOT available inside React iframes

## Limitations

- Max 1000 data points per chart, 10 series (recommended, not hard-enforced)
- Artifacts should not exceed ~5MB of content
- Limited iframe-to-parent communication (resize + error reporting only)

## Security

- HTML/SVG content is sanitized with DOMPurify before rendering
- Chat markdown is sanitized via rehype-sanitize
- HTML and React artifacts run in sandboxed iframes (`sandbox="allow-scripts"`, no `allow-same-origin`)
- No fetch/XHR from iframes (`connect-src: none`), but React artifacts load dependencies from CDNs
- No access to parent page DOM or cookies (opaque origin isolation)
- Sensitive browser APIs blocked (localStorage, geolocation, etc.) via sandbox attribute
