/**
 * Regression guards for the embedded browser-extension zip.
 *
 * 1. Path normalization (APPNOTE.TXT 4.4.17.1) — entry names must use `/`,
 *    not `\`, otherwise Linux/macOS unzip treats them as a single flat
 *    segment and the extension loader breaks. Pinned after the Phase D
 *    HIGH fix in embed-ui.ts surfaced the same defect class.
 * 2. Byte equivalence — pinned ahead of the base64→Bun-embed swap so we can
 *    prove the new file-import implementation streams the IDENTICAL bytes
 *    as the source-of-truth zip on disk in dist/browser-extension.zip.
 *
 * The embedded module is gitignored / generated, so the byte-equivalence
 * tests skip when the on-disk zip is absent.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

const EMBEDDED_PATH = join(import.meta.dir, "..", "embedded", "extension.ts");
const embedded = existsSync(EMBEDDED_PATH);
const DISK_ZIP_PATH = join(import.meta.dir, "..", "..", "dist", "browser-extension.zip");
const diskAvailable = existsSync(DISK_ZIP_PATH);

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("embedded extension zip", () => {
  test.skipIf(!embedded)("every zip entry uses POSIX `/` separators (no `\\`)", async () => {
    const { getExtensionZip, extensionZipSize } = await import("../embedded/extension");
    // Route through Response — mirrors the production hot path in
    // src/index.ts where the zip is served via `new Response(blob)`. Works
    // whether getExtensionZip returns Buffer (legacy) or Blob (post-#83).
    const blob = getExtensionZip();
    const bytes = new Uint8Array(await new Response(blob as BodyInit).arrayBuffer());
    expect(bytes.length).toBe(extensionZipSize);

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names.length).toBeGreaterThan(0);

    const offenders = names.filter((n) => n.includes("\\"));
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} zip entries contain backslashes (PKZIP spec violation):\n${offenders.slice(0, 5).join("\n")}`,
      );
    }

    // Belt-and-braces: at least one entry must be in a subdirectory, otherwise
    // the test is vacuously true on a single-file extension.
    const nested = names.some((n) => n.includes("/"));
    expect(nested).toBe(true);
  });

  test.skipIf(!embedded || !diskAvailable)(
    "streams byte-identical content to dist/browser-extension.zip on disk",
    async () => {
      const { getExtensionZip, extensionZipSize } = await import("../embedded/extension");
      const diskBytes = readFileSync(DISK_ZIP_PATH);
      const diskSha = sha256(diskBytes);
      expect(diskBytes.length).toBe(extensionZipSize);

      const blob = getExtensionZip();
      const responseBytes = new Uint8Array(await new Response(blob as BodyInit).arrayBuffer());
      const responseSha = sha256(responseBytes);

      if (responseSha !== diskSha) {
        throw new Error(
          `byte mismatch — disk=${diskSha} response=${responseSha} sizes ${diskBytes.length}/${responseBytes.length}`,
        );
      }
    },
  );

  test.skipIf(!embedded)("generated module header has no timestamp (byte-reproducibility guard)", () => {
    // Same property as embedded-ui-bytes.test.ts: identical inputs must
    // produce identical compiled binaries (SLSA / attestation / cache hits).
    // Catches `new Date().toISOString()` / UUID / counter slipping into the
    // generator output.
    const head = readFileSync(EMBEDDED_PATH, "utf-8").slice(0, 4096);
    expect(head).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(head).not.toMatch(/Generated at:/);
  });
});
