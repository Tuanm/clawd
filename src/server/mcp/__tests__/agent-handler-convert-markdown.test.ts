/**
 * Unit tests for the `convert_to_markdown` branch in agent-handler.ts.
 *
 * Guards the path-routing contract: converted Markdown MUST land under
 * `{projectRoot}/.clawd/files/` (injected via `_project_root`) and MUST NOT
 * leak into `~/.clawd/files/` (which pools outputs across every project the
 * user touches).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks: db, messaging, websocket — the HTTP handler imports these eagerly ──
mock.module("../../database", () => ({
  db: { query: () => ({ get: () => null, all: () => [] }), run: () => {} },
  getAgent: () => null,
  generateId: () => "Fxxx",
  generateTs: () => "0.0",
  ATTACHMENTS_DIR: "/tmp/attachments",
  getMessageSeenBy: () => [],
  markMessagesSeen: () => {},
  toSlackMessage: (m: unknown) => m,
  preparedStatements: {},
}));

mock.module("../../routes/messages", () => ({
  postMessage: () => ({ ok: true, ts: "0" }),
  getPendingMessages: () => [],
  getConversationHistory: () => ({ messages: [] }),
  deleteMessage: () => ({ ok: true }),
  updateMessage: () => ({ ok: true }),
  appendMessage: () => ({ ok: true }),
}));

mock.module("../../routes/files", () => ({
  getFile: () => null,
  attachFilesToMessage: () => [],
  getOptimizedFile: () => null,
}));

mock.module("../../websocket", () => ({
  broadcastUpdate: () => {},
  broadcastMessage: () => {},
  broadcastMessageSeen: () => {},
}));

mock.module("../shared", () => ({
  _scheduler: null,
  _workerManager: null,
}));

// Stub document-converter so the test doesn't depend on PDF/DOCX toolchains.
const MARKDOWN_OUTPUT = "# Hello\nThis is a converted document.";
mock.module("../../../agent/tools/document-converter", () => ({
  convertToMarkdown: async () => ({
    success: true,
    format: "pdf",
    markdown: MARKDOWN_OUTPUT,
  }),
}));

// Stub agents route so _project_root injection works without a real DB row.
mock.module("../../routes/agents", () => ({
  getAgentProjectRoot: () => null,
}));

const { handleAgentMcpRequest } = await import("../agent-handler");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(toolName: string, args: Record<string, unknown>) {
  return new Request("http://localhost/mcp/agent/test/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

async function callTool(toolName: string, args: Record<string, unknown>) {
  const res = await handleAgentMcpRequest(makeRequest(toolName, args), "test", "agent");
  const json = (await res.json()) as { result: { content: { text: string }[] } };
  return json.result.content[0].text;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("convert_to_markdown path routing", () => {
  let tmpProjectRoot: string;
  let sourceFile: string;

  beforeEach(() => {
    tmpProjectRoot = mkdtempSync(join(tmpdir(), "clawd-convert-test-"));
    // The handler only reads `args.path` to derive the output basename — the
    // source file doesn't need real content because convertToMarkdown is mocked.
    sourceFile = join(tmpProjectRoot, "source.pdf");
  });

  test("saves converted markdown under {_project_root}/.clawd/files/", async () => {
    const text = await callTool("convert_to_markdown", {
      path: sourceFile,
      _project_root: tmpProjectRoot,
    });

    const expectedMdPath = join(tmpProjectRoot, ".clawd", "files", "source.md");
    expect(text).toContain(`Saved to: ${expectedMdPath}`);
    expect(existsSync(expectedMdPath)).toBe(true);
    expect(readFileSync(expectedMdPath, "utf-8")).toBe(MARKDOWN_OUTPUT);

    rmSync(tmpProjectRoot, { recursive: true, force: true });
  });

  test("does NOT write to homedir when _project_root is provided", async () => {
    const text = await callTool("convert_to_markdown", {
      path: sourceFile,
      _project_root: tmpProjectRoot,
    });

    // Must not mention ~/.clawd/files or the user's actual homedir anywhere
    // in the success message. The path routing is the whole point of this test.
    const home = process.env.HOME || "";
    expect(text).toContain(tmpProjectRoot);
    if (home) {
      const homeClawdPath = join(home, ".clawd", "files");
      expect(text).not.toContain(homeClawdPath);
    }

    rmSync(tmpProjectRoot, { recursive: true, force: true });
  });

  test("falls back to CWD when _project_root is missing (does NOT use homedir)", async () => {
    // No _project_root — handler must fall back to process.cwd(), NOT homedir.
    const text = await callTool("convert_to_markdown", {
      path: sourceFile,
    });

    const cwdFilesDir = join(process.cwd(), ".clawd", "files");
    const expectedMdPath = join(cwdFilesDir, "source.md");
    expect(text).toContain(`Saved to: ${expectedMdPath}`);

    // Cleanup: remove just the file we created, not the whole `.clawd/` tree
    // (other tests or the host repo may legitimately own sibling entries).
    rmSync(expectedMdPath, { force: true });
    rmSync(tmpProjectRoot, { recursive: true, force: true });
  });
});
