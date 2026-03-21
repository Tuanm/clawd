import { createHash } from "node:crypto";
import { db, generateId, preparedStatements } from "../database";
import { postMessage } from "./messages";

// ---------------------------------------------------------------------------
// Rate limiting: in-memory sliding window (cleared on server restart)
// ---------------------------------------------------------------------------
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const PER_ARTIFACT_LIMIT = 10;
const GLOBAL_USER_LIMIT = 30;

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Validate interactive_json before storage
// ---------------------------------------------------------------------------
const VALID_COMPONENT_TYPES = [
  "text",
  "button",
  "button_group",
  "text_input",
  "select",
  "checkbox",
  "rating",
  "slider",
  "submit",
  "divider",
  "toggle",
  "radio_group",
  "number_input",
  "date_picker",
  "image",
  "table",
  "tabs",
  "chart",
];

export function validateInteractiveJson(json: string): { valid: boolean; error?: string } {
  if (json.length > 51200) return { valid: false, error: "interactive_json exceeds 50KB" };
  let spec: any;
  try {
    spec = JSON.parse(json);
  } catch {
    return { valid: false, error: "invalid JSON" };
  }
  if (!spec || !Array.isArray(spec.components)) return { valid: false, error: "components must be array" };
  if (spec.components.length > 20) return { valid: false, error: "max 20 components" };
  for (const c of spec.components) {
    // Skip unknown types for forward compatibility
    if (c.type && !VALID_COMPONENT_TYPES.includes(c.type)) continue;
    if (c.type === "select" && Array.isArray(c.options) && c.options.length > 50) {
      return { valid: false, error: "max 50 select options" };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Action request interface
// ---------------------------------------------------------------------------
export interface ArtifactActionRequest {
  message_ts: string;
  channel: string;
  action_id: string;
  value?: any; // The clicked button's value
  values: Record<string, any>; // All form field values
}

type ActionResult =
  | {
      ok: true;
      action_id: string;
      status: "completed" | "pending";
      handler?: string;
      one_shot?: boolean;
      _broadcast?: object;
    }
  | { ok: false; error: string; message?: string };

// ---------------------------------------------------------------------------
// Main handler — called by the route registration in src/index.ts
// ---------------------------------------------------------------------------
export function handleArtifactAction(req: ArtifactActionRequest, user: string): ActionResult {
  const { message_ts, channel, action_id, value, values } = req;

  // Field validation
  if (!message_ts || !channel || !action_id) {
    return { ok: false, error: "invalid", message: "message_ts, channel, action_id required" };
  }
  if (typeof action_id !== "string" || action_id.length > 128) {
    return { ok: false, error: "invalid", message: "action_id max 128 chars" };
  }
  // Merge the clicked button value into the form values for persistence
  // Extract componentId from action_id (format: "artifactIndex:componentId")
  const parts = action_id.split(":");
  const componentId = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
  const mergedValues = { ...values, [componentId]: value ?? values?.[componentId] };
  const valuesStr = JSON.stringify(mergedValues ?? {});
  if (valuesStr.length > 10240) {
    return { ok: false, error: "invalid", message: "values exceed 10KB" };
  }

  // Rate limits
  if (!checkRateLimit(`${user}:${message_ts}`, PER_ARTIFACT_LIMIT)) {
    return { ok: false, error: "rate_limited" };
  }
  if (!checkRateLimit(`global:${user}`, GLOBAL_USER_LIMIT)) {
    return { ok: false, error: "rate_limited" };
  }

  // Verify message exists in channel and fetch interactive_json
  const msg = db
    .query<{ interactive_json: string | null }, [string, string]>(
      "SELECT interactive_json FROM messages WHERE ts = ? AND channel = ?",
    )
    .get(message_ts, channel);
  if (!msg) return { ok: false, error: "not_found" };

  // Parse interactive spec (graceful on malformed)
  let spec: any = null;
  if (msg.interactive_json) {
    try {
      spec = JSON.parse(msg.interactive_json);
    } catch {
      /* ignore */
    }
  }

  // Expiry check
  if (spec?.expires_at && Date.now() / 1000 > spec.expires_at) {
    return { ok: false, error: "expired" };
  }

  // One-shot: cross-user enforcement (default true per plan)
  const oneShot = spec?.one_shot !== false;
  if (oneShot) {
    const existing = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM artifact_actions WHERE message_ts = ? AND action_id = ? LIMIT 1",
      )
      .get(message_ts, action_id);
    if (existing) return { ok: false, error: "already_acted" };
  }

  // Compute value hash for idempotency index
  const valueHash = createHash("sha256").update(valuesStr).digest("hex").slice(0, 16);

  // Determine handler from spec
  const handler: string = spec?.on_action?.type || "store";
  const handlerConfig = spec?.on_action ? JSON.stringify(spec.on_action) : null;
  const actionRowId = generateId("ACT");
  const now = Math.floor(Date.now() / 1000);

  // Insert action — UNIQUE index on (message_ts, action_id, user, value_hash) handles duplicates
  try {
    db.run(
      `INSERT INTO artifact_actions
         (id, message_ts, channel, action_id, value, value_hash, user, handler, handler_config, status, depth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 0, ?)`,
      [actionRowId, message_ts, channel, action_id, valuesStr, valueHash, user, handler, handlerConfig, now],
    );
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE")) {
      // Exact duplicate (same user + same values) — idempotent success
      return { ok: true, action_id, status: "completed" };
    }
    throw err;
  }

  // Route to handler
  if (handler === "message" && spec?.on_action) {
    const template: string = spec.on_action.template || "User responded: {{value}}";
    // Security: restrict to same channel (prevent cross-channel message injection)
    const text = template.replace(/\{\{value\}\}/g, valuesStr);
    postMessage({ channel, text, user: "UHUMAN" });
  } else if (handler === "agent" && spec?.on_action) {
    // Depth tracking: count recent agent-handler actions in this channel (last 5 min)
    const fiveMinAgo = now - 300;
    const recentAgentActions = db
      .query<{ count: number }, [string, number]>(
        "SELECT COUNT(*) as count FROM artifact_actions WHERE channel = ? AND handler = 'agent' AND created_at > ?",
      )
      .get(channel, fiveMinAgo);
    const currentDepth = recentAgentActions?.count ?? 0;
    if (currentDepth >= 3) {
      return { ok: false, error: "max_depth" };
    }
    // Update the inserted row with actual depth
    db.run("UPDATE artifact_actions SET depth = ? WHERE id = ?", [currentDepth, actionRowId]);
    const context: string = spec.on_action.context || "";
    const actionText = [
      `[ARTIFACT_ACTION] User ${user} responded with: ${valuesStr}`,
      context ? `Context: ${context}` : "",
      `Interactive action depth: ${currentDepth + 1}/3`,
    ]
      .filter(Boolean)
      .join("\n");
    postMessage({ channel, text: actionText, user: "UBOT", subtype: "artifact_action" });
  }
  // store handler: insert already done above, nothing further needed

  return {
    ok: true,
    action_id,
    status: "completed",
    handler,
    one_shot: oneShot,
    _broadcast: { channel, message_ts, action_id, values, user, handler, status: "completed", one_shot: oneShot },
  };
}

// ---------------------------------------------------------------------------
// Get all actions for an artifact (for agents to read back results)
// ---------------------------------------------------------------------------
export function getArtifactActions(messageTs: string, channel: string) {
  const actions = preparedStatements.getArtifactActions.all(messageTs);
  return {
    ok: true,
    message_ts: messageTs,
    channel,
    actions: actions.map((a) => ({
      action_id: a.action_id,
      value: (() => {
        try {
          return JSON.parse(a.value);
        } catch {
          return a.value;
        }
      })(),
      user: a.user,
      created_at: a.created_at,
    })),
    count: actions.length,
  };
}
