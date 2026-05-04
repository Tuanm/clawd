/**
 * Byte-equivalence test for src/embedded/ui.ts.
 *
 * Pinned ahead of the base64→Bun-embed swap (perf opt #8) so we can prove
 * the new implementation streams the IDENTICAL bytes for every one of the
 * 119 UI assets. The test compares what `getEmbeddedAsset(path)` returns —
 * routed through `new Response(asset.content)`, the exact wrapper
 * `serveStatic` uses — against the source-of-truth bytes on disk in
 * packages/ui/dist/.
 *
 * If packages/ui/dist is absent (e.g. minimal CI image), the test skips
 * with a warning. The embed script requires it, so any environment that
 * regenerates ui.ts will have the source available.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { embeddedUIFileCount, embeddedUITotalSize, getEmbeddedAsset, hasEmbeddedUI } from "../embedded/ui";

// Pick any .js file from the manifest (deterministic — first one alphabetically).
function findJsAssetPath(): string | null {
  if (!existsSync(UI_DIST)) return null;
  const files = readdirSync(join(UI_DIST, "assets"))
    .filter((f) => f.endsWith(".js"))
    .sort();
  return files[0] ? `/assets/${files[0]}` : null;
}

const UI_DIST = join(import.meta.dir, "..", "..", "packages", "ui", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function expectedMime(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const distAvailable = existsSync(UI_DIST);

describe("embedded UI byte equivalence", () => {
  test("hasEmbeddedUI flag matches generated state", () => {
    expect(hasEmbeddedUI).toBe(true);
  });

  test.skipIf(!distAvailable)("file count matches packages/ui/dist", () => {
    const diskFiles = walk(UI_DIST);
    expect(embeddedUIFileCount).toBe(diskFiles.length);
  });

  test.skipIf(!distAvailable)("embeddedUITotalSize equals sum of disk file sizes (manifest drift guard)", () => {
    const diskFiles = walk(UI_DIST);
    const expected = diskFiles.reduce((acc, f) => acc + statSync(f).size, 0);
    expect(embeddedUITotalSize).toBe(expected);
  });

  test.skipIf(!distAvailable)(
    "every disk file is reachable through getEmbeddedAsset with byte-equal content + correct mimeType",
    async () => {
      const diskFiles = walk(UI_DIST);
      expect(diskFiles.length).toBeGreaterThan(0);

      const mismatches: string[] = [];

      for (const filePath of diskFiles) {
        const relPath = "/" + relative(UI_DIST, filePath).split("\\").join("/");
        const diskBytes = readFileSync(filePath);
        const diskSha = sha256(diskBytes);
        const wantMime = expectedMime(filePath);

        const asset = getEmbeddedAsset(relPath);
        if (!asset) {
          mismatches.push(`${relPath}: getEmbeddedAsset returned null`);
          continue;
        }

        // Route through Response to mirror the production hot path in
        // serveStatic — this works whether asset.content is Buffer (current)
        // or BunFile (post-#8). If a future implementation breaks Response
        // compatibility, this test catches it.
        const response = new Response(asset.content as BodyInit);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const gotSha = sha256(bytes);

        if (gotSha !== diskSha) {
          mismatches.push(
            `${relPath}: sha mismatch (disk=${diskSha} got=${gotSha} sizes ${diskBytes.length}/${bytes.length})`,
          );
        }
        if (asset.mimeType !== wantMime) {
          mismatches.push(`${relPath}: mime mismatch (want=${wantMime} got=${asset.mimeType})`);
        }
      }

      if (mismatches.length > 0) {
        throw new Error(`Byte-equivalence failures (${mismatches.length}):\n${mismatches.slice(0, 10).join("\n")}`);
      }
    },
  );

  test("getEmbeddedAsset returns null for unknown path", () => {
    expect(getEmbeddedAsset("/does-not-exist.html")).toBeNull();
  });

  test.skipIf(!distAvailable)(
    "Bun.serve injects content-disposition filename on application/javascript BunFile responses; explicit `inline` override suppresses it (pins serveStatic's fix)",
    async () => {
      // Bun's content-disposition auto-injection only triggers at
      // Bun.serve-send time (NOT at `new Response(...)` construction), and
      // only when the user-supplied Content-Type is application/javascript
      // for a BunFile body — text/javascript (Bun's default for .js) does
      // not trigger it. serveStatic supplies application/javascript from
      // the embed-ui generator's MIME_TYPES table, so the injection IS
      // active in production. This test pins that behavior + proves the
      // `Content-Disposition: inline` override in serveStatic is real and
      // load-bearing rather than passthrough noise.
      const jsPath = findJsAssetPath();
      if (!jsPath) throw new Error("no .js asset found in packages/ui/dist/assets");
      const asset = getEmbeddedAsset(jsPath);
      if (!asset) throw new Error(`getEmbeddedAsset(${jsPath}) returned null`);

      // Serve WITHOUT override — Bun auto-injects `filename="..."`.
      const bareServer = Bun.serve({
        port: 0,
        fetch: () => new Response(asset.content as BodyInit, { headers: { "Content-Type": asset.mimeType } }),
      });
      try {
        const bareResp = await fetch(`http://127.0.0.1:${bareServer.port}/`);
        expect(bareResp.headers.get("content-disposition") ?? "").toMatch(/filename=/);
        await bareResp.body?.cancel();
      } finally {
        bareServer.stop();
      }

      // Serve WITH override — should be exactly "inline", no filename.
      const overrideServer = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(asset.content as BodyInit, {
            headers: { "Content-Type": asset.mimeType, "Content-Disposition": "inline" },
          }),
      });
      try {
        const overrideResp = await fetch(`http://127.0.0.1:${overrideServer.port}/`);
        expect(overrideResp.headers.get("content-disposition")).toBe("inline");
        await overrideResp.body?.cancel();
      } finally {
        overrideServer.stop();
      }
    },
  );
});
