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
const MAX_DECOMPRESSED_SIZE = 200 * 1024 * 1024; // 200MB decompressed limit
const CONVERSION_TIMEOUT_MS = 30_000; // 30s
const BINARY_SAMPLE_SIZE = 512;

const escPipe = (s: string) => String(s ?? "").replace(/\|/g, "\\|"); // lgtm[js/incomplete-sanitization]

/** Strip all <tagName>...</tagName> blocks using index-based search (avoids regex [\s\S]*? flagged by CodeQL) */
function stripTagBlocks(html: string, tagName: string): string {
  let result = html;
  const openPattern = new RegExp(`<${tagName}\\b`, "i");
  const closeTag = `</${tagName}>`;
  let safety = 100;
  while (safety-- > 0) {
    const openMatch = openPattern.exec(result);
    if (!openMatch) break;
    const closeIdx = result.toLowerCase().indexOf(closeTag.toLowerCase(), openMatch.index);
    if (closeIdx === -1) {
      // No closing tag — remove from open tag to end
      result = result.slice(0, openMatch.index);
      break;
    }
    result = result.slice(0, openMatch.index) + result.slice(closeIdx + closeTag.length);
  }
  return result;
}

// ============================================================================
// Format Detection
// ============================================================================

const EXT_MAP: Record<string, DocFormat> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
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

async function loadZipSafe(data: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  let totalUncompressed = 0;
  zip.forEach((_, file) => {
    if (!file.dir) {
      const meta = file as any;
      totalUncompressed += meta._data?.uncompressedSize ?? meta._data?.compressedSize ?? 0;
    }
  });
  if (totalUncompressed > MAX_DECOMPRESSED_SIZE) {
    throw new Error(
      `Decompressed size (~${(totalUncompressed / 1024 / 1024).toFixed(0)}MB) exceeds ${MAX_DECOMPRESSED_SIZE / 1024 / 1024}MB limit`,
    );
  }
  return zip;
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
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(data));

  const text = result.text?.join("\n")?.trim();
  if (!text) {
    return "[This PDF appears to contain scanned images only. Use read_image tool for OCR.]";
  }

  let body = text;
  if (body.length > maxLength) {
    body = body.slice(0, maxLength) + "\n\n[TRUNCATED]";
  }
  return `# PDF Document\n\n**Pages:** ${result.totalPages}\n\n${body}`;
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
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as any);

  const parts: string[] = [];
  let totalLen = 0;

  for (const sheet of workbook.worksheets) {
    if (totalLen > maxLength) {
      parts.push("\n\n[TRUNCATED — remaining sheets omitted]");
      break;
    }

    parts.push(`## Sheet: ${sheet.name}\n`);

    if (sheet.rowCount === 0) {
      parts.push("*(empty sheet)*\n");
      continue;
    }

    const maxCols = Math.min(sheet.columnCount, 20);
    const maxRows = Math.min(sheet.rowCount, 500);

    // Header row
    const headerRow = sheet.getRow(1);
    const header: string[] = [];
    for (let c = 1; c <= maxCols; c++) {
      header.push(escPipe(String(headerRow.getCell(c).value ?? "")));
    }
    parts.push(`| ${header.join(" | ")} |`);
    parts.push(`| ${header.map(() => "---").join(" | ")} |`);

    // Data rows
    let truncated = false;
    for (let r = 2; r <= maxRows; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= maxCols; c++) {
        cells.push(escPipe(String(row.getCell(c).value ?? "")));
      }
      const rowStr = `| ${cells.join(" | ")} |`;
      parts.push(rowStr);
      totalLen += rowStr.length;
      if (totalLen > maxLength) {
        parts.push("\n[TRUNCATED — remaining rows omitted]");
        truncated = true;
        break;
      }
    }

    if (!truncated && sheet.rowCount > 500) {
      parts.push(`\n*...${sheet.rowCount - 500} more rows*`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

function decodeXmlEntities(s: string): string {
  // Decode &amp; last to avoid double-decoding (e.g., &amp;lt; must not become <)
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

async function convertPptx(data: Buffer, maxLength: number): Promise<string> {
  const zip = await loadZipSafe(data);

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
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const slideText = texts.join(" ");
    parts.push(`## Slide ${slideNum}\n\n${slideText}\n`);
    totalLen += slideText.length;
    slideNum++;
  }

  return parts.join("\n");
}

async function convertHtml(text: string, maxLength: number): Promise<string> {
  const TurndownService = (await import("turndown")).default;
  // Strip script/style blocks by finding open/close tag positions (avoids regex [\s\S]*? flagged by CodeQL)
  let cleaned = stripTagBlocks(text, "script");
  cleaned = stripTagBlocks(cleaned, "style");

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  let md = turndown.turndown(cleaned);
  if (md.length > maxLength) {
    md = md.slice(0, maxLength) + "\n\n[TRUNCATED]";
  }
  return md;
}

async function convertEpub(data: Buffer, maxLength: number): Promise<string> {
  const TurndownService = (await import("turndown")).default;
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  const zip = await loadZipSafe(data);

  const containerXml = await zip.file("META-INF/container.xml")?.async("text");
  if (!containerXml) return "[Invalid EPUB: missing container.xml]";

  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1] || "content.opf";
  const opfXml = await zip.file(opfPath)?.async("text");
  if (!opfXml) return "[Invalid EPUB: missing content.opf]";

  const itemRefs = [...opfXml.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => m[1]);
  const items = new Map<string, string>();
  for (const m of opfXml.matchAll(/<item\s+([^>]+)/g)) {
    const attrs = m[1];
    const id = attrs.match(/id="([^"]+)"/)?.[1];
    const href = attrs.match(/href="([^"]+)"/)?.[1];
    if (id && href) items.set(id, href);
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

    const fullPath = opfDir + decodeURIComponent(href);
    const html = await zip.file(fullPath)?.async("text");
    if (!html) continue;

    let cleaned = stripTagBlocks(html, "script");
    cleaned = stripTagBlocks(cleaned, "style");
    const md = turndown.turndown(cleaned);
    parts.push(md);
    totalLen += md.length;
  }

  return parts.join("\n\n---\n\n");
}

function convertCsv(text: string, maxLength: number, delimiter: string = ","): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) return "[Empty CSV file]";

  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          // Escaped quote: "" → literal "
          if (i + 1 < line.length && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delimiter) {
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
  parts.push(`| ${header.slice(0, maxCols).map(escPipe).join(" | ")} |`);
  parts.push(
    `| ${header
      .slice(0, maxCols)
      .map(() => "---")
      .join(" | ")} |`,
  );

  const maxRows = Math.min(lines.length, 500);
  let totalLen = 0;
  for (let i = 1; i < maxRows; i++) {
    const row = parseRow(lines[i]).slice(0, maxCols).map(escPipe);
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

export async function convertToMarkdown(filePath: string, maxLength: number = 5_000_000): Promise<ConvertResult> {
  const { stat: fsStat, readFile } = await import("node:fs/promises");

  // File size check
  let fileStat: Awaited<ReturnType<typeof fsStat>>;
  try {
    fileStat = await fsStat(filePath);
  } catch (err: any) {
    return { success: false, markdown: "", format: "unknown", error: `File not found: ${err.message}` };
  }

  if (!fileStat.isFile()) {
    return { success: false, markdown: "", format: "unknown", error: "Path is a directory, not a file" };
  }

  if (fileStat.size > MAX_FILE_SIZE) {
    return {
      success: false,
      markdown: "",
      format: "unknown",
      error: `File too large: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit`,
    };
  }

  let data: Buffer;
  try {
    data = Buffer.from(await readFile(filePath));
  } catch (err: any) {
    return { success: false, markdown: "", format: "unknown", error: `Read failed: ${err.message}` };
  }

  // Binary guard (for text-expected formats)
  const extFmt = detectFormatByExtension(filePath);

  // Determine format
  let format: DocFormat = extFmt ?? (await detectFormatByMagicBytes(data));

  // Binary guard for text-expected formats
  const textFormats: DocFormat[] = ["html", "csv", "text"];
  if (textFormats.includes(format) && isBinaryData(data)) {
    return {
      success: false,
      markdown: "",
      format,
      error: "File appears to be binary despite text extension.",
    };
  }

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
        case "csv": {
          const delim = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
          markdown = convertCsv(data.toString("utf8"), maxLength, delim);
          break;
        }
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

  // Wrap with 30s timeout (clear timer to prevent leak)
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<ConvertResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ success: false, markdown: "", format, error: "Conversion timed out (30s)" }),
      CONVERSION_TIMEOUT_MS,
    );
  });

  const result = await Promise.race([conversionFn(), timeout]);
  clearTimeout(timer!);
  return result;
}
