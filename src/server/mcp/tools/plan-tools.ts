/**
 * MCP tool definitions for plan_* tools.
 */

export const PLAN_TOOL_DEFS = [
  {
    name: "plan_create",
    description: "Create a new project plan for the channel. Plans organize work into phases with assigned agents.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title" },
        description: { type: "string", description: "Plan description/goals" },
        agent_in_charge: {
          type: "string",
          description: "Overall plan owner (agent ID)",
        },
        created_by: { type: "string", description: "Creator agent ID" },
      },
      required: ["title"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "plan_list",
    description: "List all plans in the channel.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_get",
    description: "Get detailed view of a plan with phases and progress.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_update",
    description: "Update a plan's status, title, description, or owner.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        status: {
          type: "string",
          description: "New status (draft/active/completed/archived)",
        },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        agent_in_charge: { type: "string", description: "New owner agent ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_add_phase",
    description: "Add a new phase to a plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        name: { type: "string", description: "Phase name" },
        description: { type: "string", description: "Phase description" },
        agent_in_charge: {
          type: "string",
          description: "Agent responsible for this phase",
        },
      },
      required: ["plan_id", "name"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "plan_update_phase",
    description: "Update a phase's status, name, description, or owner.",
    inputSchema: {
      type: "object",
      properties: {
        phase_id: { type: "string", description: "Phase ID" },
        status: {
          type: "string",
          description: "New status (pending/active/completed)",
        },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        agent_in_charge: { type: "string", description: "New owner agent ID" },
      },
      required: ["phase_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_link_task",
    description: "Link a task to a plan phase.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        phase_id: { type: "string", description: "Phase ID" },
        task_id: { type: "string", description: "Task ID" },
      },
      required: ["plan_id", "phase_id", "task_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_get_tasks",
    description: "Get all tasks for a plan organized by phase.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;
