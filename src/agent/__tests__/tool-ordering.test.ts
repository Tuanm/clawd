/**
 * Tests for `partitionAndOrderTools` — the helper that orders tools so an
 * Anthropic `cache_control` breakpoint can be placed on the last alwaysInclude
 * tool, giving a small stable cached prefix that survives transitions between
 * the warmup, steady-state, and re-expansion filter states.
 *
 * Invariants verified:
 *   1. Partition: alwaysInclude tools come first, others after.
 *   2. Sort: each subset is alphabetical by tool.function.name.
 *   3. cacheBreakpoint flag: marked on last alwaysInclude tool only (or none if empty).
 *   4. Source mutation: the input tools are NOT mutated (shallow-copy on the marker).
 *   5. Prefix-byte stability: serialised bytes up through the breakpoint are
 *      byte-identical across distinct kept-subsets that share the same
 *      alwaysInclude membership.
 *   6. Empty / single-element / all-stable / all-variable edge cases.
 */

import { describe, expect, test } from "bun:test";
import { Agent, partitionAndOrderTools } from "../agent";
import type { ToolDefinition } from "../api/types";

// Single source of truth — imported from Agent so the test never drifts from prod.
const ALWAYS_INCLUDE: ReadonlySet<string> = Agent.ALWAYS_INCLUDE_TOOLS;

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `desc-${name}`,
      parameters: { type: "object", properties: {} },
    },
    ...extra,
  };
}

describe("partitionAndOrderTools", () => {
  test("empty input returns same array (no allocation, no flag)", () => {
    const empty: ToolDefinition[] = [];
    const out = partitionAndOrderTools(empty, ALWAYS_INCLUDE);
    expect(out).toBe(empty);
    expect(out.length).toBe(0);
  });

  test("partitions alwaysInclude tools before others", () => {
    // Mixed input with deliberately scrambled order
    const input = [
      tool("view"),
      tool("reply"),
      tool("git_status"),
      tool("complete_task"),
      tool("bash"),
      tool("spawn_agent"),
    ];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    const names = out.map((t) => t.function.name);
    // Stable subset (sorted): complete_task, reply, spawn_agent
    // Variable subset (sorted): bash, git_status, view
    expect(names).toEqual(["complete_task", "reply", "spawn_agent", "bash", "git_status", "view"]);
  });

  test("alphabetical sort within each subset", () => {
    const input = [
      tool("view"),
      tool("bash"),
      tool("grep"),
      tool("reply"),
      tool("knowledge_search"),
      tool("complete_task"),
    ];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    const names = out.map((t) => t.function.name);
    // Stable: complete_task, knowledge_search, reply
    // Variable: bash, grep, view
    expect(names).toEqual(["complete_task", "knowledge_search", "reply", "bash", "grep", "view"]);
  });

  test("marks cacheBreakpoint on last alwaysInclude tool only", () => {
    const input = [tool("view"), tool("reply"), tool("complete_task"), tool("bash")];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    // Stable sorted: complete_task (idx 0), reply (idx 1) ← last stable
    // Variable sorted: bash (idx 2), view (idx 3)
    expect(out[0].function.name).toBe("complete_task");
    expect(out[0].cacheBreakpoint).toBeUndefined();
    expect(out[1].function.name).toBe("reply");
    expect(out[1].cacheBreakpoint).toBe(true);
    expect(out[2].function.name).toBe("bash");
    expect(out[2].cacheBreakpoint).toBeUndefined();
    expect(out[3].function.name).toBe("view");
    expect(out[3].cacheBreakpoint).toBeUndefined();
  });

  test("no alwaysInclude tools → no cacheBreakpoint marker", () => {
    const input = [tool("view"), tool("bash"), tool("grep")];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    for (const t of out) {
      expect(t.cacheBreakpoint).toBeUndefined();
    }
    expect(out.map((t) => t.function.name)).toEqual(["bash", "grep", "view"]);
  });

  test("only alwaysInclude tools → flag on last stable, no variable section", () => {
    const input = [tool("reply"), tool("complete_task"), tool("spawn_agent")];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    // Sorted: complete_task, reply, spawn_agent
    expect(out.map((t) => t.function.name)).toEqual(["complete_task", "reply", "spawn_agent"]);
    expect(out[0].cacheBreakpoint).toBeUndefined();
    expect(out[1].cacheBreakpoint).toBeUndefined();
    expect(out[2].cacheBreakpoint).toBe(true);
  });

  test("does NOT mutate input array or input ToolDefinitions", () => {
    const replyTool = tool("reply");
    const input = [tool("view"), replyTool, tool("bash"), tool("complete_task")];
    const inputSnapshot = [...input];
    const out = partitionAndOrderTools(input, ALWAYS_INCLUDE);

    // Input array unchanged (order preserved)
    expect(input).toEqual(inputSnapshot);
    expect(input[1]).toBe(replyTool);

    // Output's marked tool is a SHALLOW COPY, not the original
    const lastStable = out.find((t) => t.cacheBreakpoint === true);
    expect(lastStable!.function.name).toBe("reply");
    expect(lastStable).not.toBe(replyTool); // shallow-copied
    expect(replyTool.cacheBreakpoint).toBeUndefined(); // source preserved
  });

  test("prefix-byte stability: same alwaysInclude subset across different kept-supersets", () => {
    // Simulate three filter states for the SAME agent run:
    //   - warmup: all tools
    //   - steady: alwaysInclude + a few used
    //   - re-expansion: same as warmup
    const allTools = [
      tool("view"),
      tool("reply"),
      tool("git_status"),
      tool("complete_task"),
      tool("bash"),
      tool("spawn_agent"),
      tool("list_agents"),
      tool("knowledge_search"),
      tool("skill_activate"),
      tool("skill_search"),
      tool("grep"),
      tool("edit"),
    ];
    const steadySubset = [
      tool("reply"),
      tool("complete_task"),
      tool("spawn_agent"),
      tool("list_agents"),
      tool("knowledge_search"),
      tool("skill_activate"),
      tool("skill_search"),
      tool("bash"), // a tool that was used
    ];

    const warmupOut = partitionAndOrderTools(allTools, ALWAYS_INCLUDE);
    const steadyOut = partitionAndOrderTools(steadySubset, ALWAYS_INCLUDE);
    const reexpandOut = partitionAndOrderTools(allTools, ALWAYS_INCLUDE);

    // Find breakpoint indices in each
    const findBp = (out: ToolDefinition[]) => out.findIndex((t) => t.cacheBreakpoint === true);
    const bpWarmup = findBp(warmupOut);
    const bpSteady = findBp(steadyOut);
    const bpReexpand = findBp(reexpandOut);

    expect(bpWarmup).toBeGreaterThanOrEqual(0);
    expect(bpSteady).toBeGreaterThanOrEqual(0);
    expect(bpReexpand).toBeGreaterThanOrEqual(0);

    // The byte prefix UP TO AND INCLUDING the breakpoint must be byte-identical
    // across all three states (since alwaysInclude membership is the same).
    // Note: the cacheBreakpoint marker itself is internal-only and stripped
    // before serialisation, so we serialise without it.
    const stripMarker = (t: ToolDefinition) => {
      const { cacheBreakpoint: _cb, ...rest } = t;
      return rest;
    };
    const prefixBytes = (out: ToolDefinition[], bpIdx: number) =>
      JSON.stringify(out.slice(0, bpIdx + 1).map(stripMarker));

    const pw = prefixBytes(warmupOut, bpWarmup);
    const ps = prefixBytes(steadyOut, bpSteady);
    const pr = prefixBytes(reexpandOut, bpReexpand);

    expect(pw).toBe(ps);
    expect(ps).toBe(pr);
  });

  test("sub-agent path: alwaysInclude minus reply still works", () => {
    // Sub-agent forks strip "reply" + chat tools. Verify the helper still
    // marks the next-best last alwaysInclude tool.
    const subAgentSet = [
      tool("complete_task"),
      tool("spawn_agent"),
      tool("list_agents"),
      tool("knowledge_search"),
      tool("skill_activate"),
      tool("skill_search"),
      tool("bash"),
      tool("view"),
    ];
    const out = partitionAndOrderTools(subAgentSet, ALWAYS_INCLUDE);
    const names = out.map((t) => t.function.name);
    // Stable sorted (no reply): complete_task, knowledge_search, list_agents,
    //                            skill_activate, skill_search, spawn_agent
    // Variable sorted: bash, view
    expect(names).toEqual([
      "complete_task",
      "knowledge_search",
      "list_agents",
      "skill_activate",
      "skill_search",
      "spawn_agent",
      "bash",
      "view",
    ]);
    // breakpoint on last stable = "spawn_agent"
    expect(out[5].function.name).toBe("spawn_agent");
    expect(out[5].cacheBreakpoint).toBe(true);
  });

  test("preserves all non-name ToolDefinition fields on shallow-copy", () => {
    const replyTool: ToolDefinition = {
      type: "function",
      readOnly: true,
      function: {
        name: "reply",
        description: "Send a reply",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    };
    const out = partitionAndOrderTools([replyTool, tool("view")], ALWAYS_INCLUDE);
    const marked = out[0];
    expect(marked.function.name).toBe("reply");
    expect(marked.cacheBreakpoint).toBe(true);
    expect(marked.readOnly).toBe(true);
    expect(marked.function.description).toBe("Send a reply");
    expect(marked.function.parameters).toEqual(replyTool.function.parameters);
  });

  test("idempotent on already-marked input (re-running partition)", () => {
    // If partitionAndOrderTools runs twice (theoretically, e.g. on a second
    // filter pass), the second pass should produce equivalent output.
    const input = [tool("view"), tool("reply"), tool("bash"), tool("complete_task")];
    const first = partitionAndOrderTools(input, ALWAYS_INCLUDE);
    const second = partitionAndOrderTools(first, ALWAYS_INCLUDE);

    const stripMarker = (out: ToolDefinition[]) => out.map(({ cacheBreakpoint: _cb, ...rest }) => rest);
    expect(stripMarker(first)).toEqual(stripMarker(second));

    // Breakpoint should still be on the same logical tool ("reply" is last stable)
    const firstBp = first.findIndex((t) => t.cacheBreakpoint === true);
    const secondBp = second.findIndex((t) => t.cacheBreakpoint === true);
    expect(first[firstBp].function.name).toBe(second[secondBp].function.name);
  });
});
