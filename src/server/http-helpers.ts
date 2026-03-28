/**
 * Shared HTTP utilities for server route handlers.
 */

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
    return (await req.json()) as Record<string, any>;
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
