import type { ServerWebSocket } from "bun";
import { getAgent, getMessageSeenBy, type Message, type SlackMessage, toSlackMessage } from "./database";
import { isDebugEnabled } from "../agent/src/utils/debug";

interface WebSocketData {
  userId: string;
  channel?: string; // Legacy single-channel field (kept for backward compatibility)
}

const clients = new Set<ServerWebSocket<WebSocketData>>();
// Track multi-channel subscriptions per client (ws.data can only hold simple types)
const clientChannels = new WeakMap<ServerWebSocket<WebSocketData>, Set<string>>();

function wsDebug(...args: unknown[]) {
  if (!isDebugEnabled()) return;
  console.log("[WS]", ...args);
}

export function handleWebSocketOpen(ws: ServerWebSocket<WebSocketData>) {
  clients.add(ws);
  clientChannels.set(ws, new Set());
  wsDebug(`Client connected (${clients.size} total)`);
}

export function handleWebSocketClose(ws: ServerWebSocket<WebSocketData>) {
  clients.delete(ws);
  clientChannels.delete(ws);
  wsDebug(`Client disconnected (${clients.size} total)`);
}

/** Check if a client is subscribed to a channel */
function isSubscribed(ws: ServerWebSocket<WebSocketData>, channel: string): boolean {
  const channels = clientChannels.get(ws);
  if (channels && channels.size > 0) {
    return channels.has(channel);
  }
  // Fallback: legacy single-channel field or no subscription (receive all)
  return !ws.data.channel || ws.data.channel === channel;
}

export function handleWebSocketMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
  try {
    const data = JSON.parse(message.toString());

    // Handle subscription to channel (supports multiple channels per client)
    if (data.type === "subscribe" && data.channel) {
      let channels = clientChannels.get(ws);
      if (!channels) {
        channels = new Set();
        clientChannels.set(ws, channels);
      }
      channels.add(data.channel);
      ws.data.channel = data.channel; // Keep legacy field updated
      ws.send(JSON.stringify({ type: "subscribed", channel: data.channel }));
    }

    // Handle unsubscribe from channel
    if (data.type === "unsubscribe" && data.channel) {
      const channels = clientChannels.get(ws);
      if (channels) {
        channels.delete(data.channel);
      }
      ws.send(JSON.stringify({ type: "unsubscribed", channel: data.channel }));
    }

    // Handle ping
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  } catch {
    // Ignore parse errors
  }
}

// Broadcast new message to all connected clients
export function broadcastMessage(channel: string, message: Message) {
  const slackMsg = toSlackMessage(message);

  // Add avatar_color and state flags for agent messages
  if (message.agent_id) {
    const agent = getAgent(message.agent_id, channel);
    (slackMsg as any).avatar_color = agent?.avatar_color || "#D97853";
    (slackMsg as any).is_sleeping = agent?.is_sleeping === 1;
    (slackMsg as any).is_streaming = agent?.is_streaming === 1;
  }

  const payload = JSON.stringify({
    type: "message",
    channel,
    message: slackMsg,
  });

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Broadcast message update
export function broadcastUpdate(channel: string, data: Message | SlackMessage | Record<string, unknown>) {
  // Check if it's a Message or custom data
  const payload = JSON.stringify(
    "ts" in data && "user" in data && "text" in data
      ? {
          type: "message_changed",
          channel,
          message: addSeenByToMessage(channel, data as Message),
        }
      : {
          ...data,
          channel,
        },
  );

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Broadcast reaction
export function broadcastReaction(
  channel: string,
  messageTs: string,
  reaction: string,
  user: string,
  type: "added" | "removed",
) {
  const payload = JSON.stringify({
    type: type === "added" ? "reaction_added" : "reaction_removed",
    channel,
    item: { ts: messageTs },
    reaction,
    user,
  });

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

export function getClientCount() {
  return clients.size;
}

// Broadcast that an agent has seen a message
export function broadcastMessageSeen(channel: string, messageTs: string, agentId: string) {
  const agent = getAgent(agentId, channel);
  const payload = JSON.stringify({
    type: "message_seen",
    channel,
    message_ts: messageTs,
    agent_id: agentId,
    avatar_color: agent?.avatar_color || "#D97853",
    is_sleeping: agent?.is_sleeping === 1,
  });

  wsDebug(`Broadcasting message_seen: agent=${agentId}, message_ts=${messageTs}, clients=${clients.size}`);

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Broadcast that an agent is streaming (thinking)
export function broadcastAgentStreaming(channel: string, agentId: string, isStreaming: boolean) {
  const agent = getAgent(agentId, channel);
  const payload = JSON.stringify({
    type: "agent_streaming",
    channel,
    agent_id: agentId,
    is_streaming: isStreaming,
    avatar_color: agent?.avatar_color || "#D97853",
  });

  wsDebug(`Broadcasting agent_streaming: agent=${agentId}, streaming=${isStreaming}, clients=${clients.size}`);

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Broadcast agent thinking tokens (real-time LLM output)
export function broadcastAgentToken(
  channel: string,
  agentId: string,
  token: string,
  tokenType: string = "content", // 'content' or 'thinking'
) {
  const agent = getAgent(agentId, channel);
  const payload = JSON.stringify({
    type: "agent_token",
    channel,
    agent_id: agentId,
    token,
    token_type: tokenType,
    avatar_color: agent?.avatar_color || "#D97853",
    timestamp: Date.now(),
  });

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Broadcast agent tool call events (started/completed/error)
export function broadcastAgentToolCall(
  channel: string,
  agentId: string,
  toolName: string,
  toolArgs: any,
  status: string,
  result?: any,
) {
  const agent = getAgent(agentId, channel);
  const payload = JSON.stringify({
    type: "agent_tool_call",
    channel,
    agent_id: agentId,
    tool_name: toolName,
    tool_args: toolArgs,
    status,
    avatar_color: agent?.avatar_color || "#D97853",
    result: result
      ? typeof result === "string"
        ? result.slice(0, 2000)
        : JSON.stringify(result).slice(0, 2000)
      : undefined,
    timestamp: Date.now(),
  });

  for (const client of clients) {
    if (isSubscribed(client, channel)) {
      client.send(payload);
    }
  }
}

// Helper to add seen_by to a message (for broadcast)
export function addSeenByToMessage(channel: string, message: Message) {
  const slackMsg = toSlackMessage(message);
  const seenBy = getMessageSeenBy(channel, message.ts);
  const seenByWithColors = seenBy.map((aid) => {
    const agent = getAgent(aid, channel);
    return {
      agent_id: aid,
      avatar_color: agent?.avatar_color || "#D97853",
      is_sleeping: agent?.is_sleeping === 1,
    };
  });
  return { ...slackMsg, seen_by: seenByWithColors };
}
