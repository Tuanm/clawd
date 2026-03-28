/**
 * Migrations for kanban.db
 *
 * v1 — initial schema: tasks, plans, phases, plan_tasks, todos
 *       (consolidated from getKanbanDb() in server/routes/tasks.ts)
 */

import type { Migration } from "../migrations";

export const kanbanMigrations: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: (db) => {
      db.exec(`
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
          channel TEXT,
          attachments TEXT DEFAULT '[]',
          comments TEXT DEFAULT '[]'
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel);

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
        );
        CREATE INDEX IF NOT EXISTS idx_plans_channel ON plans(channel);

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
        );
        CREATE INDEX IF NOT EXISTS idx_phases_plan ON phases(plan_id);

        CREATE TABLE IF NOT EXISTS plan_tasks (
          plan_id TEXT NOT NULL,
          phase_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          PRIMARY KEY (plan_id, task_id),
          FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
          FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          order_index INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_todos_agent_channel ON todos(agent_id, channel);
      `);
    },
  },
];
