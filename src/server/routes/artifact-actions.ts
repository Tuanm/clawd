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
  "custom_script",
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
export async function handleArtifactAction(req: ArtifactActionRequest, user: string): Promise<ActionResult> {
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

  // Verify message exists in channel and fetch interactive spec
  const msg = db
    .query<{ interactive_json: string | null; text: string | null }, [string, string]>(
      "SELECT interactive_json, text FROM messages WHERE ts = ? AND channel = ?",
    )
    .get(message_ts, channel);
  if (!msg) return { ok: false, error: "not_found" };

  // Parse interactive spec from column (Path B) or from artifact tag in text (Path A)
  let spec: any = null;
  if (msg.interactive_json) {
    try {
      spec = JSON.parse(msg.interactive_json);
    } catch {
      /* ignore */
    }
  }
  if (!spec && msg.text) {
    // Extract JSON from <artifact type="interactive"> tag in message text
    const match = msg.text.match(/<artifact[^>]*type="interactive"[^>]*>([\s\S]*?)<\/artifact>/);
    if (match?.[1]) {
      try {
        spec = JSON.parse(match[1].trim());
      } catch {
        /* ignore */
      }
    }
  }

  // Expiry check
  if (spec?.expires_at && Date.now() / 1000 > spec.expires_at) {
    return { ok: false, error: "expired" };
  }

  // One-shot: cross-user enforcement. Default true. Message handler always forces one-shot.
  const handler: string = spec?.on_action?.type || "store";
  const oneShot = handler === "message" ? true : spec?.one_shot !== false;
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
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      // Exact duplicate (same user + same values) — idempotent success
      return { ok: true, action_id, status: "completed" };
    }
    throw err;
  }

  // Route to handler
  if (handler === "message" && spec?.on_action) {
    const template: string = spec.on_action.template || "{{value}}";
    let text = template;
    // {{value}} = the raw clicked value
    text = text.replace(/\{\{value\}\}/g, String(value ?? ""));
    // {{field_id}} = resolve to button LABEL if it's a button_group, otherwise raw value
    text = text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const fieldVal = mergedValues[key];
      if (fieldVal == null) return "";
      // Look up label from button_group in spec
      const comp = spec.components?.find((c: any) => c.id === key);
      if (comp?.type === "button_group" && Array.isArray(comp.buttons)) {
        const btn = comp.buttons.find((b: any) => String(b.value) === String(fieldVal));
        if (btn?.label) return String(btn.label);
      }
      if (comp?.type === "select" && Array.isArray(comp.options)) {
        const opt = comp.options.find((o: any) => String(o.value) === String(fieldVal));
        if (opt?.label) return String(opt.label);
      }
      return String(fieldVal);
    });
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
  } else if (handler === "custom_script" && spec?.on_action) {
    // Execute a custom script with form values as arguments
    const toolId = spec.on_action.tool_id;
    if (!toolId || typeof toolId !== "string") {
      return { ok: false, error: "invalid", message: "custom_script handler requires tool_id" };
    }
    // Resolve project root from channel_agents
    const channelAgent = db
      .query<{ project: string }, [string]>(
        "SELECT project FROM channel_agents WHERE channel = ? AND active = 1 LIMIT 1",
      )
      .get(channel);
    const projectRoot = channelAgent?.project;
    if (!projectRoot) {
      return { ok: false, error: "invalid", message: "No project root found for this channel" };
    }
    // args_template is REQUIRED — only explicitly mapped fields reach the tool (security)
    const argsTemplate = spec.on_action.args_template as Record<string, string> | undefined;
    if (!argsTemplate || typeof argsTemplate !== "object" || Object.keys(argsTemplate).length === 0) {
      return { ok: false, error: "invalid", message: "custom_script handler requires args_template mapping" };
    }
    const toolArgs: Record<string, any> = {};
    for (const [key, val] of Object.entries(argsTemplate)) {
      if (typeof val === "string" && val.startsWith("{{") && val.endsWith("}}")) {
        toolArgs[key] = mergedValues[val.slice(2, -2)] ?? "";
      } else {
        toolArgs[key] = val;
      }
    }
    // Execute custom tool (async — we need to make handler async or run sync)
    // Use dynamic import to avoid circular deps
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      const { join, extname } = await import("node:path");
      const { runInSandbox } = await import("../../agent/utils/sandbox");
      const toolDir = join(projectRoot, ".clawd", "tools", toolId);
      const metaPath = join(toolDir, "tool.json");
      if (!existsSync(metaPath)) {
        return { ok: false, error: "invalid", message: `Custom tool '${toolId}' not found` };
      }
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const entrypoint = join(toolDir, meta.entrypoint);
      if (!existsSync(entrypoint)) {
        return { ok: false, error: "invalid", message: `Tool entrypoint not found` };
      }
      const extMap: Record<string, string> = { ".sh": "bash", ".py": "python3", ".ts": "bun", ".js": "bun" };
      const interpreter = meta.interpreter || extMap[extname(meta.entrypoint)] || "bash";
      const timeout = meta.timeout ? Math.min(meta.timeout * 1000, 300_000) : 30_000;
      const result = await runInSandbox(interpreter, [entrypoint], {
        timeout,
        cwd: projectRoot,
        stdin: JSON.stringify(toolArgs),
      });
      // Post tool result to channel
      const output = result.success ? result.stdout || "(no output)" : result.stderr || result.stdout || "Tool failed";
      postMessage({
        channel,
        text: `**Tool \`${toolId}\` result:**\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``,
        user: "UBOT",
        subtype: "artifact_action",
      });
    } catch (e: unknown) {
      postMessage({
        channel,
        text: `**Tool \`${toolId}\` error:** ${e instanceof Error ? e.message : String(e)}`,
        user: "UBOT",
        subtype: "artifact_action",
      });
    }
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
