/**
 * Byte-equivalence + reproducibility guards for src/embedded/cli.ts.
 *
 * Pinned ahead of the gzip+base64 → Bun-embed swap (perf opt #8 follow-up)
 * so we can prove the new file-import implementation streams the IDENTICAL
 * bytes as the source-of-truth cli.js shipped by @anthropic-ai/claude-agent-sdk.
 *
 * The compare path mirrors what production does: src/claude-code/sdk.ts uses
 * `readFileSync(cliRef)` to materialise the bytes before writing them to
 * ~/.clawd/bin/cli.js. We exercise THAT call shape (via cliRef) AND the
 * BunFile call shape (via getCliJsBlob → new Response → arrayBuffer), so a
 * future refactor that moves between the two doesn't silently regress.
 *
 * If node_modules/@anthropic-ai/claude-agent-sdk/cli.js is absent (e.g.
 * minimal CI image), the test skips. The embed script requires it, so any
 * environment that regenerates cli.ts will have the source available.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EMBEDDED_PATH = join(import.meta.dir, "..", "embedded", "cli.ts");
const embedded = existsSync(EMBEDDED_PATH);

const DISK_CLI_PATH = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
const diskAvailable = existsSync(DISK_CLI_PATH);

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("embedded cli.js byte equivalence", () => {
  test.skipIf(!embedded || !diskAvailable)("cliJsSize matches on-disk cli.js byte length", async () => {
    const { cliJsSize } = await import("../embedded/cli");
    const diskBytes = readFileSync(DISK_CLI_PATH);
    expect(cliJsSize).toBe(diskBytes.length);
  });

  test.skipIf(!embedded || !diskAvailable)(
    "readFileSync(cliRef) returns byte-identical content to disk (production extraction path)",
    async () => {
      const { cliRef } = await import("../embedded/cli");
      const diskBytes = readFileSync(DISK_CLI_PATH);
      const refBytes = readFileSync(cliRef);
      const diskSha = sha256(diskBytes);
      const refSha = sha256(refBytes);
      if (refSha !== diskSha) {
        throw new Error(
          `byte mismatch via readFileSync(cliRef) — disk=${diskSha} ref=${refSha} sizes ${diskBytes.length}/${refBytes.length}`,
        );
      }
    },
  );

  test.skipIf(!embedded || !diskAvailable)(
    "getCliJsBlob() round-trips byte-identical content to disk (BunFile/Response path)",
    async () => {
      const { getCliJsBlob } = await import("../embedded/cli");
      const diskBytes = readFileSync(DISK_CLI_PATH);
      const blob = getCliJsBlob();
      const responseBytes = new Uint8Array(await new Response(blob as BodyInit).arrayBuffer());
      const diskSha = sha256(diskBytes);
      const responseSha = sha256(responseBytes);
      if (responseSha !== diskSha) {
        throw new Error(
          `byte mismatch via getCliJsBlob — disk=${diskSha} response=${responseSha} sizes ${diskBytes.length}/${responseBytes.length}`,
        );
      }
    },
  );

  test.skipIf(!embedded)("generated module header has no timestamp (byte-reproducibility guard)", () => {
    // Identical inputs must produce identical compiled binaries
    // (SLSA / attestation / cache hits). Catches `new Date().toISOString()`
    // / UUID / counter slipping into the generator output.
    const head = readFileSync(EMBEDDED_PATH, "utf-8").slice(0, 4096);
    expect(head).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(head).not.toMatch(/Generated at:/);
  });

  test.skipIf(!embedded)("generated module is manifest-only (no embedded base64 string slab)", () => {
    // Pin the heap-cost win from #83: the legacy module materialised a 4.7MB
    // base64 const at parse time. The new module is ~1KB and references the
    // file via `with { type: "file" }`. Catches a regression where someone
    // re-introduces base64 emission or a giant string literal.
    const text = readFileSync(EMBEDDED_PATH, "utf-8");
    expect(text.length).toBeLessThan(8 * 1024);
    expect(text).toMatch(/with \{ type: "file" \}/);
    expect(text).not.toMatch(/CLI_JS_GZIP_BASE64/);
  });
});
