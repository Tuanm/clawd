import Prism from "prismjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { InputContextMenu } from "./InputContextMenu";

const API_URL = "";
const MAX_DIFF_LINES = 5000;

export interface DiffHunk {
  header: string;
  hunk_hash: string;
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

interface Props {
  channel: string;
  agentId: string;
  file: string | null;
  source: "unstaged" | "staged";
  onRefresh: () => void;
  onOpenInProjects?: (agentId: string, filePath: string, line?: number) => void;
}

function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    bash: "bash",
    sh: "bash",
    css: "css",
    py: "python",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext] || "plaintext";
}

function highlightLine(content: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar) {
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return Prism.highlight(content, grammar, language);
}

interface HunkViewProps {
  hunk: DiffHunk;
  language: string;
  source: "unstaged" | "staged";
  channel: string;
  agentId: string;
  file: string;
  onHunkAction: () => void;
  actionPending: string | null;
  onActionStart: (hunkHash: string) => void;
  onActionEnd: () => void;
  onError: (msg: string) => void;
  onOpenInProjects?: (agentId: string, filePath: string, line?: number) => void;
}

function HunkView({
  hunk,
  language,
  source,
  channel,
  agentId,
  file,
  onHunkAction,
  actionPending,
  onActionStart,
  onActionEnd,
  onError,
  onOpenInProjects,
}: HunkViewProps) {
  const isBusy = actionPending === hunk.hunk_hash;

  const callHunkApi = useCallback(
    async (endpoint: string) => {
      onActionStart(hunk.hunk_hash);
      try {
        const res = await authFetch(`${API_URL}/api/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: agentId, file, hunk_hash: hunk.hunk_hash }),
        });
        const data = await res.json();
        if (!data.ok) onError(data.error || `Failed: ${endpoint}`);
        else onHunkAction();
      } catch (err) {
        onError(String(err));
      } finally {
        onActionEnd();
      }
    },
    [channel, agentId, file, hunk.hunk_hash, onHunkAction, onActionStart, onActionEnd, onError],
  );

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        <span className="diff-hunk-label">{hunk.header}</span>
        <div className="diff-hunk-actions">
          {source === "unstaged" ? (
            <button
              className="diff-hunk-btn diff-hunk-btn--stage"
              onClick={() => callHunkApi("app.worktree.stage_hunk")}
              disabled={isBusy || actionPending !== null}
              title="Stage this hunk"
            >
              {isBusy ? "..." : "✓ Stage"}
            </button>
          ) : (
            <button
              className="diff-hunk-btn diff-hunk-btn--unstage"
              onClick={() => callHunkApi("app.worktree.unstage_hunk")}
              disabled={isBusy || actionPending !== null}
              title="Unstage this hunk"
            >
              {isBusy ? "..." : "− Unstage"}
            </button>
          )}
          {source === "unstaged" && (
            <button
              className="diff-hunk-btn diff-hunk-btn--revert"
              onClick={() => callHunkApi("app.worktree.revert_hunk")}
              disabled={isBusy || actionPending !== null}
              title="Revert this hunk"
            >
              {isBusy ? "..." : "✗ Revert"}
            </button>
          )}
          {onOpenInProjects && (
            <button
              className="diff-hunk-btn diff-hunk-btn--open"
              onClick={() => onOpenInProjects(agentId, file, hunk.new_start)}
              title={`Open at line ${hunk.new_start}`}
            >
              ↗ Open
            </button>
          )}
        </div>
      </div>
      <div className="diff-table-wrap">
        <table className="diff-lines-table">
          <tbody>
            {hunk.lines.map((line, i) => (
              <tr key={i} className={`diff-line diff-line--${line.type}`}>
                <td className="diff-lineno diff-lineno--old">{line.old_lineno ?? ""}</td>
                <td className="diff-lineno diff-lineno--new">{line.new_lineno ?? ""}</td>
                <td className="diff-line-sign">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</td>
                <td
                  className="diff-line-content"
                  dangerouslySetInnerHTML={{ __html: highlightLine(line.content, language) }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function WorktreeDiffViewer({ channel, agentId, file, source, onRefresh, onOpenInProjects }: Props) {
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [diffMenu, setDiffMenu] = useState<{ x: number; y: number } | null>(null);
  const [diffMenuHasSelection, setDiffMenuHasSelection] = useState(false);

  const handleDiffContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sel = window.getSelection();
    setDiffMenuHasSelection(!!(sel && sel.toString().length > 0));
    setDiffMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleDiffCopy = useCallback(() => {
    document.execCommand("copy");
  }, []);

  const handleDiffSelectAll = useCallback(() => {
    if (!scrollRef.current) return;
    const range = document.createRange();
    range.selectNodeContents(scrollRef.current);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    setDiffMenuHasSelection(true);
  }, []);

  const language = file ? detectLanguage(file) : "plaintext";

  const fetchDiff = useCallback(async () => {
    if (!file || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/app.worktree.diff?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(agentId)}&file=${encodeURIComponent(file)}&source=${source}`,
      );
      const data = await res.json();
      if (data.ok && data.files?.length > 0) {
        const fileDiff = data.files[0];
        const serverHunks: DiffHunk[] = (fileDiff.hunks || []).map((h: any) => ({
          header: h.header,
          hunk_hash: h.hash,
          old_start: h.oldStart,
          new_start: h.newStart,
          lines: (h.lines || []).map((l: any) => ({
            type: l.type === "addition" ? "add" : l.type === "deletion" ? "remove" : "context",
            content: l.content,
            old_lineno: l.oldNo ?? null,
            new_lineno: l.newNo ?? null,
          })),
        }));
        const totalLines = serverHunks.reduce((acc, h) => acc + h.lines.length + 1, 0);
        setTruncated(!showFull && totalLines > MAX_DIFF_LINES);
        setHunks(showFull ? serverHunks : serverHunks.slice(0, Math.ceil(MAX_DIFF_LINES / 20)));
      } else {
        setHunks([]);
        setTruncated(false);
      }
      setFetched(true);
    } catch (err) {
      setError(String(err));
      setFetched(true);
    } finally {
      setLoading(false);
    }
  }, [channel, agentId, file, source, showFull]);

  useEffect(() => {
    setShowFull(false);
    setFetched(false);
    fetchDiff();
  }, [file, agentId, source]);

  useEffect(() => {
    if (showFull) fetchDiff();
  }, [showFull]);

  const handleHunkAction = useCallback(() => {
    fetchDiff();
    onRefresh();
  }, [fetchDiff, onRefresh]);

  if (!file) {
    return <div className="diff-empty">Select a file to view its diff</div>;
  }

  if (loading && !fetched) {
    return <div className="diff-loading">Loading diff...</div>;
  }

  if (error) {
    return <div className="diff-error">{error}</div>;
  }

  if (fetched && hunks.length === 0) {
    return <div className="diff-empty">No changes to display (file may be untracked or binary)</div>;
  }

  return (
    <>
      <div className="diff-viewer">
        <div className="diff-viewer-header">
          <span className="diff-viewer-file">{file}</span>
          <span className="diff-viewer-source">{source}</span>
        </div>
        <div className="diff-scroll" ref={scrollRef} onContextMenu={handleDiffContextMenu}>
          <div className="diff-hunks">
            {hunks.map((hunk) => (
              <HunkView
                key={hunk.hunk_hash}
                hunk={hunk}
                language={language}
                source={source}
                channel={channel}
                agentId={agentId}
                file={file}
                onHunkAction={handleHunkAction}
                actionPending={actionPending}
                onActionStart={setActionPending}
                onActionEnd={() => setActionPending(null)}
                onError={setError}
                onOpenInProjects={onOpenInProjects}
              />
            ))}
          </div>
          {truncated && !showFull && (
            <div className="diff-truncated">
              <span>Diff truncated at {MAX_DIFF_LINES} lines.</span>
              <button className="diff-show-full-btn" onClick={() => setShowFull(true)}>
                Show full diff
              </button>
            </div>
          )}
        </div>
      </div>
      {diffMenu &&
        createPortal(
          <InputContextMenu
            menu={diffMenu}
            onClose={() => setDiffMenu(null)}
            hasSelection={diffMenuHasSelection}
            isEditable={false}
            onCopy={handleDiffCopy}
            onCut={() => {}}
            onSelectAll={handleDiffSelectAll}
            showSelectAll={false}
          />,
          document.body,
        )}
    </>
  );
}
