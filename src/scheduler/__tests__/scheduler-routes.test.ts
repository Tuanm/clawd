/**
 * Tests for scheduler REST API routes (src/server/routes/scheduler.ts)
 *
 * Strategy: Create a mock SchedulerManager with the methods used by routes,
 * then call the route handler directly with crafted Request/URL/path.
 *
 * Uses bun:test; no vitest imports.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the db imports used by the routes file
mock.module("../../scheduler/db", () => ({
  getJob: (id: string) => mockGetJob(id),
  getRunsForJob: (id: string, limit: number) => mockGetRunsForJob(id, limit),
}));

// We need to import AFTER mock.module
const { registerSchedulerRoutes } = await import("../../server/routes/scheduler");

// --- Mock state ---

let mockJobs: Record<string, any> = {};
let mockRuns: Record<string, any[]> = {};

const mockGetJob = (id: string) => mockJobs[id] || null;
const mockGetRunsForJob = (id: string, limit: number) => (mockRuns[id] || []).slice(0, limit);

// --- Mock SchedulerManager ---

function createMockScheduler(overrides: Record<string, any> = {}) {
  return {
    runningJobs: new Map<string, AbortController>(),
    listJobsForChannel: mock((channel: string) => {
      return Object.values(mockJobs).filter((j: any) => j.channel === channel);
    }),
    createJobFromTool: mock((params: any) => ({
      success: true,
      job: { id: "new-job-1", ...params, status: "active", type: "cron" },
    })),
    cancelJobFromTool: mock((id: string, agent: string, channel: string) => ({
      success: true,
    })),
    pauseJobFromTool: mock((id: string, agent: string, channel: string) => ({
      success: true,
    })),
    resumeJobFromTool: mock((id: string, agent: string, channel: string) => ({
      success: true,
    })),
    ...overrides,
  };
}

// --- Helpers ---

function makeRequest(method: string, path: string, query?: Record<string, string>, body?: any) {
  const url = new URL(`http://localhost:3000${path}${query ? "?" + new URLSearchParams(query).toString() : ""}`);
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return { req: new Request(url.toString(), init), url, path };
}

async function callRoute(handler: any, method: string, path: string, query?: Record<string, string>, body?: any) {
  const { req, url, path: p } = makeRequest(method, path, query, body);
  const result = handler(req, url, p);
  if (result instanceof Promise) return result;
  return result;
}

async function getJson(response: Response) {
  return response.json();
}

// --- Tests ---

describe("Scheduler Routes", () => {
  let handler: ReturnType<typeof registerSchedulerRoutes>;
  let scheduler: ReturnType<typeof createMockScheduler>;

  beforeEach(() => {
    mockJobs = {};
    mockRuns = {};
    scheduler = createMockScheduler();
    handler = registerSchedulerRoutes(scheduler as any);
  });

  describe("LIST — /api/app.scheduler.list", () => {
    test("returns 400 when channel is missing", async () => {
      const res = await callRoute(handler, "GET", "/api/app.scheduler.list");
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toContain("channel required");
    });

    test("returns jobs with is_running and active_count", async () => {
      mockJobs = {
        "job-1": { id: "job-1", channel: "ch1", status: "active", title: "Test 1" },
        "job-2": { id: "job-2", channel: "ch1", status: "paused", title: "Test 2" },
        "job-3": { id: "job-3", channel: "ch1", status: "active", title: "Test 3" },
      };
      // Mark job-1 as running
      scheduler.runningJobs.set("job-1", new AbortController());

      const res = await callRoute(handler, "GET", "/api/app.scheduler.list", { channel: "ch1" });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(data.jobs).toHaveLength(3);
      expect(data.active_count).toBe(2);
      expect(data.jobs[0].is_running).toBe(true);
      expect(data.jobs[1].is_running).toBe(false);
    });

    test("caps response at 200 jobs", async () => {
      // Create 210 jobs
      for (let i = 0; i < 210; i++) {
        mockJobs[`job-${i}`] = { id: `job-${i}`, channel: "ch1", status: "active", title: `Job ${i}` };
      }

      const res = await callRoute(handler, "GET", "/api/app.scheduler.list", { channel: "ch1" });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(data.jobs).toHaveLength(200);
    });
  });

  describe("GET — /api/app.scheduler.get", () => {
    test("returns 400 when id or channel missing", async () => {
      const res = await callRoute(handler, "GET", "/api/app.scheduler.get", { id: "x" });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
    });

    test("returns 404 when job not found", async () => {
      const res = await callRoute(handler, "GET", "/api/app.scheduler.get", { id: "missing", channel: "ch1" });
      expect(res.status).toBe(404);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("returns 403 when channel doesn't match", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch2", status: "active" };
      const res = await callRoute(handler, "GET", "/api/app.scheduler.get", { id: "job-1", channel: "ch1" });
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("returns job with runs and is_running", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "active", title: "Test" };
      mockRuns["job-1"] = [{ id: "run-1", job_id: "job-1", started_at: Date.now(), status: "success" }];
      scheduler.runningJobs.set("job-1", new AbortController());

      const res = await callRoute(handler, "GET", "/api/app.scheduler.get", { id: "job-1", channel: "ch1" });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(data.job.id).toBe("job-1");
      expect(data.runs).toHaveLength(1);
      expect(data.is_running).toBe(true);
    });

    test("clamps runs_limit to 50", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "active" };
      mockRuns["job-1"] = [];
      for (let i = 0; i < 60; i++) {
        mockRuns["job-1"].push({ id: `run-${i}`, job_id: "job-1", started_at: Date.now(), status: "success" });
      }

      const res = await callRoute(handler, "GET", "/api/app.scheduler.get", {
        id: "job-1",
        channel: "ch1",
        runs_limit: "100",
      });
      const data = await getJson(res);
      expect(data.runs).toHaveLength(50);
    });
  });

  describe("CREATE — /api/app.scheduler.create", () => {
    test("returns 400 when required fields missing", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.create", undefined, {
        channel: "ch1",
        // missing agent_id, title, prompt, schedule
      });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
    });

    test("creates job successfully", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.create", undefined, {
        channel: "ch1",
        agent_id: "agent-1",
        title: "Test Job",
        prompt: "Do something",
        schedule: "every 5m",
      });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(data.job).toBeDefined();
      expect(scheduler.createJobFromTool).toHaveBeenCalledTimes(1);
      // Verify camelCase params
      const callArgs = scheduler.createJobFromTool.mock.calls[0][0];
      expect(callArgs.agentId).toBe("agent-1");
    });

    test("passes optional params correctly", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.create", undefined, {
        channel: "ch1",
        agent_id: "agent-1",
        title: "Test Job",
        prompt: "Do something",
        schedule: "every 5m",
        is_reminder: true,
        max_runs: 10,
        timeout_seconds: 600,
      });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      const callArgs = scheduler.createJobFromTool.mock.calls[0][0];
      expect(callArgs.isReminder).toBe(true);
      expect(callArgs.maxRuns).toBe(10);
      expect(callArgs.timeoutSeconds).toBe(600);
    });

    test("returns error when createJobFromTool fails", async () => {
      scheduler.createJobFromTool = mock(() => ({ success: false, error: "Invalid schedule" }));
      handler = registerSchedulerRoutes(scheduler as any);

      const res = await callRoute(handler, "POST", "/api/app.scheduler.create", undefined, {
        channel: "ch1",
        agent_id: "agent-1",
        title: "Test",
        prompt: "Test",
        schedule: "bad schedule",
      });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBe("Invalid schedule");
    });
  });

  describe("CANCEL — /api/app.scheduler.cancel", () => {
    test("returns 400 when id or channel missing", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.cancel", undefined, { id: "x" });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
    });

    test("returns 404 when job not found", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.cancel", undefined, {
        id: "missing",
        channel: "ch1",
      });
      expect(res.status).toBe(404);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("returns 403 when channel doesn't match", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch2", status: "active", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.cancel", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("cancels job and passes created_by_agent", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "active", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.cancel", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(scheduler.cancelJobFromTool).toHaveBeenCalledWith("job-1", "agent-1", "ch1");
    });

    test("returns 409 with stale info when cancel fails", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "cancelled", created_by_agent: "agent-1" };
      scheduler.cancelJobFromTool = mock(() => ({ success: false, error: "Already cancelled" }));
      handler = registerSchedulerRoutes(scheduler as any);

      const res = await callRoute(handler, "POST", "/api/app.scheduler.cancel", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(409);
      const data = await getJson(res);
      expect(data.stale).toBe(true);
      expect(data.current_status).toBe("cancelled");
    });
  });

  describe("PAUSE — /api/app.scheduler.pause", () => {
    test("returns 400 when id or channel missing", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.pause", undefined, { id: "x" });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
    });

    test("returns 404 when job not found", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.pause", undefined, {
        id: "missing",
        channel: "ch1",
      });
      expect(res.status).toBe(404);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("returns 403 when channel doesn't match", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch2", status: "active", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.pause", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("pauses job successfully", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "active", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.pause", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(scheduler.pauseJobFromTool).toHaveBeenCalledWith("job-1", "agent-1", "ch1");
    });

    test("returns 409 when pause fails (already paused)", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "paused", created_by_agent: "agent-1" };
      scheduler.pauseJobFromTool = mock(() => ({ success: false, error: "Already paused" }));
      handler = registerSchedulerRoutes(scheduler as any);

      const res = await callRoute(handler, "POST", "/api/app.scheduler.pause", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(409);
      const data = await getJson(res);
      expect(data.stale).toBe(true);
      expect(data.current_status).toBe("paused");
    });
  });

  describe("RESUME — /api/app.scheduler.resume", () => {
    test("returns 400 when id or channel missing", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.resume", undefined, { channel: "ch1" });
      const data = await getJson(res);
      expect(data.ok).toBe(false);
    });

    test("returns 404 when job not found", async () => {
      const res = await callRoute(handler, "POST", "/api/app.scheduler.resume", undefined, {
        id: "missing",
        channel: "ch1",
      });
      expect(res.status).toBe(404);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("returns 403 when channel doesn't match", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch2", status: "paused", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.resume", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    test("resumes job successfully", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "paused", created_by_agent: "agent-1" };
      const res = await callRoute(handler, "POST", "/api/app.scheduler.resume", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      const data = await getJson(res);
      expect(data.ok).toBe(true);
      expect(scheduler.resumeJobFromTool).toHaveBeenCalledWith("job-1", "agent-1", "ch1");
    });

    test("returns 409 with stale info when resume fails", async () => {
      mockJobs["job-1"] = { id: "job-1", channel: "ch1", status: "active", created_by_agent: "agent-1" };
      scheduler.resumeJobFromTool = mock(() => ({ success: false, error: "Not paused" }));
      handler = registerSchedulerRoutes(scheduler as any);

      const res = await callRoute(handler, "POST", "/api/app.scheduler.resume", undefined, {
        id: "job-1",
        channel: "ch1",
      });
      expect(res.status).toBe(409);
      const data = await getJson(res);
      expect(data.stale).toBe(true);
      expect(data.current_status).toBe("active");
    });
  });

  describe("Routing", () => {
    test("returns null for unknown paths", async () => {
      const result = await callRoute(handler, "GET", "/api/app.unknown");
      expect(result).toBeNull();
    });

    test("returns null for wrong method on list endpoint", async () => {
      const result = await callRoute(handler, "POST", "/api/app.scheduler.list", { channel: "ch1" });
      expect(result).toBeNull();
    });
  });
});
