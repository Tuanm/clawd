/**
 * Tests for scheduler tool definitions (§1.5)
 *
 * Verifies that scheduler_pause and scheduler_resume tool definitions
 * exist with correct structure alongside existing scheduler tools.
 *
 * Uses bun:test.
 */

import { describe, expect, test } from "bun:test";

// Import the tool definitions directly
// The file exports an array of tool definitions
import { MCP_TOOLS as allToolDefinitions } from "../../server/mcp/tool-defs";

describe("Scheduler Tool Definitions", () => {
  const schedulerTools = allToolDefinitions.filter((t: any) => t.name.startsWith("scheduler_"));

  test("has all 6 scheduler tools", () => {
    const names = schedulerTools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "scheduler_cancel",
      "scheduler_create",
      "scheduler_history",
      "scheduler_list",
      "scheduler_pause",
      "scheduler_resume",
    ]);
  });

  test("scheduler_pause has correct structure", () => {
    const tool = schedulerTools.find((t: any) => t.name === "scheduler_pause");
    expect(tool).toBeDefined();
    expect(tool.description).toContain("Pause");
    expect(tool.inputSchema.properties.id).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["id"]);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  test("scheduler_resume has correct structure", () => {
    const tool = schedulerTools.find((t: any) => t.name === "scheduler_resume");
    expect(tool).toBeDefined();
    expect(tool.description).toContain("Resume");
    expect(tool.description).toContain("error count");
    expect(tool.inputSchema.properties.id).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["id"]);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  test("scheduler_pause is positioned after scheduler_cancel", () => {
    const cancelIdx = allToolDefinitions.findIndex((t: any) => t.name === "scheduler_cancel");
    const pauseIdx = allToolDefinitions.findIndex((t: any) => t.name === "scheduler_pause");
    const resumeIdx = allToolDefinitions.findIndex((t: any) => t.name === "scheduler_resume");
    const historyIdx = allToolDefinitions.findIndex((t: any) => t.name === "scheduler_history");

    expect(cancelIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBe(cancelIdx + 1);
    expect(resumeIdx).toBe(cancelIdx + 2);
    expect(historyIdx).toBe(cancelIdx + 3);
  });
});
