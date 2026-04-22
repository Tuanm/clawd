/**
 * Strip `<think>...</think>` (and `<thinking>...</thinking>`) reasoning blocks
 * from assistant text before persisting to the session DB.
 *
 * Why: some models (notably MiniMax-M2.7-highspeed) emit their chain-of-thought
 * inline in the response text. Persisting those blocks into conversation
 * history causes the model to see its own past reasoning on later turns and
 * repeat the patterns — e.g. "Now I need to respond to the user" becomes a
 * template the model keeps re-firing, leading to duplicate replies.
 *
 * Also normalises excess whitespace left behind after the strip. Returns the
 * trimmed result (empty string if the input was reasoning-only).
 */
export function stripReasoningBlocks(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
