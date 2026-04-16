/**
 * Tests for scheduler manager broadcast additions (§1.2)
 *
 * Strategy: Mock db functions, create SchedulerManager with mock broadcast,
 * verify broadcast is called on success and NOT on failure.
 *
 * Uses bun:test.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mock db functions ---

let mockDbJobs: Record<string, any> = {};
let mockPauseResult = { success: true };
let mockResumeResult = { success: true };

mock.module("../../scheduler/db", () => ({
  getJob: (id: string) => mockDbJobs[id] || null,
  pauseJob: mock(() => mockPauseResult),
  resumeJob: mock(() => mockResumeResult),
  resetErrors: mock(() => {}),
  cancelJob: mock(() => ({ success: true })),
  listJobs: mock(() => []),
  createJob: mock((params: any) => params),
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

// Mock parseSchedule
mock.module("../../scheduler/parse-schedule", () => ({
  parseSchedule: mock(() => ({
    success: true,
    schedule: { type: "interval", interval_ms: 300000, next_run: Date.now() + 300000 },
  })),
  calculateNextCronRun: mock(() => Date.now() + 300000),
}));

// Mock config
mock.module("../../config/config", () => ({
  loadConfig: () => ({}),
  validateConfig: () => ({}),
}));

const { SchedulerManager } = await import("../../scheduler/manager");

describe("SchedulerManager broadcast additions", () => {
  let broadcastCalls: Array<{ channel: string; event: any }>;
  let broadcastFn: (channel: string, event: any) => void;
  let manager: InstanceType<typeof SchedulerManager>;

  beforeEach(() => {
    broadcastCalls = [];
    broadcastFn = (channel: string, event: any) => {
      broadcastCalls.push({ channel, event });
    };
    mockDbJobs = {};
    mockPauseResult = { success: true };
    mockResumeResult = { success: true };
    manager = new SchedulerManager({} as any, broadcastFn);
  });

  describe("pauseJobFromTool", () => {
    test("broadcasts on successful pause", () => {
      mockDbJobs["job-1"] = { id: "job-1", channel: "ch1", title: "Test Job", status: "active" };
      mockPauseResult = { success: true };

      const result = manager.pauseJobFromTool("job-1", "agent-1", "ch1");

      expect(result.success).toBe(true);
      expect(result.title).toBe("Test Job");
      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].channel).toBe("ch1");
      expect(broadcastCalls[0].event.type).toBe("scheduler_event");
      expect(broadcastCalls[0].event.event).toBe("paused");
      expect(broadcastCalls[0].event.job_id).toBe("job-1");
      expect(broadcastCalls[0].event.title).toBe("Test Job");
    });

    test("does NOT broadcast on failed pause", () => {
      mockDbJobs["job-1"] = { id: "job-1", channel: "ch1", title: "Test Job", status: "paused" };
      mockPauseResult = { success: false, error: "Already paused" };

      const result = manager.pauseJobFromTool("job-1", "agent-1", "ch1");

      expect(result.success).toBe(false);
      expect(broadcastCalls).toHaveLength(0);
    });

    test("returns error when job not found", () => {
      const result = manager.pauseJobFromTool("missing", "agent-1", "ch1");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Job not found");
      expect(broadcastCalls).toHaveLength(0);
    });
  });

  describe("resumeJobFromTool", () => {
    test("broadcasts on successful resume", () => {
      mockDbJobs["job-1"] = { id: "job-1", channel: "ch1", title: "Test Job", status: "paused" };
      mockResumeResult = { success: true };

      const result = manager.resumeJobFromTool("job-1", "agent-1", "ch1");

      expect(result.success).toBe(true);
      expect(result.title).toBe("Test Job");
      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].channel).toBe("ch1");
      expect(broadcastCalls[0].event.type).toBe("scheduler_event");
      expect(broadcastCalls[0].event.event).toBe("resumed");
      expect(broadcastCalls[0].event.job_id).toBe("job-1");
      expect(broadcastCalls[0].event.title).toBe("Test Job");
    });

    test("does NOT broadcast on failed resume", () => {
      mockDbJobs["job-1"] = { id: "job-1", channel: "ch1", title: "Test Job", status: "active" };
      mockResumeResult = { success: false, error: "Not paused" };

      const result = manager.resumeJobFromTool("job-1", "agent-1", "ch1");

      expect(result.success).toBe(false);
      expect(broadcastCalls).toHaveLength(0);
    });

    test("returns error when job not found", () => {
      const result = manager.resumeJobFromTool("missing", "agent-1", "ch1");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Job not found");
      expect(broadcastCalls).toHaveLength(0);
    });
  });
});
