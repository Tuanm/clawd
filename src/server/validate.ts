/**
 * Request body validation helper using Zod.
 *
 * Usage:
 *   const v = validateBody(MySchema, body);
 *   if (!v.ok) return v.error;
 *   // v.data is typed
 */

import type { ZodSchema } from "zod";

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: Response };

export function validateBody<T>(schema: ZodSchema<T>, body: unknown): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      error: new Response(JSON.stringify({ error: "validation failed", issues: result.error.issues }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true, data: result.data };
}
