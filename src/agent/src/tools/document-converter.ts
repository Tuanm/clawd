/**
 * Document Converter
 *
 * Converts document files (PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV) to Markdown text.
 * Supports 50MB file limit, 30s conversion timeout, progressive truncation, and magic-byte detection.
 */

// ============================================================================
// Types
// ============================================================================

interface ConvertResult {
  success: boolean;
  markdown: string;
  format: string;
  error?: string;
}

type DocFormat = "pdf" | "docx" | "xlsx" | "pptx" | "html" | "epub" | "csv" | "text" | "unknown";

// ============================================================================
// Constants
// ============================================================================

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const CONVERSION_TIMEOUT_MS = 30_000; // 30s
const BINARY_SAMPLE_SIZE = 512;

// ============================================================================
// Format Detection
// ============================================================================

const EXT_MAP: Record<string, DocFormat> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  pptx: "pptx",
  ppt: "pptx",
  html: "html",
  htm: "html",
  epub: "epub",
  csv: "csv",
  tsv: "csv",
  txt: "text",
  md: "text",
  markdown: "text",
  rst: "text",
  log: "text",
};

function detectFormatByExtension(filePath: string): DocFormat | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXT_MAP[ext] ?? null;
}

async function detectFormatByMagicBytes(data: Buffer): Promise<DocFormat> {
  if (data.length < 4) return "unknown";

  // PDF: %PDF
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return "pdf";
  }

  // ZIP-based formats: PK (0x504B)
  if (data[0] === 0x50 && data[1] === 0x4b) {
    return await detectZipSubformat(data);
  }

  // HTML: starts with <!DOCTYPE or <html
  const prefix = data.slice(0, 128).toString("utf8").trimStart().toLowerCase();
  if (prefix.startsWith("<!doctype") || prefix.startsWith("<html")) {
    return "html";
  }

  return "unknown";
}

async function detectZipSubformat(data: Buffer): Promise<DocFormat> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(data);
    const files = Object.keys(zip.files);

    if (files.some((f) => f === "word/document.xml")) return "docx";
    if (files.some((f) => f === "xl/workbook.xml")) return "xlsx";
    if (files.some((f) => f === "ppt/presentation.xml")) return "pptx";
    if (files.some((f) => f === "META-INF/container.xml")) return "epub";
  } catch {
    // Fall through to unknown
  }
  return "unknown";
}

// ============================================================================
// Binary Guard
// ============================================================================

function isBinaryData(data: Buffer): boolean {
  const sample = data.slice(0, BINARY_SAMPLE_SIZE);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) return true;
  }
  return false;
}

// ============================================================================
// Per-format Converters
// ============================================================================

async function convertPdf(data: Buffer, maxLength: number): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  const textResult = await parser.getText();

  const text = textResult.text?.trim();
  if (!text) {
    return "[This PDF appears to contain scanned images only. Use read_image tool for OCR.]";
  }

  const numpages = textResult.total;
  let body = textResult.text;
  if (body.length > maxLength) {
    body = body.slice(0, maxLength) + "\n\n[TRUNCATED]";
  }
  return `# PDF Document\n\n**Pages:** ${numpages}\n\n${body}`;
}

async function convertDocx(data: Buffer, maxLength: number): Promise<string> {
  const mammoth = await import("mammoth");
  const TurndownService = (await import("turndown")).default;
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  const result = await mammoth.convertToHtml({ buffer: data });
  let md = turndown.turndown(result.value);
  if (md.length > maxLength) {
    md = md.slice(0, maxLength) + "\n\n[TRUNCATED]";
  }
  return md;
}

async function convertXlsx(data: Buffer, maxLength: number): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "buffer", cellDates: true });

  const parts: string[] = [];
  let totalLen = 0;

  for (const sheetName of workbook.SheetNames) {
    if (totalLen > maxLength) {
      parts.push("\n\n[TRUNCATED — remaining sheets omitted]");
      break;
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    parts.push(`## Sheet: ${sheetName}\n`);

    if (rows.length === 0) {
      parts.push("*(empty sheet)*\n");
      continue;
    }

    const maxCols = Math.min((rows[0]?.length || 0), 20);
    const maxRows = Math.min(rows.length, 500);

    const header = (rows[0] || []).slice(0, maxCols).map((c) => String(c ?? ""));
    parts.push(`| ${header.join(" | ")} |`);
    parts.push(`| ${header.map(() => "---").join(" | ")} |`);

    let truncated = false;
    for (let r = 1; r < maxRows; r++) {
      const row = (rows[r] || []).slice(0, maxCols).map((c) => String(c ?? ""));
      const rowStr = `| ${row.join(" | ")} |`;
      parts.push(rowStr);
      totalLen += rowStr.length;
      if (totalLen > maxLength) {
        parts.push("\n[TRUNCATED — remaining rows omitted]");
        truncated = true;
        break;
      }
    }

    if (!truncated && rows.length > 500) {
      parts.push(`\n*...${rows.length - 500} more rows*`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

async function convertPptx(data: Buffer, maxLength: number): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);

  const parts: string[] = ["# Presentation\n"];
  let totalLen = 0;
  let slideNum = 1;

  while (true) {
    const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`);
    if (!slideFile) break;

    if (totalLen > maxLength) {
      parts.push("\n[TRUNCATED — remaining slides omitted]");
      break;
    }

    const xml = await slideFile.async("text");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
    const slideText = texts.join(" ");
    parts.push(`## Slide ${slideNum}\n\n${slideText}\n`);
    totalLen += slideText.length;
    slideNum++;
  }

  return parts.join("\n");
}

async function convertHtml(text: string, maxLength: number): Promise<string> {
  const TurndownService = (await import("turndown")).default;
  const cleaned = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  let md = turndown.turndown(cleaned);
  if (md.length > maxLength) {
    md = md.slice(0, maxLength) + "\n\n[TRUNCATED]";
  }
  return md;
}

async function convertEpub(data: Buffer, maxLength: number): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const TurndownService = (await import("turndown")).default;
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  const zip = await JSZip.loadAsync(data);

  const containerXml = await zip.file("META-INF/container.xml")?.async("text");
  if (!containerXml) return "[Invalid EPUB: missing container.xml]";

  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1] || "content.opf";
  const opfXml = await zip.file(opfPath)?.async("text");
  if (!opfXml) return "[Invalid EPUB: missing content.opf]";

  const itemRefs = [...opfXml.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => m[1]);
  const items = new Map<string, string>();
  for (const m of opfXml.matchAll(/<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*/g)) {
    items.set(m[1], m[2]);
  }

  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

  const parts: string[] = [];
  let totalLen = 0;

  for (const ref of itemRefs) {
    if (totalLen > maxLength) {
      parts.push("\n[TRUNCATED — remaining chapters omitted]");
      break;
    }

    const href = items.get(ref);
    if (!href) continue;

    const fullPath = opfDir + href;
    const html = await zip.file(fullPath)?.async("text");
    if (!html) continue;

    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    const md = turndown.turndown(cleaned);
    parts.push(md);
    totalLen += md.length;
  }

  return parts.join("\n\n---\n\n");
}

function convertCsv(text: string, maxLength: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "[Empty CSV file]";

  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (const ch of line) {
      if (inQuotes) {
        if (ch === '"') inQuotes = false;
        else cell += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ",") {
          cells.push(cell);
          cell = "";
        } else {
          cell += ch;
        }
      }
    }
    cells.push(cell);
    return cells;
  };

  const header = parseRow(lines[0]);
  const maxCols = Math.min(header.length, 20);
  const parts: string[] = [];
  parts.push(`| ${header.slice(0, maxCols).join(" | ")} |`);
  parts.push(`| ${header.slice(0, maxCols).map(() => "---").join(" | ")} |`);

  const maxRows = Math.min(lines.length, 500);
  let totalLen = 0;
  for (let i = 1; i < maxRows; i++) {
    const row = parseRow(lines[i]).slice(0, maxCols);
    const rowStr = `| ${row.join(" | ")} |`;
    parts.push(rowStr);
    totalLen += rowStr.length;
    if (totalLen > maxLength) {
      parts.push("\n[TRUNCATED]");
      break;
    }
  }

  if (lines.length > 500) {
    parts.push(`\n*...${lines.length - 500} more rows*`);
  }

  return parts.join("\n");
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function convertToMarkdown(
  filePath: string,
  maxLength: number = 30_000,
): Promise<ConvertResult> {
  const { readFileSync, statSync } = await import("node:fs");

  // File size check
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch (err: any) {
    return { success: false, markdown: "", format: "unknown", error: `File not found: ${err.message}` };
  }

  if (stat.size > MAX_FILE_SIZE) {
    return {
      success: false,
      markdown: "",
      format: "unknown",
      error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit`,
    };
  }

  const data = readFileSync(filePath);

  // Binary guard (for text-expected formats)
  const extFmt = detectFormatByExtension(filePath);

  // Determine format
  let format: DocFormat = extFmt ?? (await detectFormatByMagicBytes(data));

  // For unknown extension text-like content: check magic bytes first, then try as text
  if (format === "unknown") {
    if (isBinaryData(data)) {
      return {
        success: false,
        markdown: "",
        format: "unknown",
        error: "File appears to be binary. Cannot convert to Markdown.",
      };
    }
    // Attempt as plain text
    format = "text";
  }

  const conversionFn = async (): Promise<ConvertResult> => {
    try {
      let markdown: string;

      switch (format) {
        case "pdf":
          markdown = await convertPdf(data, maxLength);
          break;
        case "docx":
          markdown = await convertDocx(data, maxLength);
          break;
        case "xlsx":
          markdown = await convertXlsx(data, maxLength);
          break;
        case "pptx":
          markdown = await convertPptx(data, maxLength);
          break;
        case "html":
          markdown = await convertHtml(data.toString("utf8"), maxLength);
          break;
        case "epub":
          markdown = await convertEpub(data, maxLength);
          break;
        case "csv":
          markdown = await convertCsv(data.toString("utf8"), maxLength);
          break;
        case "text":
          markdown = data.toString("utf8");
          if (markdown.length > maxLength) {
            markdown = markdown.slice(0, maxLength) + "\n\n[TRUNCATED]";
          }
          break;
        default:
          return {
            success: false,
            markdown: "",
            format,
            error: `Unsupported format: ${format}. Supported: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV`,
          };
      }

      return { success: true, markdown, format };
    } catch (err: any) {
      return { success: false, markdown: "", format, error: `Conversion failed: ${err.message}` };
    }
  };

  // Wrap with 30s timeout
  const timeout = new Promise<ConvertResult>((resolve) =>
    setTimeout(
      () => resolve({ success: false, markdown: "", format, error: "Conversion timed out (30s)" }),
      CONVERSION_TIMEOUT_MS,
    ),
  );

  return Promise.race([conversionFn(), timeout]);
}
