/**
 * Regression guard for scripts/zip-extension.ts path normalization.
 *
 * The PKZIP spec (APPNOTE.TXT 4.4.17.1) mandates forward-slash separators
 * for entry names. On Windows-native generator runs, `path.relative()`
 * yields backslashes, which unpack as a single flat segment on Linux/macOS
 * and break the browser-extension loader.
 *
 * This test parses the already-embedded zip (the artifact that ships in
 * binaries) and asserts every entry name uses only `/`. Same defect class
 * as the Phase D embed-ui.ts HIGH fix.
 *
 * The embedded module is gitignored / generated, so the test skips when
 * `getExtensionZip` cannot resolve a buffer.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

const EMBEDDED_PATH = join(import.meta.dir, "..", "embedded", "extension.ts");
const embedded = existsSync(EMBEDDED_PATH);

describe("embedded extension zip path normalization", () => {
  test.skipIf(!embedded)("every zip entry uses POSIX `/` separators (no `\\`)", async () => {
    const { getExtensionZip, extensionZipSize } = await import("../embedded/extension");
    const buf = getExtensionZip();
    expect(buf.length).toBe(extensionZipSize);

    const zip = await JSZip.loadAsync(buf);
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
});
