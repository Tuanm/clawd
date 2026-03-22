/**
 * Task & Plan API routes
 *
 * Provides REST API access to channel-scoped tasks and plans.
 * Database location: DATA_DIR/kanban.db (same directory as chat.db)
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../config-file";

// Use same DATA_DIR as chat.db
const DATA_DIR = getDataDir();

// ============================================================================
// Types
// ============================================================================

export interface TaskAttachment {
  id: string;
  name: string;
  url?: string;
  file_id?: string;
  mimetype?: string;
  size?: number;
  added_by: string;
  added_at: number;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  created_at: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "doing" | "done" | "blocked";
  priority: "P0" | "P1" | "P2" | "P3";
  tags?: string[];
  created_at: number;
  started_at?: number;
  completed_at?: number;
  due_at?: number;
  agent_id: string;
  claimed_by?: string; // Agent that claimed this task (set when status -> "doing")
  channel?: string;
  attachments?: TaskAttachment[];
  comments?: TaskComment[];
}

export interface Phase {
  id: string;
  plan_id: string;
  name: string;
  description?: string;
  order_index: number;
  status: "pending" | "active" | "completed" | "blocked" | "skipped";
  agent_in_charge?: string;
  started_at?: number;
  completed_at?: number;
  created_at: number;
}

export interface Plan {
  id: string;
  channel: string;
  title: string;
  description?: string;
  status: "draft" | "active" | "completed" | "cancelled";
  created_by: string;
  created_at: number;
  updated_at: number;
  agent_in_charge?: string;
}

export interface PlanWithPhases extends Plan {
  phases: Phase[];
  progress: {
    total_phases: number;
    completed_phases: number;
    total_tasks: number;
    completed_tasks: number;
  };
}

// ============================================================================
// Database singleton
// ============================================================================

let kanbanDb: Database | null = null;

function getKanbanDb(): Database {
  if (kanbanDb) return kanbanDb;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const dbPath = join(DATA_DIR, "kanban.db");
  kanbanDb = new Database(dbPath);

  // WAL mode for better concurrency
  kanbanDb.exec("PRAGMA journal_mode = WAL");
  kanbanDb.exec("PRAGMA busy_timeout = 30000");
  kanbanDb.exec("PRAGMA synchronous = NORMAL");

  // Ensure tables exist
  kanbanDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'P2',
      tags TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      due_at INTEGER,
      agent_id TEXT,
      claimed_by TEXT,
      attachments TEXT DEFAULT '[]',
      comments TEXT DEFAULT '[]'
    )
  `);

  // Migration: Add claimed_by column if it doesn't exist
  try {
    kanbanDb.exec(`ALTER TABLE tasks ADD COLUMN claimed_by TEXT`);
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add channel column if it doesn't exist
  try {
    kanbanDb.exec(`ALTER TABLE tasks ADD COLUMN channel TEXT`);
  } catch {
    /* Column already exists */
  }
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel)`);

  kanbanDb.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_in_charge TEXT
    )
  `);

  kanbanDb.exec(`
    CREATE TABLE IF NOT EXISTS phases (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      order_index INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      agent_in_charge TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    )
  `);

  kanbanDb.exec(`
    CREATE TABLE IF NOT EXISTS plan_tasks (
      plan_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      PRIMARY KEY (plan_id, task_id),
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
      FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  // Create indexes
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`);
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_plans_channel ON plans(channel)`);
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_phases_plan ON phases(plan_id)`);

  // Todos table (per-agent, per-channel)
  kanbanDb.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      order_index INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  kanbanDb.exec(`CREATE INDEX IF NOT EXISTS idx_todos_agent_channel ON todos(agent_id, channel)`);

  return kanbanDb;
}

// ============================================================================
// Task Functions
// ============================================================================

function parseTask(row: any): Task {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    comments: row.comments ? JSON.parse(row.comments) : [],
  };
}

export function listTasks(
  options: { agent_id?: string; status?: string; channel?: string; limit?: number } = {},
): Task[] {
  const db = getKanbanDb();

  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params: any[] = [];

  if (options.agent_id) {
    sql += " AND agent_id = ?";
    params.push(options.agent_id);
  }

  if (options.status) {
    sql += " AND status = ?";
    params.push(options.status);
  }

  if (options.channel) {
    sql += " AND (channel = ? OR channel IS NULL)";
    params.push(options.channel);
  }

  sql += " ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at DESC";

  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.query(sql).all(...params);
  return rows.map(parseTask);
}

export function getTask(taskId: string): Task | null {
  const db = getKanbanDb();
  const row = db.query("SELECT * FROM tasks WHERE id = ? OR id LIKE ?").get(taskId, `%${taskId}%`);
  return row ? parseTask(row) : null;
}

export function createTask(data: {
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
  agent_id?: string;
  due_at?: number;
  channel?: string;
}): Task {
  const db = getKanbanDb();
  const id = `task_${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  db.query(
    `
    INSERT INTO tasks (id, title, description, status, priority, tags, created_at, agent_id, channel, due_at, attachments, comments)
    VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, '[]', '[]')
  `,
  ).run(
    id,
    data.title,
    data.description || null,
    data.priority || "P2",
    data.tags ? JSON.stringify(data.tags) : null,
    now,
    data.agent_id || "default",
    data.channel || null,
    data.due_at || null,
  );

  return getTask(id)!;
}

export function createTasksBatch(
  tasks: Array<{ title: string; description?: string; priority?: string; tags?: string[] }>,
  agentId: string,
  channel?: string,
): Task[] {
  const db = getKanbanDb();
  const now = Date.now();
  const created: Task[] = [];

  db.transaction(() => {
    for (const t of tasks.slice(0, 20)) {
      const id = `task_${randomUUID().slice(0, 8)}`;
      db.query(
        `INSERT INTO tasks (id, title, description, status, priority, tags, created_at, agent_id, channel, due_at, attachments, comments)
         VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, NULL, '[]', '[]')`,
      ).run(
        id,
        t.title,
        t.description || null,
        t.priority || "P2",
        t.tags ? JSON.stringify(t.tags) : null,
        now,
        agentId,
        channel || null,
      );
      created.push(getTask(id)!);
    }
  })();

  return created;
}

export type UpdateTaskResult =
  | { success: true; task: Task }
  | { success: false; error: "not_found" | "already_claimed"; claimed_by?: string };

export function updateTask(taskId: string, updates: Partial<Task> & { claimer?: string }): UpdateTaskResult {
  const db = getKanbanDb();
  const task = getTask(taskId);
  if (!task) return { success: false, error: "not_found" };

  const allowedFields = ["title", "description", "status", "priority", "tags", "due_at"];
  const setClauses: string[] = [];
  const params: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      params.push(key === "tags" ? JSON.stringify(value) : value);
    }
  }

  // Handle status transitions with atomic claiming
  if (updates.status === "doing" && task.status !== "doing") {
    // Check if already claimed by someone else
    if (task.claimed_by && updates.claimer && task.claimed_by !== updates.claimer) {
      // Already claimed by another agent - return failure with claimed_by info
      return { success: false, error: "already_claimed", claimed_by: task.claimed_by };
    }

    setClauses.push("started_at = ?");
    params.push(Date.now());

    // Set claimed_by if claimer is provided
    if (updates.claimer) {
      setClauses.push("claimed_by = ?");
      params.push(updates.claimer);
    }
  }

  if (updates.status === "done" && task.status !== "done") {
    setClauses.push("completed_at = ?");
    params.push(Date.now());
  }

  // Clear claimed_by when task goes back to todo
  if (updates.status === "todo") {
    setClauses.push("claimed_by = NULL");
  }

  if (setClauses.length === 0) return { success: true, task };

  // For claiming, use atomic WHERE clause to prevent race conditions
  if (updates.status === "doing" && updates.claimer) {
    params.push(task.id);
    params.push(updates.claimer);

    const result = db
      .query(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)`)
      .run(...params);

    // If no rows updated, someone else claimed it (race condition)
    if (result.changes === 0) {
      // Re-fetch to get the current claimer
      const currentTask = getTask(task.id);
      return { success: false, error: "already_claimed", claimed_by: currentTask?.claimed_by };
    }
  } else {
    params.push(task.id);
    db.query(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  }

  const updatedTask = getTask(task.id);
  return { success: true, task: updatedTask! };
}

export function deleteTask(taskId: string): boolean {
  const db = getKanbanDb();
  const task = getTask(taskId);
  if (!task) return false;

  db.query("DELETE FROM tasks WHERE id = ?").run(task.id);
  return true;
}

export function addTaskAttachment(taskId: string, attachment: Omit<TaskAttachment, "id" | "added_at">): Task | null {
  const db = getKanbanDb();
  const task = getTask(taskId);
  if (!task) return null;

  const newAttachment: TaskAttachment = {
    ...attachment,
    id: `att_${randomUUID().slice(0, 8)}`,
    added_at: Date.now(),
  };

  const attachments = [...(task.attachments || []), newAttachment];
  db.query("UPDATE tasks SET attachments = ? WHERE id = ?").run(JSON.stringify(attachments), task.id);

  return getTask(task.id);
}

export function removeTaskAttachment(taskId: string, attachmentId: string): Task | null {
  const db = getKanbanDb();
  const task = getTask(taskId);
  if (!task) return null;

  const attachments = (task.attachments || []).filter((a) => a.id !== attachmentId);
  db.query("UPDATE tasks SET attachments = ? WHERE id = ?").run(JSON.stringify(attachments), task.id);

  return getTask(task.id);
}

export function addTaskComment(taskId: string, author: string, text: string): Task | null {
  const db = getKanbanDb();
  const task = getTask(taskId);
  if (!task) return null;

  const newComment: TaskComment = {
    id: `cmt_${randomUUID().slice(0, 8)}`,
    author,
    text,
    created_at: Date.now(),
  };

  const comments = [...(task.comments || []), newComment];
  db.query("UPDATE tasks SET comments = ? WHERE id = ?").run(JSON.stringify(comments), task.id);

  return getTask(task.id);
}

// ============================================================================
// Plan Functions
// ============================================================================

export function listPlans(channel?: string): Plan[] {
  const db = getKanbanDb();

  if (channel) {
    return db.query("SELECT * FROM plans WHERE channel = ? ORDER BY created_at DESC").all(channel) as Plan[];
  }
  return db.query("SELECT * FROM plans ORDER BY created_at DESC").all() as Plan[];
}

export function getPlan(planId: string): PlanWithPhases | null {
  const db = getKanbanDb();

  const plan = db.query("SELECT * FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as Plan | null;
  if (!plan) return null;

  const phases = db.query("SELECT * FROM phases WHERE plan_id = ? ORDER BY order_index").all(plan.id) as Phase[];

  // Calculate progress
  const completedPhases = phases.filter((p) => p.status === "completed").length;

  // Get task counts
  const taskCounts = db
    .query(
      `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as completed
    FROM plan_tasks pt
    JOIN tasks t ON pt.task_id = t.id
    WHERE pt.plan_id = ?
  `,
    )
    .get(plan.id) as { total: number; completed: number };

  return {
    ...plan,
    phases,
    progress: {
      total_phases: phases.length,
      completed_phases: completedPhases,
      total_tasks: taskCounts?.total || 0,
      completed_tasks: taskCounts?.completed || 0,
    },
  };
}

export function createPlan(data: {
  channel: string;
  title: string;
  description?: string;
  created_by: string;
  agent_in_charge?: string;
}): Plan {
  const db = getKanbanDb();
  const id = `plan_${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  db.query(
    `
    INSERT INTO plans (id, channel, title, description, status, created_by, created_at, updated_at, agent_in_charge)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `,
  ).run(
    id,
    data.channel,
    data.title,
    data.description || null,
    data.created_by,
    now,
    now,
    data.agent_in_charge || null,
  );

  return db.query("SELECT * FROM plans WHERE id = ?").get(id) as Plan;
}

export function updatePlan(planId: string, updates: Partial<Plan>): Plan | null {
  const db = getKanbanDb();
  const plan = db.query("SELECT * FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as Plan | null;
  if (!plan) return null;

  const allowedFields = ["title", "description", "status", "agent_in_charge"];
  const setClauses: string[] = ["updated_at = ?"];
  const params: any[] = [Date.now()];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  params.push(plan.id);
  db.query(`UPDATE plans SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

  return db.query("SELECT * FROM plans WHERE id = ?").get(plan.id) as Plan;
}

export function deletePlan(planId: string): boolean {
  const db = getKanbanDb();
  const plan = db.query("SELECT * FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as Plan | null;
  if (!plan) return false;

  db.query("DELETE FROM plans WHERE id = ?").run(plan.id);
  return true;
}

// ============================================================================
// Phase Functions
// ============================================================================

export function addPhase(
  planId: string,
  data: {
    name: string;
    description?: string;
    agent_in_charge?: string;
  },
): Phase | null {
  const db = getKanbanDb();
  const plan = db.query("SELECT * FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as Plan | null;
  if (!plan) return null;

  // Get next order index
  const maxOrder = db.query("SELECT MAX(order_index) as max FROM phases WHERE plan_id = ?").get(plan.id) as {
    max: number | null;
  };
  const orderIndex = (maxOrder?.max ?? -1) + 1;

  const id = `phase_${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  db.query(
    `
    INSERT INTO phases (id, plan_id, name, description, order_index, status, agent_in_charge, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `,
  ).run(id, plan.id, data.name, data.description || null, orderIndex, data.agent_in_charge || null, now);

  // Update plan timestamp
  db.query("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, plan.id);

  return db.query("SELECT * FROM phases WHERE id = ?").get(id) as Phase;
}

export function updatePhase(phaseId: string, updates: Partial<Phase>): Phase | null {
  const db = getKanbanDb();
  const phase = db.query("SELECT * FROM phases WHERE id = ? OR id LIKE ?").get(phaseId, `%${phaseId}%`) as Phase | null;
  if (!phase) return null;

  const allowedFields = ["name", "description", "status", "agent_in_charge", "order_index"];
  const setClauses: string[] = [];
  const params: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  // Handle status transitions
  if (updates.status === "active" && phase.status !== "active") {
    setClauses.push("started_at = ?");
    params.push(Date.now());
  }
  if (updates.status === "completed" && phase.status !== "completed") {
    setClauses.push("completed_at = ?");
    params.push(Date.now());
  }

  if (setClauses.length === 0) return phase;

  params.push(phase.id);
  db.query(`UPDATE phases SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

  // Update plan timestamp
  db.query("UPDATE plans SET updated_at = ? WHERE id = ?").run(Date.now(), phase.plan_id);

  return db.query("SELECT * FROM phases WHERE id = ?").get(phase.id) as Phase;
}

export function deletePhase(phaseId: string): boolean {
  const db = getKanbanDb();
  const phase = db.query("SELECT * FROM phases WHERE id = ? OR id LIKE ?").get(phaseId, `%${phaseId}%`) as Phase | null;
  if (!phase) return false;

  db.query("DELETE FROM phases WHERE id = ?").run(phase.id);
  db.query("UPDATE plans SET updated_at = ? WHERE id = ?").run(Date.now(), phase.plan_id);
  return true;
}

export function getPhaseWithTasks(phaseId: string): { phase: Phase; tasks: Task[] } | null {
  const db = getKanbanDb();
  const phase = db.query("SELECT * FROM phases WHERE id = ? OR id LIKE ?").get(phaseId, `%${phaseId}%`) as Phase | null;
  if (!phase) return null;

  const tasks = db
    .query(
      `
    SELECT t.* FROM tasks t
    JOIN plan_tasks pt ON t.id = pt.task_id
    WHERE pt.phase_id = ?
    ORDER BY CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, t.created_at
  `,
    )
    .all(phase.id)
    .map(parseTask);

  return { phase, tasks };
}

// ============================================================================
// Plan-Task Linking
// ============================================================================

export function linkTaskToPhase(planId: string, phaseId: string, taskId: string): boolean {
  const db = getKanbanDb();

  // Verify all exist
  const plan = db.query("SELECT id FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as {
    id: string;
  } | null;
  const phase = db.query("SELECT id FROM phases WHERE id = ? OR id LIKE ?").get(phaseId, `%${phaseId}%`) as {
    id: string;
  } | null;
  const task = db.query("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").get(taskId, `%${taskId}%`) as {
    id: string;
  } | null;

  if (!plan || !phase || !task) return false;

  try {
    db.query(
      `
      INSERT OR REPLACE INTO plan_tasks (plan_id, phase_id, task_id)
      VALUES (?, ?, ?)
    `,
    ).run(plan.id, phase.id, task.id);
    return true;
  } catch {
    return false;
  }
}

export function unlinkTaskFromPlan(planId: string, taskId: string): boolean {
  const db = getKanbanDb();

  const plan = db.query("SELECT id FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as {
    id: string;
  } | null;
  const task = db.query("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").get(taskId, `%${taskId}%`) as {
    id: string;
  } | null;

  if (!plan || !task) return false;

  db.query("DELETE FROM plan_tasks WHERE plan_id = ? AND task_id = ?").run(plan.id, task.id);
  return true;
}

// ============================================================================
// Todo Functions (per-agent, per-channel)
// ============================================================================

export interface TodoItem {
  id: string;
  channel: string;
  agent_id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  order_index: number;
  created_at: number;
}

export function getTodos(agentId: string, channel: string): TodoItem[] {
  const db = getKanbanDb();
  return db
    .query("SELECT * FROM todos WHERE agent_id = ? AND channel = ? ORDER BY order_index ASC")
    .all(agentId, channel) as TodoItem[];
}

const VALID_TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const MAX_TODO_ITEMS = 50;

export function writeTodos(
  agentId: string,
  channel: string,
  items: Array<{ id?: string; content: string; status?: string }>,
): TodoItem[] {
  const db = getKanbanDb();
  const capped = items.slice(0, MAX_TODO_ITEMS);

  // Atomic: delete + insert + auto-cleanup all in one transaction
  let result: TodoItem[] = [];
  db.transaction(() => {
    db.run("DELETE FROM todos WHERE agent_id = ? AND channel = ?", [agentId, channel]);
    const now = Date.now();
    for (let i = 0; i < capped.length; i++) {
      const item = capped[i];
      const id = item.id || `todo_${randomUUID().slice(0, 8)}`;
      const status = VALID_TODO_STATUSES.has(item.status || "") ? item.status! : "pending";
      db.query(
        "INSERT INTO todos (id, channel, agent_id, content, status, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, channel, agentId, item.content, status, i, now);
    }
    // Auto-cleanup: if all items completed, delete the list
    const rows = db.query("SELECT status FROM todos WHERE agent_id = ? AND channel = ?").all(agentId, channel) as {
      status: string;
    }[];
    if (rows.length > 0 && rows.every((r) => r.status === "completed")) {
      db.run("DELETE FROM todos WHERE agent_id = ? AND channel = ?", [agentId, channel]);
    }
  })();
  result = getTodos(agentId, channel);
  return result;
}

export function updateTodoItem(agentId: string, channel: string, itemId: string, status: string): TodoItem[] {
  const db = getKanbanDb();
  const validStatus = VALID_TODO_STATUSES.has(status) ? status : "pending";

  // Atomic: update + auto-cleanup in one transaction
  db.transaction(() => {
    db.run("UPDATE todos SET status = ? WHERE id = ? AND agent_id = ? AND channel = ?", [
      validStatus,
      itemId,
      agentId,
      channel,
    ]);
    // Auto-cleanup: if all items completed, delete the list
    const rows = db.query("SELECT status FROM todos WHERE agent_id = ? AND channel = ?").all(agentId, channel) as {
      status: string;
    }[];
    if (rows.length > 0 && rows.every((r) => r.status === "completed")) {
      db.run("DELETE FROM todos WHERE agent_id = ? AND channel = ?", [agentId, channel]);
    }
  })();
  return getTodos(agentId, channel);
}

export function listChannelTodos(channel: string): Array<{ agent_id: string; items: TodoItem[] }> {
  const db = getKanbanDb();
  const rows = db.query("SELECT DISTINCT agent_id FROM todos WHERE channel = ? ORDER BY agent_id").all(channel) as {
    agent_id: string;
  }[];
  return rows.map((r) => ({ agent_id: r.agent_id, items: getTodos(r.agent_id, channel) }));
}

export function getTasksForPlan(planId: string): { phase: Phase; tasks: Task[] }[] {
  const db = getKanbanDb();

  const plan = db.query("SELECT id FROM plans WHERE id = ? OR id LIKE ?").get(planId, `%${planId}%`) as {
    id: string;
  } | null;
  if (!plan) return [];

  const phases = db.query("SELECT * FROM phases WHERE plan_id = ? ORDER BY order_index").all(plan.id) as Phase[];

  return phases.map((phase) => {
    const tasks = db
      .query(
        `
      SELECT t.* FROM tasks t
      JOIN plan_tasks pt ON t.id = pt.task_id
      WHERE pt.phase_id = ?
      ORDER BY CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END
    `,
      )
      .all(phase.id)
      .map(parseTask);

    return { phase, tasks };
  });
}
