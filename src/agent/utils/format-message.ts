import { formatAuthor } from "./format-author";

export type MessageKind = "pilot" | "system" | "sub-agent" | "agent";

interface MessageLike {
  ts?: string | number | null;
  user?: string | null;
  agent_id?: string | null;
  text?: string | null;
  files?: Array<{ name?: string | null }> | null;
  _repeatCount?: number;
}

function inferKind(msg: MessageLike): MessageKind {
  if (msg.user === "UHUMAN") return "pilot";
  if (msg.user === "USYSTEM") return "system";
  if (typeof msg.user === "string" && msg.user.startsWith("UWORKER-")) return "sub-agent";
  return "agent";
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Standard XML CDATA-escape trick: split the literal ]]> across two CDATA sections.
function escapeForCdata(s: string): string {
  return s.replace(/]]>/g, "]]]]><![CDATA[>");
}

/**
 * Wrap a channel message as an XML <message> block with sender attribution.
 * Untrusted text body is sealed inside a CDATA section, so an agent cannot
 * spoof a different sender by embedding fake "[ts] human:" prefixes.
 *
 * The wrapper is the canonical form sent to the Anthropic SDK as user-role
 * content. Agent X's own prior outputs are role:"assistant" and never pass
 * through this helper.
 */
export function formatMessageBlock(msg: MessageLike): string {
  const from = formatAuthor(msg);
  const kind = inferKind(msg);
  const ts = msg.ts == null ? "" : String(msg.ts);
  const filesPart =
    msg.files && msg.files.length > 0
      ? `\n[Attached files: ${msg.files.map((f) => f?.name || "unnamed").join(", ")}]`
      : "";
  const repeatPart = (msg._repeatCount ?? 1) > 1 ? `\n[×${msg._repeatCount} similar messages]` : "";
  const body = (msg.text ?? "") + filesPart + repeatPart;
  return `<message from="${escapeAttr(from)}" kind="${kind}" ts="${escapeAttr(ts)}"><![CDATA[${escapeForCdata(body)}]]></message>`;
}

// Matches the new <message> wrapper. Captures: ts, from, kind, body.
// Body is everything inside the CDATA section, including any escape-split
// CDATA pieces (which we collapse back during parse).
const MESSAGE_BLOCK_RE =
  /<message\s+from="([^"]*)"\s+kind="([^"]*)"\s+ts="([^"]*)"><!\[CDATA\[([\s\S]*?)\]\]><\/message>/g;

export interface ParsedMessageBlock {
  ts: string;
  from: string;
  kind: string;
  body: string;
}

/** Iterate <message> blocks in `s`, decoding CDATA escape splits. */
export function* parseMessageBlocks(s: string): Generator<ParsedMessageBlock> {
  MESSAGE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_BLOCK_RE.exec(s))) {
    const [, from, kind, ts, body] = m;
    // Reverse the CDATA split escape: "]]]]><![CDATA[>" → "]]>".
    const decoded = body.replace(/]]]]><!\[CDATA\[>/g, "]]>");
    yield { ts, from, kind, body: decoded };
  }
}
