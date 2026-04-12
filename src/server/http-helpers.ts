/**
 * Shared HTTP utilities for server route handlers.
 */

/** Build Content-Disposition header value safe for non-ASCII filenames (RFC 5987) */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  // ASCII-only fallback: replace non-ASCII and unsafe chars with underscores
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\r\n\\]/g, "_");
  // Check if filename is pure ASCII
  const isPureAscii = /^[\x20-\x7E]+$/.test(name);
  if (isPureAscii) {
    return `${type}; filename="${asciiFallback}"`;
  }
  // RFC 5987: filename* with UTF-8 percent-encoding for non-ASCII
  const encoded = encodeURIComponent(name).replace(/'/g, "%27");
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function parseBody(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return (await req.json()) as Record<string, any>;
    } catch {
      throw new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const result: Record<string, any> = {};
    formData.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return {};
}
