import type { Schema } from "hast-util-sanitize";
import { defaultSchema } from "hast-util-sanitize";

/**
 * rehype-sanitize operates on hast (HTML AST), which uses `class` not `className`.
 * This schema extends the default GitHub-flavored allowlist with KaTeX + GFM needs.
 */
export const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // KaTeX elements
    "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext",
    "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder",
    "mover", "munderover", "mtable", "mtr", "mtd", "mspace",
    "annotation",
    // GFM
    "details", "summary",
    // Code
    "pre", "code", "span",
    // Structural
    "div", "section",
    // Tables
    "table", "thead", "tbody", "tr", "th", "td",
    // Inline
    "del", "ins", "kbd", "abbr", "mark", "sup", "sub",
    // Media (controlled)
    "img",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // KaTeX uses class extensively on span/div
    span: [...(defaultSchema.attributes?.span ?? []), "class", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "class", "style"],
    // Code blocks need class for language-* highlighting
    code: ["class"],
    pre: ["class"],
    // Math elements
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    // Tables
    td: ["align", "colSpan", "rowSpan"],
    th: ["align", "colSpan", "rowSpan"],
    // Images - restricted src
    img: ["src", "alt", "title", "width", "height"],
    // Links
    a: ["href", "title", "target", "rel"],
    // Task list checkboxes
    input: ["type", "checked", "disabled", "class"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
  },
  // Strip style attributes except on KaTeX spans/divs (handled above)
  strip: ["script", "style", "iframe", "object", "embed", "form"],
};
