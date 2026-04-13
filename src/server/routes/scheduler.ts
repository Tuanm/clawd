/**
 * Scheduler API Routes
 *
 * CRUD operations for channel-scoped scheduled jobs.
 * Follows the same pattern as mcp-servers.ts.
 */

import { getJob, getRunsForJob } from "../../scheduler/db";
import type { SchedulerManager } from "../../scheduler/manager";
import { json } from "../http-helpers";

async function parseBody(req: Request): Promise<any> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return {};
  try {
    return await req.json();
  } catch {
    throw new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function registerSchedulerRoutes(
  scheduler: SchedulerManager,
): (req: Request, url: URL, path: string) => Response | Promise<Response> | null {
  return (req, url, path) => {
    // Guard: scheduler not available
    if (!scheduler) {
      return json({ ok: false, error: "Scheduler not available" }, 503);
    }

    // =========================================================================
    // LIST — GET /api/app.scheduler.list?channel=X
    // =========================================================================
    if (path === "/api/app.scheduler.list" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);

      const allJobs = scheduler.listJobsForChannel(channel);
      const jobs = allJobs.slice(0, 200); // Hard cap — terminal statuses accumulate
      const jobsWithRunning = jobs.map((j) => ({
        ...j,
        is_running: scheduler.runningJobs.has(j.id),
      }));
      const active_count = allJobs.filter((j) => j.status === "active").length;

      return json({ ok: true, jobs: jobsWithRunning, active_count });
    }

    // =========================================================================
    // GET — GET /api/app.scheduler.get?id=X&channel=X&runs_limit=N
    // =========================================================================
    if (path === "/api/app.scheduler.get" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const channel = url.searchParams.get("channel");
      if (!id || !channel) return json({ ok: false, error: "id and channel required" }, 400);

      const job = getJob(id);
      if (!job) return json({ ok: false, error: "Job not found" }, 404);
      if (job.channel !== channel) return json({ ok: false, error: "Job belongs to another channel" }, 403);

      const runsLimit = Math.min(Math.max(Number(url.searchParams.get("runs_limit")) || 10, 1), 50);
      const runs = getRunsForJob(id, runsLimit);
      const is_running = scheduler.runningJobs.has(id);

      return json({ ok: true, job, runs, is_running });
    }

    // =========================================================================
    // CREATE — POST /api/app.scheduler.create
    // =========================================================================
    if (path === "/api/app.scheduler.create" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, agent_id, title, prompt, schedule } = body;

        if (!channel) return json({ ok: false, error: "channel required" }, 400);
        if (!agent_id) return json({ ok: false, error: "agent_id required" }, 400);
        if (!title) return json({ ok: false, error: "title required" }, 400);
        if (!prompt) return json({ ok: false, error: "prompt required" }, 400);
        if (!schedule) return json({ ok: false, error: "schedule required" }, 400);

        try {
          const result = scheduler.createJobFromTool({
            title,
            prompt,
            schedule,
            channel,
            agentId: agent_id,
            isReminder: body.is_reminder || false,
            maxRuns: body.max_runs || undefined,
            timeoutSeconds: body.timeout_seconds || undefined,
          });
          if (!result.success) {
            return json({ ok: false, error: result.error }, 400);
          }
          return json({ ok: true, job: result.job });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      })();
    }

    // =========================================================================
    // CANCEL — POST /api/app.scheduler.cancel
    // =========================================================================
    if (path === "/api/app.scheduler.cancel" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { id, channel } = body;
        if (!id || !channel) return json({ ok: false, error: "id and channel required" }, 400);

        const job = getJob(id);
        if (!job) return json({ ok: false, error: "Job not found" }, 404);
        if (job.channel !== channel) return json({ ok: false, error: "Job belongs to another channel" }, 403);

        // Elevate UI to channel-owner privilege — intentional design decision
        const result = scheduler.cancelJobFromTool(id, job.created_by_agent, channel);
        if (!result.success) {
          const current = getJob(id);
          return json({ ok: false, error: result.error, stale: true, current_status: current?.status }, 409);
        }
        return json({ ok: true });
      })();
    }

    // =========================================================================
    // PAUSE — POST /api/app.scheduler.pause
    // =========================================================================
    if (path === "/api/app.scheduler.pause" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { id, channel } = body;
        if (!id || !channel) return json({ ok: false, error: "id and channel required" }, 400);

        const job = getJob(id);
        if (!job) return json({ ok: false, error: "Job not found" }, 404);
        if (job.channel !== channel) return json({ ok: false, error: "Job belongs to another channel" }, 403);

        // Elevate UI to channel-owner privilege — intentional design decision
        const result = scheduler.pauseJobFromTool(id, job.created_by_agent, channel);
        if (!result.success) {
          const current = getJob(id);
          return json({ ok: false, error: result.error, stale: true, current_status: current?.status }, 409);
        }
        return json({ ok: true });
      })();
    }

    // =========================================================================
    // RESUME — POST /api/app.scheduler.resume
    // =========================================================================
    if (path === "/api/app.scheduler.resume" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { id, channel } = body;
        if (!id || !channel) return json({ ok: false, error: "id and channel required" }, 400);

        const job = getJob(id);
        if (!job) return json({ ok: false, error: "Job not found" }, 404);
        if (job.channel !== channel) return json({ ok: false, error: "Job belongs to another channel" }, 403);

        // Elevate UI to channel-owner privilege — intentional design decision
        const result = scheduler.resumeJobFromTool(id, job.created_by_agent, channel);
        if (!result.success) {
          const current = getJob(id);
          return json({ ok: false, error: result.error, stale: true, current_status: current?.status }, 409);
        }
        return json({ ok: true });
      })();
    }

    return null;
  };
}
