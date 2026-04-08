/**
 * Smart truncation with head/tail preservation, code-block awareness,
 * line-boundary snapping, and UTF-16 surrogate safety.
 *
 * Replaces naive .slice() truncation to preserve error signatures,
 * stack traces, and compiler output at the tail.
 */

const DEFAULT_HEAD_RATIO = 0.6;
const DEFAULT_TAIL_RATIO = 0.4;

interface SmartTruncateOptions {
  /** Max output length in characters (default: 10000) */
  maxLength?: number;
  /** Ratio of head to preserve (default: 0.6) */
  headRatio?: number;
  /** Custom marker text (auto-generated if omitted) */
  marker?: string;
  /** Whether to snap to line boundaries (default: true) */
  snapToLines?: boolean;
}

/**
 * Smart truncate: preserves head (60%) and tail (40%) of text,
 * snaps to line boundaries, closes open code fences, and
 * avoids splitting UTF-16 surrogate pairs.
 */
export function smartTruncate(text: string, opts: SmartTruncateOptions = {}): string {
  const maxLength = opts.maxLength ?? 10000;
  if (!text || text.length <= maxLength) return text;

  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO;
  const tailRatio = 1 - headRatio;

  // Marker deduplication: if already truncated, use minimal separator (no new verbose marker)
  const hasExistingMarker = text.includes("[TRUNCATED");
  const marker = hasExistingMarker
    ? "\n…\n"
    : (opts.marker ??
      `\n\n[TRUNCATED — kept ${Math.round(headRatio * 100)}% head + ${Math.round(tailRatio * 100)}% tail of ${text.length} chars]\n\n`);

  // If maxLength can't fit the marker, hard-truncate
  if (maxLength <= marker.length) return safeCut(text, maxLength);

  // Reserve 4 chars for potential fence closure ("\n```")
  const fenceReserve = 4;
  const available = maxLength - marker.length - fenceReserve;
  if (available <= 0) return safeCut(text, maxLength);

  let headSize = Math.max(0, Math.floor(available * headRatio));
  let tailSize = Math.max(0, Math.floor(available * tailRatio));

  // Snap head to line boundary (search backward for newline)
  if (opts.snapToLines !== false) {
    headSize = snapToLineEnd(text, headSize);
    tailSize = snapToLineStart(text, text.length - tailSize, available - headSize);
  }

  // UTF-16 surrogate safety on head cut point
  headSize = surrogateAdjust(text, headSize);

  // Surrogate safety on tail start
  const tailStart = text.length - tailSize;
  if (tailSize > 0 && tailStart > 0 && tailStart < text.length) {
    const code = text.charCodeAt(tailStart);
    // If we're starting at a low surrogate, include the high surrogate before it
    if (code >= 0xdc00 && code <= 0xdfff && tailStart > 0) {
      tailSize = Math.min(tailSize + 1, text.length);
    }
  }

  let head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";

  // Code fence closure: handle ```, ''', and """ fences
  // Budget for "\n```" (4 chars) was already reserved via fenceReserve
  const combined = head + tail;
  const tripleBacktick = (combined.match(/```/g) || []).length % 2 !== 0;
  const tripleSingleQuote = (combined.match(/'''/g) || []).length % 2 !== 0;
  const tripleDoubleQuote = (combined.match(/"""/g) || []).length % 2 !== 0;

  if (tripleBacktick) {
    head = head + "\n```";
  } else if (tripleSingleQuote) {
    head = head + "\n'''";
  } else if (tripleDoubleQuote) {
    head = head + '\n"""';
  }

  return head + marker + tail;
}

/**
 * Simple safe-cut that respects surrogate pairs and closes open fences.
 *
 * When the plain cut leaves an odd number of fences it tries three strategies
 * in order:
 *   1. Append "\n```" (if it fits and actually makes the count even).
 *   2. Backtrack past the last fence so the remaining count is even.
 *   3. Return the plain cut as a last resort.
 */
export function safeCut(text: string, maxLength: number): string {
  const fenceClose = "\n```";
  let cp = Math.min(maxLength, text.length);
  cp = surrogateAdjust(text, cp);
  const plainResult = text.slice(0, cp);

  // Fast path: already even fences.
  const fenceCount = (plainResult.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return plainResult;

  // Strategy 1: append a closing fence if there is room and it fixes parity.
  // Note: simply appending may not help when the truncation point has already
  // moved *past* the opening fence (the closer becomes its own orphan).
  if (maxLength > fenceClose.length) {
    let closeCp = Math.min(maxLength - fenceClose.length, text.length);
    closeCp = surrogateAdjust(text, closeCp);
    const closedResult = text.slice(0, closeCp) + fenceClose;
    const closedFenceCount = (closedResult.match(/```/g) || []).length;
    if (closedFenceCount % 2 === 0) return closedResult;
  }

  // Strategy 2: backtrack past the last fence to restore even parity.
  // Removing one fence from an odd count always yields an even count.
  const lastFenceIdx = plainResult.lastIndexOf("```");
  if (lastFenceIdx >= 0) {
    const backtracked = plainResult.slice(0, lastFenceIdx);
    // Verify (should always be even, but guard for safety).
    const backtrackedFenceCount = (backtracked.match(/```/g) || []).length;
    if (backtrackedFenceCount % 2 === 0) return backtracked;
  }

  return plainResult;
}

/**
 * Adjust cut point to avoid splitting a surrogate pair.
 * If char at cp-1 is a high surrogate, back up one position.
 */
function surrogateAdjust(text: string, cp: number): number {
  if (cp > 0 && cp < text.length) {
    const code = text.charCodeAt(cp - 1);
    if (code >= 0xd800 && code <= 0xdbff) return cp - 1;
  }
  return cp;
}

/**
 * Snap head cut point backward to the nearest line ending.
 * Searches within a reasonable window (up to 200 chars back).
 */
function snapToLineEnd(text: string, headSize: number): number {
  if (headSize <= 0 || headSize >= text.length) return headSize;
  const searchWindow = Math.min(200, headSize);
  const start = headSize - searchWindow;
  const lastNewline = text.lastIndexOf("\n", headSize - 1);
  if (lastNewline >= start && lastNewline > 0) {
    return lastNewline + 1; // Include the newline in head
  }
  return headSize;
}

/**
 * Snap tail start forward to the nearest line beginning.
 * Returns the adjusted tail size.
 */
function snapToLineStart(text: string, tailStart: number, maxTailSize: number): number {
  if (tailStart <= 0 || tailStart >= text.length) return Math.min(maxTailSize, text.length);
  const searchWindow = Math.min(200, text.length - tailStart);
  const nextNewline = text.indexOf("\n", tailStart);
  if (nextNewline >= 0 && nextNewline < tailStart + searchWindow) {
    return text.length - (nextNewline + 1);
  }
  return text.length - tailStart;
}
