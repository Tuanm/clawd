/**
 * MCP tool execution — handles all chat/plan/scheduler/multimodal/web tool calls.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  db,
  generateId,
  generateTs,
  getAgent,
  getMessageSeenBy,
  type Message,
  markMessagesSeen,
  toSlackMessage,
} from "../database";
import { analyzeImage, analyzeVideo, editImage, generateImage, getImageQuotaStatus } from "../multimodal";
import { getOptimizedFile } from "../routes/files";
import { getConversationHistory, getPendingMessages, postMessage } from "../routes/messages";
import { broadcastMessage, broadcastMessageSeen, broadcastUpdate } from "../websocket";
import { _scheduler } from "./shared";
import { truncateForAgent } from "./protocol";

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    let resultText: string;

    // Handle scheduler tools before main switch
    if (name.startsWith("scheduler_")) {
      if (!_scheduler) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "Scheduler not available",
              }),
            },
          ],
        };
      }
      switch (name) {
        case "scheduler_create": {
          const maxRuns = args.max_runs as number | undefined;
          const timeoutSeconds = args.timeout_seconds as number | undefined;
          if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isInteger(maxRuns))) {
            resultText = JSON.stringify({
              ok: false,
              error: "max_runs must be a positive integer",
            });
            break;
          }
          if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
            resultText = JSON.stringify({
              ok: false,
              error: "timeout_seconds must be a positive number",
            });
            break;
          }
          const r = _scheduler.createJobFromTool({
            channel: args.channel as string,
            agentId: args.agent_id as string,
            title: args.title as string,
            prompt: args.prompt as string,
            schedule: args.schedule as string,
            maxRuns,
            timeoutSeconds,
            isReminder: args.is_reminder as boolean | undefined,
          });
          resultText = JSON.stringify(r.success ? { ok: true, job: r.job } : { ok: false, error: r.error });
          break;
        }
        case "scheduler_list": {
          const jobs = _scheduler.listJobsForChannel(args.channel as string, args.status as string | undefined);
          resultText = JSON.stringify({ ok: true, jobs });
          break;
        }
        case "scheduler_cancel": {
          const r = _scheduler.cancelJobFromTool(args.id as string, args.agent_id as string, args.channel as string);
          resultText = JSON.stringify({
            ok: r.success,
            error: r.success ? undefined : r.error,
          });
          break;
        }
        case "scheduler_pause": {
          const r = _scheduler.pauseJobFromTool(args.id as string, args.agent_id as string, args.channel as string);
          resultText = JSON.stringify({ ok: r.success, error: r.success ? undefined : r.error });
          break;
        }
        case "scheduler_resume": {
          const r = _scheduler.resumeJobFromTool(args.id as string, args.agent_id as string, args.channel as string);
          resultText = JSON.stringify({ ok: r.success, error: r.success ? undefined : r.error });
          break;
        }
        case "scheduler_history": {
          const limit = Math.min((args.limit as number) || 10, 50);
          const runs = _scheduler.getJobRunsForTool(args.id as string, limit, args.channel as string | undefined);
          resultText = JSON.stringify({ ok: true, runs });
          break;
        }
        default:
          resultText = JSON.stringify({
            ok: false,
            error: `Unknown scheduler tool: ${name}`,
          });
      }
      return { content: [{ type: "text", text: resultText }] };
    }

    switch (name) {
      case "chat_poll_and_ack": {
        const channel = args.channel as string;
        const agentId = (args.agent_id as string) || "default";
        const includeBot = args.include_bot === true;
        const limit = Math.min(Math.max(1, (args.limit as number) || 20), 100);
        const offset = Math.max(0, (args.offset as number) || 0);

        // Get agent's last processed timestamp (for filtering pending)
        const agentState = db
          .query<{ last_seen_ts: string | null; last_processed_ts: string | null }, [string, string]>(
            `SELECT last_seen_ts, last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
          )
          .get(agentId, channel);

        let lastProcessedTs = agentState?.last_processed_ts;

        // Get all messages (for seen-marking and context)
        const allResult = getPendingMessages(channel, undefined, true);
        const messages = allResult.messages || [];

        // IMPORTANT: If this is a new agent (no last_processed_ts), auto-initialize
        // to avoid overwhelming the agent with ALL historical messages as "pending"
        // Only show the most recent UHUMAN message(s) as pending
        if (!lastProcessedTs && messages.length > 0) {
          // Find all actionable messages (from humans and workers)
          const actionableMessages = messages.filter(
            (m: { user: string; agent_id?: string }) =>
              m.user === "UHUMAN" ||
              m.user.startsWith("UWORKER-") ||
              (m.user === "UBOT" && m.agent_id && m.agent_id !== agentId),
          );
          if (actionableMessages.length > 1) {
            lastProcessedTs = actionableMessages[actionableMessages.length - 2].ts;
          } else if (actionableMessages.length === 1) {
            lastProcessedTs = null;
          }
          // Note: We don't persist this auto-initialization - agent should call mark_processed
        }

        // Filter pending = messages from others after last_processed_ts
        // Always include UHUMAN; optionally include UWORKER-* and other UBOT agents
        const allPending = messages.filter(
          (m: { user: string; ts: string; agent_id?: string }) =>
            (m.user === "UHUMAN" ||
              (includeBot &&
                (m.user.startsWith("UWORKER-") || (m.user === "UBOT" && m.agent_id && m.agent_id !== agentId)))) &&
            (!lastProcessedTs || m.ts > lastProcessedTs),
        );
        const totalPending = allPending.length;
        const pending = allPending.slice(offset, offset + limit);

        // Mark ALL messages as SEEN immediately, also update last_poll_ts
        if (messages.length > 0) {
          const maxTs = messages.reduce((max: string, m: { ts: string }) => (m.ts > max ? m.ts : max), "0");
          const nowTs = Math.floor(Date.now() / 1000);
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
             VALUES (?, ?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
             last_seen_ts = excluded.last_seen_ts, last_poll_ts = excluded.last_poll_ts, updated_at = excluded.updated_at`,
            [agentId, channel, maxTs, nowTs],
          );

          // Mark individual messages as seen by this agent (for multi-agent seen_by tracking)
          // Returns only NEWLY seen messages (not already marked as seen by this agent)
          const messageTsList = messages.map((m: { ts: string }) => m.ts);
          const newlySeen = markMessagesSeen(channel, agentId, messageTsList);

          // Broadcast seen event to UI for real-time updates
          // Only broadcast the LAST seen message (not all of them - causes UI lag with O(n*m) updates)
          if (newlySeen.length > 0) {
            // Find the last non-self message to show where agent's read position is
            const lastNonSelfMsg = messages
              .filter(
                (m: { user: string }) => m.user === "UHUMAN" || (m.user !== "UBOT" && !m.user.startsWith("UWORKER")),
              )
              .slice(-1)[0];
            if (lastNonSelfMsg && newlySeen.includes(lastNonSelfMsg.ts)) {
              broadcastMessageSeen(channel, lastNonSelfMsg.ts, agentId);
            }
          }
        } else {
          // Even if no messages, still update last_poll_ts to show agent is alive
          const nowTs = Math.floor(Date.now() / 1000);
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_poll_ts, updated_at)
             VALUES (?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
             last_poll_ts = excluded.last_poll_ts, updated_at = excluded.updated_at`,
            [agentId, channel, nowTs],
          );
        }

        // Add seen_by to pending messages
        const pendingWithSeenBy = pending.map((m: { ts: string; text?: string }) => {
          const seenBy = getMessageSeenBy(channel, m.ts);
          const seenByWithColors = seenBy.map((aid) => {
            const agent = getAgent(aid, channel);
            return {
              agent_id: aid,
              avatar_color: agent?.avatar_color || "#D97853",
            };
          });
          return { ...m, seen_by: seenByWithColors };
        });

        // Truncate message text for agent context
        const truncatedPending = pendingWithSeenBy.map((m) => ({
          ...m,
          text: truncateForAgent(m.text),
        }));

        resultText = JSON.stringify(
          {
            ok: true,
            pending: truncatedPending,
            last_seen_ts: messages.length > 0 ? messages[messages.length - 1].ts : null,
            last_processed_ts: lastProcessedTs,
            count: totalPending,
            has_more: offset + limit < totalPending,
            ...(offset > 0 && { offset }),
            ...(limit !== 20 && { limit }),
          },
          null,
          2,
        );
        break;
      }

      case "chat_mark_processed": {
        const channel = args.channel as string;
        const timestamp = args.timestamp as string;
        const agentId = (args.agent_id as string) || "default";

        db.run(
          `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
           VALUES (?, ?, ?, ?, strftime('%s', 'now'))
           ON CONFLICT(agent_id, channel) DO UPDATE SET
           last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), excluded.last_processed_ts), updated_at = excluded.updated_at`,
          [agentId, channel, timestamp, timestamp],
        );

        resultText = JSON.stringify(
          {
            ok: true,
            agent_id: agentId,
            channel,
            last_processed_ts: timestamp,
          },
          null,
          2,
        );
        break;
      }

      case "chat_send_message": {
        const channel = args.channel as string;
        const text = args.text as string;
        const agentId = args.agent_id as string;
        const userOverride = args.user as string | undefined;

        // Validate parameter order - detect if agent swapped text and agent_id
        if (agentId && text) {
          // Check 1: text looks like an agent ID (short, alphanumeric with spaces/apostrophes for names like "Claw'd")
          const textLooksLikeAgentId =
            text.length <= 25 &&
            /^[A-Za-z0-9_'\-\s]+$/.test(text) &&
            (text.toLowerCase().includes("clawd") ||
              text.toLowerCase().includes("claw'd") ||
              !text.includes(" ") ||
              text.split(" ").length <= 3); // At most 3 words like "Claw'd 2"

          // Check 2: agent_id looks like a message (long, has multiple spaces, punctuation, newlines)
          const agentIdLooksLikeMessage =
            agentId.length > 30 ||
            (agentId.includes(" ") && agentId.split(" ").length > 3) ||
            agentId.includes("\n") ||
            agentId.includes(".") ||
            agentId.includes(",") ||
            agentId.includes("!") ||
            agentId.includes("?");

          if (textLooksLikeAgentId && agentIdLooksLikeMessage) {
            resultText = JSON.stringify(
              {
                ok: false,
                error: "PARAMETER_ORDER_ERROR",
                message:
                  "It looks like you swapped 'text' and 'agent_id' parameters. " +
                  "The 'text' field should contain your message content, and 'agent_id' should be your short identifier. " +
                  `You sent: text="${text}", agent_id="${agentId.substring(0, 50)}...". ` +
                  'Please call again with: text="<your message>", agent_id="<your agent name>"',
              },
              null,
              2,
            );
            break;
          }
        }

        // Use user override if provided, otherwise default to UBOT
        const userId = userOverride || "UBOT";
        const htmlPreview = args.html_preview as string | undefined;
        const workspaceJson = args.workspace_json as string | undefined;
        const codePreview = args.code_preview as
          | {
              filename: string;
              language: string;
              content: string;
              start_line?: number;
              highlight_lines?: number[];
            }
          | undefined;
        const interactiveJson = args.interactive_json as Record<string, any> | undefined;

        const result = postMessage({
          channel,
          text,
          user: userId,
          agent_id: agentId,
          html_preview: htmlPreview,
          code_preview: codePreview,
          workspace_json: workspaceJson,
          interactive_json: interactiveJson ? JSON.stringify(interactiveJson) : undefined,
        });

        // Broadcast to WebSocket clients so UI updates immediately (no 10s poll wait)
        if (result.ok && result.ts) {
          const rawMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(result.ts);
          if (rawMsg) broadcastMessage(channel, rawMsg);
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_history": {
        const channel = args.channel as string;
        const limit = Math.min((args.limit as number) || 50, 200);

        const result = getConversationHistory(channel, limit);

        // Add seen_by to each message
        if (result.messages) {
          result.messages = result.messages.map((m) => {
            const seenBy = getMessageSeenBy(channel, m.ts);
            const seenByWithColors = seenBy.map((aid) => {
              const agent = getAgent(aid, channel);
              return {
                agent_id: aid,
                avatar_color: agent?.avatar_color || "#D97853",
              };
            });
            return {
              ...m,
              text: truncateForAgent(m.text),
              seen_by: seenByWithColors,
            };
          }) as typeof result.messages;
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_message": {
        const _channel = args.channel as string;
        const ts = args.ts as string;

        const message = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);

        if (!message) {
          resultText = JSON.stringify({
            ok: false,
            error: "Message not found",
          });
        } else {
          const slackMsg = toSlackMessage(message);
          resultText = JSON.stringify(
            {
              ok: true,
              message: { ...slackMsg, text: truncateForAgent(slackMsg.text) },
            },
            null,
            2,
          );
        }
        break;
      }

      case "chat_get_message_files": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const includeContent = args.include_content === true;

        // Get message first to verify it exists
        const message = db
          .query<Message, [string, string]>(`SELECT * FROM messages WHERE channel = ? AND ts = ?`)
          .get(channel, ts);

        if (!message) {
          resultText = JSON.stringify({
            ok: false,
            error: "Message not found",
          });
          break;
        }

        // Get files attached to this message
        const files = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE message_ts = ?`)
          .all(ts);

        const fileResults = [];
        for (const file of files) {
          const fileInfo: Record<string, unknown> = {
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size,
          };

          // Images NEVER return base64 — always provide hint to use read_image tool
          if (file.mimetype.toLowerCase().startsWith("image/")) {
            fileInfo.image_hint =
              `This is an image file (${file.name}, ${file.mimetype}, ${file.size} bytes). ` +
              `To analyze or describe this image, use the read_image tool with file_id="${file.id}". ` +
              `Do NOT attempt to read the image as base64 as it may exceed context limits.`;
          } else if (includeContent && file.size < 1024 * 1024) {
            // Include base64 content if requested and file is small enough (<1MB)
            try {
              const fileData = await Bun.file(file.path).arrayBuffer();
              fileInfo.content_base64 = Buffer.from(fileData).toString("base64");
            } catch {
              fileInfo.content_error = "Could not read file content";
            }
          }

          fileResults.push(fileInfo);
        }

        resultText = JSON.stringify({ ok: true, files: fileResults });
        break;
      }

      case "chat_download_file": {
        const fileId = args.file_id as string;
        const projectRoot = args._project_root as string | undefined; // Injected by agent plugin

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else {
          const response: Record<string, unknown> = {
            ok: true,
            file: {
              id: file.id,
              name: file.name,
              mimetype: file.mimetype,
              size: file.size,
            },
          };

          // Images — always provide hint to use read_image tool
          if (file.mimetype.toLowerCase().startsWith("image/")) {
            (response.file as Record<string, unknown>).image_hint =
              `This is an image file (${file.name}, ${file.mimetype}, ${file.size} bytes). ` +
              `To analyze or describe this image, use the read_image tool with file_id="${file.id}". ` +
              `Do NOT attempt to read the image as base64 as it may exceed context limits.`;
          }

          // Auto-save file to {projectRoot}/.clawd/files/ if project root is available
          if (projectRoot) {
            try {
              const { mkdirSync, copyFileSync, existsSync: fsExists } = await import("node:fs");
              const { join: pathJoin, extname, basename } = await import("node:path");

              const filesDir = pathJoin(projectRoot, ".clawd", "files");
              mkdirSync(filesDir, { recursive: true });

              // Determine target filename — use basename only to prevent path traversal
              let targetName = basename(file.name);
              let targetPath = pathJoin(filesDir, targetName);
              if (fsExists(targetPath)) {
                // Add file ID prefix to deduplicate
                const ext = extname(file.name);
                const base = basename(file.name, ext);
                targetName = `${base}-${file.id}${ext}`;
                targetPath = pathJoin(filesDir, targetName);
              }

              copyFileSync(file.path, targetPath);
              (response.file as Record<string, unknown>).local_path = targetPath;
              response.hint =
                `File saved to: ${targetPath}\n` +
                `You can read this file using view("${targetPath}") or bash tools (cat, head, etc.).\n` +
                `For documents (PDF, DOCX, XLSX, PPTX), use convert_to_markdown(path="${targetPath || file.path}") to convert to readable text.`;
            } catch (saveErr: unknown) {
              response.hint =
                `Failed to save file locally: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}. ` +
                `Use chat_read_file_range(file_id="${file.id}") to read the file content directly.`;
            }
          } else {
            response.hint =
              `File metadata retrieved. Use chat_read_file_range(file_id="${file.id}") to read the file content. ` +
              `For documents (PDF, DOCX, XLSX, PPTX), use convert_to_markdown(path="${file.path}") to convert to readable text.`;
          }

          resultText = JSON.stringify(response);
        }
        break;
      }

      case "chat_read_file_range": {
        const fileId = args.file_id as string;
        const mode = (args.mode as string) || "bytes";
        const start = args.start as number | undefined;
        const end = args.end as number | undefined;
        const encoding = (args.encoding as string) || "utf8";

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
          break;
        }

        // Block ALL image file content — use read_image tool instead
        if (file.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `Cannot read image file content. Use the read_image tool with file_id="${file.id}" to analyze this image instead.`,
          });
          break;
        }

        try {
          const bunFile = Bun.file(file.path);
          const fileBuffer = Buffer.from(await bunFile.arrayBuffer());

          let content: string;
          let actualStart: number;
          let actualEnd: number;
          let totalLines: number | undefined;

          if (mode === "lines") {
            // Read by lines
            const text = fileBuffer.toString("utf8");
            const lines = text.split("\n");
            totalLines = lines.length;

            actualStart = start !== undefined ? (start < 0 ? Math.max(0, lines.length + start) : start) : 0;
            actualEnd = end !== undefined ? Math.min(end, lines.length) : lines.length;

            const selectedLines = lines.slice(actualStart, actualEnd);
            content =
              encoding === "base64"
                ? Buffer.from(selectedLines.join("\n")).toString("base64")
                : selectedLines.join("\n");
          } else {
            // Read by bytes
            actualStart = start !== undefined ? (start < 0 ? Math.max(0, file.size + start) : start) : 0;
            actualEnd = end !== undefined ? Math.min(end, file.size) : file.size;

            const slice = fileBuffer.subarray(actualStart, actualEnd);
            content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");
          }

          resultText = JSON.stringify(
            {
              ok: true,
              file_id: file.id,
              mode,
              start: actualStart,
              end: actualEnd,
              total_size: file.size,
              ...(totalLines !== undefined && { total_lines: totalLines }),
              content: truncateForAgent(content),
              has_more: actualEnd < (mode === "lines" ? totalLines || 0 : file.size),
            },
            null,
            2,
          );
        } catch (err) {
          resultText = JSON.stringify({
            ok: false,
            error: `Failed to read file: ${err}`,
          });
        }
        break;
      }

      case "chat_upload_file": {
        const contentBase64 = args.content_base64 as string;
        const filename = args.filename as string;
        const mimetype = args.mimetype as string;
        const _channel = args.channel as string;

        // Decode base64 content
        const buffer = Buffer.from(contentBase64, "base64");

        // Generate file ID and path
        const id = `F${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const ext = filename.split(".").pop() || "";
        const storedFilename = `${id}.${ext}`;
        const { ATTACHMENTS_DIR } = await import("../database");
        const { join } = await import("node:path");
        const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");

        // Ensure attachments directory exists
        if (!existsSync(ATTACHMENTS_DIR)) {
          mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        }

        const filepath = join(ATTACHMENTS_DIR, storedFilename);
        writeFileSync(filepath, buffer);

        // Insert file record
        db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
          id,
          filename,
          mimetype,
          buffer.length,
          filepath,
          "UBOT",
        ]);

        resultText = JSON.stringify(
          {
            ok: true,
            file: {
              id,
              name: filename,
              mimetype,
              size: buffer.length,
            },
          },
          null,
          2,
        );
        break;
      }

      case "chat_upload_local_file": {
        const filePath = args.file_path as string;
        const _channel = args.channel as string;
        const _agentId = (args.agent_id as string) || "default";

        const { basename, extname, join, resolve: resolvePath } = await import("node:path");
        const { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } = await import("node:fs");
        const { ATTACHMENTS_DIR } = await import("../database");

        // A-1: Path allowlist — only permit files under projectRoot, /tmp, or the
        // server's current working directory.  Symlink-safe via realpathSync.
        let resolvedFilePath: string;
        {
          // A-1c: Use agent's project root from DB.
          // If the agent has no project configured, isUnderProjectRoot is always false —
          // only /tmp uploads are permitted. Falling back to process.cwd() would allow
          // uploading arbitrary server-side files for unconfigured agents.
          const agentRow = db
            .query<{ project: string | null }, [string, string]>(
              "SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?",
            )
            .get(_channel, _agentId);
          try {
            resolvedFilePath = existsSync(filePath) ? realpathSync(filePath) : resolvePath(filePath);
          } catch {
            resolvedFilePath = resolvePath(filePath);
          }
          const configuredProject = agentRow?.project;
          const projectRoot = configuredProject ? resolvePath(configuredProject) : null;
          const isUnderProjectRoot =
            projectRoot !== null &&
            (resolvedFilePath === projectRoot || resolvedFilePath.startsWith(`${projectRoot}/`));
          // A-1b: Resolve canonical /tmp path (handles macOS /tmp → /private/tmp symlink)
          const canonicalTmp = (() => {
            try {
              return realpathSync("/tmp");
            } catch {
              return "/tmp";
            }
          })();
          const isUnderTmp = resolvedFilePath === canonicalTmp || resolvedFilePath.startsWith(canonicalTmp + "/");
          if (!isUnderProjectRoot && !isUnderTmp) {
            resultText = JSON.stringify({
              ok: false,
              error: `Access denied: file path "${filePath}" is outside allowed directories (project root or /tmp).`,
            });
            break;
          }
        }

        // A-1a: Use resolvedFilePath consistently to avoid TOCTOU races
        // Validate file exists
        if (!existsSync(resolvedFilePath)) {
          resultText = JSON.stringify({
            ok: false,
            error: `File not found: ${filePath}`,
          });
          break;
        }

        // Check it's a file (not directory)
        const stat = statSync(resolvedFilePath);
        if (!stat.isFile()) {
          resultText = JSON.stringify({
            ok: false,
            error: `Not a file: ${filePath}`,
          });
          break;
        }

        // A-5: File size limit — reject files larger than 50 MB before reading
        const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
        if (stat.size > MAX_UPLOAD_BYTES) {
          resultText = JSON.stringify({
            ok: false,
            error: `File too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`,
          });
          break;
        }

        // Read the file
        const buffer = readFileSync(resolvedFilePath);

        // Determine filename — use original filePath for display name so symlink names are preserved
        const displayName = (args.filename as string) || basename(filePath);

        // Auto-detect mimetype from extension — use original filePath extension for same reason
        const MIME_MAP: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".bmp": "image/bmp",
          ".pdf": "application/pdf",
          ".json": "application/json",
          ".xml": "application/xml",
          ".html": "text/html",
          ".htm": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".ts": "text/typescript",
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".csv": "text/csv",
          ".zip": "application/zip",
          ".gz": "application/gzip",
          ".tar": "application/x-tar",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".ttf": "font/ttf",
          ".otf": "font/otf",
        };
        const ext = extname(filePath).toLowerCase();
        const detectedMime = MIME_MAP[ext] || "application/octet-stream";
        const mimetype = (args.mimetype as string) || detectedMime;

        // Generate file ID and store
        const id = `F${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const storedExt = ext.replace(".", "") || "bin";
        const storedFilename = `${id}.${storedExt}`;

        if (!existsSync(ATTACHMENTS_DIR)) {
          mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        }

        const destPath = join(ATTACHMENTS_DIR, storedFilename);
        writeFileSync(destPath, buffer);

        // Insert file record
        db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
          id,
          displayName,
          mimetype,
          buffer.length,
          destPath,
          "UBOT",
        ]);

        resultText = JSON.stringify(
          {
            ok: true,
            file: {
              id,
              name: displayName,
              mimetype,
              size: buffer.length,
            },
          },
          null,
          2,
        );
        break;
      }

      case "chat_send_message_with_files": {
        const channel = args.channel as string;
        const text = args.text as string;
        const fileIds = args.file_ids as string[];
        const agentId = args.agent_id as string;

        // Post the message with agent_id
        const msgResult = postMessage({
          channel,
          text,
          user: "UBOT",
          agent_id: agentId,
        });

        if (msgResult.ok && fileIds && fileIds.length > 0) {
          // Attach files to the message
          const { attachFilesToMessage } = await import("../routes/files");
          const files = attachFilesToMessage(msgResult.ts, fileIds);

          // Broadcast to WebSocket clients so UI updates immediately
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(msgResult.ts);
          if (updatedMsg) broadcastMessage(channel, updatedMsg);

          resultText = JSON.stringify(
            {
              ok: true,
              ts: msgResult.ts,
              channel,
              files,
            },
            null,
            2,
          );
        } else {
          if (msgResult.ok && msgResult.ts) {
            const rawMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(msgResult.ts);
            if (rawMsg) broadcastMessage(channel, rawMsg);
          }
          resultText = JSON.stringify(msgResult);
        }
        break;
      }

      case "chat_delete_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;

        // Import deleteMessage from routes
        const { deleteMessage } = await import("../routes/messages");
        const result = deleteMessage(channel, ts);

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_update_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const text = args.text as string;

        // Import updateMessage from routes
        const { updateMessage } = await import("../routes/messages");
        const result = updateMessage({ channel, ts, text });

        // Broadcast update to WebSocket clients if successful
        if (result.ok) {
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);
          if (updatedMsg) {
            broadcastUpdate(channel, toSlackMessage(updatedMsg));
          }
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_artifact_actions": {
        const messageTs = args.message_ts as string;
        const { getArtifactActions: getActions } = await import("../routes/artifact-actions");
        const result = getActions(messageTs, args.channel as string);
        resultText = JSON.stringify(result);
        break;
      }

      case "chat_append_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const text = args.text as string;
        const separator = args.separator as string | undefined;

        const { appendMessage } = await import("../routes/messages");
        const result = appendMessage({ channel, ts, text, separator });

        // Broadcast update to WebSocket clients if successful
        if (result.ok) {
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);
          if (updatedMsg) {
            broadcastUpdate(channel, toSlackMessage(updatedMsg));
          }
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_query_messages": {
        const channel = args.channel as string;
        const fromTs = args.from_ts as string | undefined;
        const toTs = args.to_ts as string | undefined;
        const roles = args.roles as string[] | undefined;
        const search = args.search as string | undefined;
        const searchRegex = args.search_regex as string | undefined;
        const hasAttachments = args.has_attachments as boolean | undefined;
        const hasImages = args.has_images as boolean | undefined;
        const limit = Math.min(Math.max((args.limit as number) || 100, 1), 500);

        // Build WHERE clause
        const conditions: string[] = ["channel = ?"];
        const params: (string | number)[] = [channel];

        if (fromTs) {
          conditions.push("ts > ?");
          params.push(fromTs);
        }
        if (toTs) {
          conditions.push("ts < ?");
          params.push(toTs);
        }
        if (roles && roles.length > 0) {
          // Map roles to user patterns
          const roleConditions: string[] = [];
          for (const role of roles) {
            if (role === "bot") roleConditions.push("user = 'UBOT'");
            if (role === "worker") roleConditions.push("user LIKE 'UWORKER-%'");
            if (role === "human") roleConditions.push("user = 'UHUMAN'");
          }
          if (roleConditions.length > 0) {
            conditions.push(`(${roleConditions.join(" OR ")})`);
          }
        }
        if (search) {
          conditions.push("text LIKE ?");
          params.push(`%${search}%`);
        }
        // Note: search_regex is applied post-query (SQLite doesn't support regex natively)
        if (hasAttachments === true) {
          conditions.push("files_json != '[]' AND files_json IS NOT NULL");
        }
        if (hasImages === true) {
          conditions.push("(files_json LIKE '%image/%' OR files_json LIKE '%\"mimetype\":\"image%')");
        }

        const whereClause = conditions.join(" AND ");
        // Fetch more if regex filtering will be applied
        const fetchLimit = searchRegex ? limit * 10 : limit + 1;
        const query = `SELECT * FROM messages WHERE ${whereClause} ORDER BY ts ASC LIMIT ?`;
        params.push(fetchLimit);

        let messages = db.query<Message, (string | number)[]>(query).all(...params);

        // Apply regex filter post-query (A-4: run in worker thread with 5s timeout to prevent ReDoS)
        if (searchRegex) {
          // Validate the regex pattern is syntactically valid first (cheap, no risk)
          try {
            new RegExp(searchRegex, "i");
          } catch (e) {
            resultText = JSON.stringify({
              ok: false,
              error: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
            });
            break;
          }

          // Run the actual matching in a worker thread to isolate catastrophic backtracking
          const { Worker } = await import("worker_threads");
          const textsToMatch = messages.map((m) => m.text || "");
          const workerCode = `
            const { workerData, parentPort } = require('worker_threads');
            try {
              const regex = new RegExp(workerData.pattern, 'i');
              const matched = workerData.texts.map((t) => regex.test(t));
              parentPort.postMessage({ ok: true, matched });
            } catch (e) {
              parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          `;

          const matchResult = await new Promise<{ ok: boolean; matched?: boolean[]; error?: string }>((resolve) => {
            const worker = new Worker(workerCode, {
              eval: true,
              workerData: { pattern: searchRegex, texts: textsToMatch },
            });
            const timeoutId = setTimeout(() => {
              worker.terminate();
              resolve({ ok: false, error: "Regex timed out (possible ReDoS). Pattern took longer than 5 seconds." });
            }, 5000);
            worker.on("message", (msg) => {
              clearTimeout(timeoutId);
              worker.terminate();
              resolve(msg);
            });
            worker.on("error", (err: Error) => {
              clearTimeout(timeoutId);
              worker.terminate();
              resolve({ ok: false, error: err.message });
            });
          });

          if (!matchResult.ok) {
            resultText = JSON.stringify({
              ok: false,
              error: matchResult.error || "Regex evaluation failed",
            });
            break;
          }

          messages = messages.filter((_, i) => matchResult.matched![i]);
        }

        const hasMore = messages.length > limit;
        if (hasMore) messages = messages.slice(0, limit);

        resultText = JSON.stringify(
          {
            ok: true,
            messages: messages.map((m) => {
              const sm = toSlackMessage(m);
              return { ...sm, text: truncateForAgent(sm.text) };
            }),
            count: messages.length,
            has_more: hasMore,
          },
          null,
          2,
        );
        break;
      }

      case "chat_get_last_summary": {
        const channel = args.channel as string;
        const agentId = (args.agent_id as string) || "default";

        // Essential files to include after compaction for context restoration
        const ESSENTIAL_FILES = [`${homedir()}/.clawd/CLAWD.md`];

        // Read essential files content
        let essentialFilesContent = "";
        for (const filePath of ESSENTIAL_FILES) {
          try {
            const content = await Bun.file(filePath).text();
            essentialFilesContent += `\n\n---\n## Essential File: ${filePath}\n\`\`\`markdown\n${content}\n\`\`\`\n`;
          } catch {
            // File not found - skip
          }
        }

        // Get the most recent summary for this channel/agent
        const summary = db
          .query<
            {
              id: string;
              summary: string;
              from_ts: string;
              to_ts: string;
              message_count: number;
              created_at: number;
            },
            [string, string]
          >(
            `SELECT id, summary, from_ts, to_ts, message_count, created_at
           FROM summaries
           WHERE channel = ? AND agent_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          )
          .get(channel, agentId);

        if (summary) {
          resultText = JSON.stringify(
            {
              ok: true,
              has_summary: true,
              summary: truncateForAgent(summary.summary),
              essential_files: truncateForAgent(essentialFilesContent.trim()) || null,
              ts: generateTs(), // Current timestamp
              from_ts: summary.from_ts,
              to_ts: summary.to_ts,
              message_count: summary.message_count,
              summary_id: summary.id,
              restore_hint: essentialFilesContent
                ? "Essential files included - read them to restore core knowledge after compaction."
                : null,
            },
            null,
            2,
          );
        } else {
          // No summary exists - return channel start info
          const firstMessage = db
            .query<{ ts: string }, [string]>(`SELECT MIN(ts) as ts FROM messages WHERE channel = ?`)
            .get(channel);

          resultText = JSON.stringify(
            {
              ok: true,
              has_summary: false,
              summary: "No prior summary - beginning of conversation",
              essential_files: truncateForAgent(essentialFilesContent.trim()) || null,
              from_ts: firstMessage?.ts || "0",
              to_ts: firstMessage?.ts || "0",
              message_count: 0,
              restore_hint: essentialFilesContent
                ? "Essential files included - read them to restore core knowledge."
                : null,
            },
            null,
            2,
          );
        }
        break;
      }

      case "chat_store_summary": {
        const channel = args.channel as string;
        const summary = args.summary as string;
        const fromTs = args.from_ts as string;
        const toTs = args.to_ts as string;
        const agentId = (args.agent_id as string) || "default";

        // Validate summary length
        if (summary.length > 5000) {
          resultText = JSON.stringify({
            ok: false,
            error: "Summary too long (max 5000 characters)",
          });
          break;
        }

        // Count messages in the range
        const countResult = db
          .query<{ count: number }, [string, string, string]>(
            `SELECT COUNT(*) as count FROM messages WHERE channel = ? AND ts >= ? AND ts <= ?`,
          )
          .get(channel, fromTs, toTs);
        const messageCount = countResult?.count || 0;

        // Generate summary ID and insert
        const summaryId = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

        db.run(
          `INSERT INTO summaries (id, channel, agent_id, summary, from_ts, to_ts, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [summaryId, channel, agentId, summary, fromTs, toTs, messageCount],
        );

        resultText = JSON.stringify(
          {
            ok: true,
            summary_id: summaryId,
            channel,
            agent_id: agentId,
            from_ts: fromTs,
            to_ts: toTs,
            message_count: messageCount,
          },
          null,
          2,
        );
        break;
      }

      // Plan tools
      case "plan_create": {
        const { createPlan } = await import("../routes/tasks");
        const plan = createPlan({
          channel: args.channel as string,
          title: args.title as string,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
          created_by: (args.created_by as string) || "agent",
        });
        resultText = JSON.stringify({ ok: true, plan });
        break;
      }

      case "plan_list": {
        const { listPlans } = await import("../routes/tasks");
        const plans = listPlans(args.channel as string);
        resultText = JSON.stringify({ ok: true, plans });
        break;
      }

      case "plan_get": {
        const { getPlan } = await import("../routes/tasks");
        const plan = getPlan(args.plan_id as string);
        if (!plan) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, plan });
        }
        break;
      }

      case "plan_update": {
        const { updatePlan } = await import("../routes/tasks");
        const plan = updatePlan(args.plan_id as string, {
          status: args.status as "active" | "completed" | "draft" | "cancelled" | undefined,
          title: args.title as string | undefined,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!plan) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, plan });
        }
        break;
      }

      case "plan_add_phase": {
        const { addPhase } = await import("../routes/tasks");
        const phase = addPhase(args.plan_id as string, {
          name: args.name as string,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!phase) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, phase });
        }
        break;
      }

      case "plan_update_phase": {
        const { updatePhase } = await import("../routes/tasks");
        const phase = updatePhase(args.phase_id as string, {
          status: args.status as "blocked" | "pending" | "active" | "completed" | "skipped" | undefined,
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!phase) {
          resultText = JSON.stringify({ ok: false, error: "Phase not found" });
        } else {
          resultText = JSON.stringify({ ok: true, phase });
        }
        break;
      }

      case "plan_link_task": {
        const { linkTaskToPhase } = await import("../routes/tasks");
        const success = linkTaskToPhase(args.plan_id as string, args.phase_id as string, args.task_id as string);
        resultText = JSON.stringify({
          ok: success,
          error: success ? undefined : "Failed to link task",
        });
        break;
      }

      case "plan_get_tasks": {
        const { getTasksForPlan } = await import("../routes/tasks");
        const phases = getTasksForPlan(args.plan_id as string);
        resultText = JSON.stringify({ ok: true, phases });
        break;
      }

      // ============================================================================
      // Multimodal Tool Handlers
      // ============================================================================

      case "read_image": {
        const fileId = args.file_id as string;
        const prompt =
          (args.prompt as string) ||
          "Describe this image in detail, including any text, diagrams, or notable visual elements.";

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `File is not an image (${file.mimetype})`,
          });
        } else {
          const result = await analyzeImage(file.path, prompt, [ATTACHMENTS_DIR, "/tmp"]);
          resultText = JSON.stringify({
            ok: result.ok,
            file: { id: file.id, name: file.name, mimetype: file.mimetype },
            ...(result.ok ? { analysis: result.result } : { error: result.error }),
          });
        }
        break;
      }

      case "create_image": {
        const prompt = args.prompt as string;
        const aspectRatio = (args.aspect_ratio as string) || "1:1";
        const imageSize = (args.image_size as string) || "1K";

        const validAspectRatios = [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
          "1:4",
          "4:1",
          "1:8",
          "8:1",
        ];
        if (!validAspectRatios.includes(aspectRatio)) {
          resultText = JSON.stringify({
            ok: false,
            error: `Invalid aspect_ratio: "${aspectRatio}". Valid: ${validAspectRatios.join(", ")}`,
          });
          break;
        }
        const validImageSizes = ["512px", "1K", "2K", "4K"];
        if (!validImageSizes.includes(imageSize)) {
          resultText = JSON.stringify({
            ok: false,
            error: `Invalid image_size: "${imageSize}". Valid: ${validImageSizes.join(", ")}`,
          });
          break;
        }

        const fileId = generateId("F");
        const baseName = `generated-${fileId}-${Date.now()}`;
        const outputPath = join(ATTACHMENTS_DIR, `${baseName}.png`);

        const result = await generateImage(prompt, outputPath, aspectRatio, [ATTACHMENTS_DIR, "/tmp"], imageSize);

        if (result.ok && result.path) {
          try {
            const actualPath = result.path;
            const ext = actualPath.split(".").pop()?.toLowerCase() || "png";
            const fileName = `${baseName}.${ext}`;
            const mimetype = result.mimeType || "image/png";
            const stat = statSync(actualPath);

            db.run("INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)", [
              fileId,
              fileName,
              mimetype,
              stat.size,
              actualPath,
              "system",
            ]);

            const quota = getImageQuotaStatus();
            resultText = JSON.stringify({
              ok: true,
              image: {
                id: fileId,
                name: fileName,
                path: actualPath,
                mimetype,
                size: stat.size,
                prompt,
                aspect_ratio: aspectRatio,
              },
              quota: {
                used: quota.used,
                limit: quota.limit,
                remaining: quota.remaining,
              },
            });
          } catch (err) {
            resultText = JSON.stringify({
              ok: false,
              error: `Image generated but failed to register: ${err instanceof Error ? err.message : String(err)}`,
              quota: getImageQuotaStatus(),
            });
          }
        } else {
          resultText = JSON.stringify({
            ok: false,
            error: result.error,
            quota: getImageQuotaStatus(),
          });
        }
        break;
      }

      case "edit_image": {
        const sourceFileId = args.file_id as string;
        const prompt = args.prompt as string;

        const sourceFile = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(sourceFileId);

        if (!sourceFile) {
          resultText = JSON.stringify({
            ok: false,
            error: "Source file not found",
          });
        } else if (!sourceFile.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `Source file is not an image (${sourceFile.mimetype})`,
          });
        } else {
          const newFileId = generateId("F");
          const baseName = `edited-${newFileId}-${Date.now()}`;
          const outputPath = join(ATTACHMENTS_DIR, `${baseName}.png`);

          const result = await editImage(sourceFile.path, prompt, outputPath, [ATTACHMENTS_DIR, "/tmp"]);

          if (result.ok && result.path) {
            try {
              const actualPath = result.path;
              const ext = actualPath.split(".").pop()?.toLowerCase() || "png";
              const fileName = `${baseName}.${ext}`;
              const mimetype = result.mimeType || "image/png";
              const stat = statSync(actualPath);

              db.run("INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)", [
                newFileId,
                fileName,
                mimetype,
                stat.size,
                actualPath,
                "system",
              ]);

              const quota = getImageQuotaStatus();
              resultText = JSON.stringify({
                ok: true,
                image: {
                  id: newFileId,
                  name: fileName,
                  path: actualPath,
                  mimetype,
                  size: stat.size,
                  source_file_id: sourceFileId,
                  prompt,
                },
                quota: {
                  used: quota.used,
                  limit: quota.limit,
                  remaining: quota.remaining,
                },
              });
            } catch (err) {
              resultText = JSON.stringify({
                ok: false,
                error: `Image edited but failed to register: ${err instanceof Error ? err.message : String(err)}`,
                quota: getImageQuotaStatus(),
              });
            }
          } else {
            resultText = JSON.stringify({
              ok: false,
              error: result.error,
              quota: getImageQuotaStatus(),
            });
          }
        }
        break;
      }

      case "read_video": {
        const fileId = args.file_id as string;
        const prompt =
          (args.prompt as string) ||
          "Describe what happens in this video, including any spoken content, on-screen text, and key visual elements.";
        const maxFrames = (args.max_frames as number) || 30;

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("video/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `File is not a video (${file.mimetype})`,
          });
        } else {
          const result = await analyzeVideo(file.path, prompt, [ATTACHMENTS_DIR, "/tmp"], maxFrames);
          resultText = JSON.stringify({
            ok: result.ok,
            file: { id: file.id, name: file.name, mimetype: file.mimetype },
            ...(result.ok ? { analysis: result.result } : { error: result.error }),
          });
        }
        break;
      }

      case "web_search": {
        const { webSearch } = await import("../../agent/tools/web-search");
        const query = args.query as string;
        const maxResults = (args.max_results as number) || 5;
        const allowedDomains = args.allowed_domains as string[] | undefined;
        const blockedDomains = args.blocked_domains as string[] | undefined;
        if (!query) {
          resultText = JSON.stringify({ ok: false, error: "Missing required parameter: query" });
          break;
        }
        let effectiveQuery = query;
        if (Array.isArray(allowedDomains) && allowedDomains.length > 0)
          effectiveQuery += " " + allowedDomains.map((d) => `site:${d}`).join(" OR ");
        const searchResult = await webSearch(effectiveQuery, maxResults);
        const filtered =
          Array.isArray(blockedDomains) && blockedDomains.length > 0
            ? {
                ...searchResult,
                results: (searchResult as any).results?.filter(
                  (r: any) => !blockedDomains.some((d) => r.url?.includes(d)),
                ),
              }
            : searchResult;
        resultText = JSON.stringify(filtered);
        break;
      }

      case "web_fetch": {
        const url = args.url as string;
        const raw = (args.raw as boolean) || false;
        const maxLength = (args.max_length as number) || 10000;
        if (!url) {
          resultText = JSON.stringify({ ok: false, error: "Missing required parameter: url" });
          break;
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          const fetchRes = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
              Accept: "text/html,application/json,text/plain,*/*",
            },
            signal: ctrl.signal,
          }).finally(() => clearTimeout(timer));
          if (!fetchRes.ok) {
            resultText = JSON.stringify({ ok: false, error: `HTTP ${fetchRes.status}: ${fetchRes.statusText}` });
            break;
          }
          const contentType = fetchRes.headers.get("content-type") || "";
          let content = await fetchRes.text();
          const { stripHtmlTagBlocks } = await import("../../agent/tools/registry");
          if (!raw && contentType.includes("text/html")) {
            content = stripHtmlTagBlocks(content, "script");
            content = stripHtmlTagBlocks(content, "style");
            content = content
              .replace(/<p[^>]*>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<li[^>]*>/gi, "- ")
              .replace(/<\/li>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, "&")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }
          if (content.length > maxLength) content = content.substring(0, maxLength) + "\n\n[Content truncated]";
          resultText = JSON.stringify({ ok: true, content });
        } catch (fetchErr: unknown) {
          resultText = JSON.stringify({
            ok: false,
            error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
        }
        break;
      }

      default:
        resultText = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    return {
      content: [{ type: "text", text: resultText }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : "Tool execution failed",
          }),
        },
      ],
    };
  }
}

// ============================================================================
// Space-Scoped MCP Handler (Claude Code sub-agents)
// ============================================================================

/**
 * Callback registry for Claude Code space workers.
 * When a Claude Code subprocess calls complete_task via MCP,
 * the handler looks up the resolve callback here.
 */
