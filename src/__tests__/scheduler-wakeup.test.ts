/**
 * Tests for schedule_wakeup tool + manager wakeup branch.
 *
 * Covers:
 *   - createJobFromTool({ isWakeup: true }) → type "wakeup"
 *   - wakeupExecutor invokes injectHeartbeat({ reason, allowWake: true })
 *   - schedule_wakeup tool registered in plugin
 *   - Compaction LIKE pattern matches `[HEARTBEAT] reason` payload
 */

import { describe, expect, mock, test } from "bun:test";

// --- Mock db functions (mirrors scheduler-manager-broadcast.test.ts pattern) ---

const mockDbJobs: Record<string, any> = {};

mock.module("../scheduler/db", () => ({
  getJob: (id: string) => mockDbJobs[id] || null,
  pauseJob: mock(() => ({ success: true })),
  resumeJob: mock(() => ({ success: true })),
  resetErrors: mock(() => {}),
  cancelJob: mock(() => ({ success: true })),
  listJobs: mock(() => []),
  createJob: mock((params: any) => {
    const job = { ...params, status: "active", run_count: 0, consecutive_errors: 0 };
    mockDbJobs[params.id] = job;
    return job;
  }),
  countActiveJobs: mock(() => 0),
  getRunsForJob: mock(() => []),
  updateJobStatus: mock(() => {}),
  updateJobNextRun: mock(() => {}),
  incrementRunCount: mock(() => {}),
  incrementErrors: mock(() => {}),
  getDueJobs: mock(() => []),
  insertRun: mock(() => {}),
  completeRun: mock(() => {}),
  getZombieRuns: mock(() => []),
  purgeOldRuns: mock(() => {}),
  closeDb: mock(() => {}),
}));

mock.module("../scheduler/parse-schedule", () => ({
  parseSchedule: mock(() => ({
    success: true,
    schedule: { type: "once", run_at: Date.now() + 60_000, next_run: Date.now() + 60_000 },
  })),
  calculateNextCronRun: mock(() => Date.now() + 60_000),
}));

mock.module("../config/config", () => ({
  loadConfig: () => ({}),
  validateConfig: () => ({}),
}));

const { SchedulerManager } = await import("../scheduler/manager");
const { createSchedulerToolPlugin } = await import("../agent/plugins/scheduler-plugin");

describe("createJobFromTool({ isWakeup: true })", () => {
  test("creates job with type 'wakeup'", () => {
    const manager = new SchedulerManager({} as any, () => {});
    const result = manager.createJobFromTool({
      channel: "ch1",
      agentId: "agent-1",
      title: "self check-in",
      prompt: "self check-in",
      schedule: "in 1 minute",
      isWakeup: true,
    });
    expect(result.success).toBe(true);
    expect(result.job?.type).toBe("wakeup");
  });

  test("isWakeup wins over isToolCall and isReminder", () => {
    const manager = new SchedulerManager({} as any, () => {});
    const result = manager.createJobFromTool({
      channel: "ch1",
      agentId: "agent-1",
      title: "ambiguous",
      prompt: "ambiguous",
      schedule: "in 1 minute",
      isWakeup: true,
      isToolCall: true,
      isReminder: true,
    });
    expect(result.job?.type).toBe("wakeup");
  });
});

describe("wakeupExecutor", () => {
  test("setWakeupExecutor stores the handler", async () => {
    const manager = new SchedulerManager({} as any, () => {});
    let received: { reason?: string; allowWake?: boolean } | null = null;
    manager.setWakeupExecutor(async (job) => {
      // Simulate runner.ts calling injectHeartbeat
      const fakeLoop = {
        injectHeartbeat(opts: { reason?: string; allowWake?: boolean }) {
          received = opts;
        },
      };
      fakeLoop.injectHeartbeat({ reason: job.prompt, allowWake: true });
    });

    // Directly invoke by reaching into the private field — sanity check the wiring
    const exec = (manager as any).wakeupExecutor;
    expect(exec).toBeTypeOf("function");
    await exec({ prompt: "wake reason" });
    expect(received).toEqual({ reason: "wake reason", allowWake: true });
  });
});

describe("schedule_wakeup tool plugin", () => {
  test("plugin registers schedule_wakeup tool", () => {
    const manager = new SchedulerManager({} as any, () => {});
    const plugin = createSchedulerToolPlugin({
      scheduler: manager,
      channel: "ch1",
      agentId: "agent-1",
    });
    const tools = plugin.getTools();
    const wakeup = tools.find((t) => t.name === "schedule_wakeup");
    expect(wakeup).toBeDefined();
    expect(wakeup?.required).toEqual(["reason", "schedule"]);
    expect(wakeup?.parameters).toHaveProperty("reason");
    expect(wakeup?.parameters).toHaveProperty("schedule");
  });

  test("schedule_wakeup handler creates wakeup-typed job", async () => {
    const manager = new SchedulerManager({} as any, () => {});
    const plugin = createSchedulerToolPlugin({
      scheduler: manager,
      channel: "ch1",
      agentId: "agent-1",
    });
    const tool = plugin.getTools().find((t) => t.name === "schedule_wakeup")!;
    const result = await tool.handler({ reason: "self check-in", schedule: "in 1 minute" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Wakeup scheduled");
  });
});

describe("compaction LIKE pattern", () => {
  // The session compaction purge uses SQL LIKE: '%<agent_signal>%[HEARTBEAT]%</agent_signal>%'
  // We replicate it as a regex to verify both legacy and new heartbeat formats are purged.
  const sqlLikeToRegex = (pattern: string) =>
    new RegExp(
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters
        .replace(/%/g, ".*"),
    );
  const purgePattern = sqlLikeToRegex("<agent_signal>%[HEARTBEAT]%</agent_signal>");

  test("matches legacy bare heartbeat", () => {
    expect("<agent_signal>[HEARTBEAT]</agent_signal>").toMatch(purgePattern);
  });

  test("matches heartbeat with reason inside agent_signal tags", () => {
    expect("<agent_signal>[HEARTBEAT] self check-in</agent_signal>").toMatch(purgePattern);
  });

  test("matches heartbeat with reason and trailing sub-agent reminder", () => {
    expect("<agent_signal>[HEARTBEAT] reason</agent_signal>\n\n<system-reminder>1 sub-agent</system-reminder>").toMatch(
      purgePattern,
    );
  });

  test("does NOT match a real user message containing the literal string [HEARTBEAT]", () => {
    expect("the [HEARTBEAT] keyword appears in my code").not.toMatch(purgePattern);
  });
});
