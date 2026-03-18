import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { authFetch } from "./auth-fetch";
import MarkdownContent from "./MarkdownContent";
import { CopyIcon } from "./ui-primitives";

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
}

interface Article {
  id: string;
  channel: string;
  title: string;
  author: string;
  avatar_color: string;
  thumbnail_url: string;
  content: string;
  published: boolean;
  created_at: number;
  updated_at: number;
}

interface Props {
  articleId: string;
}

// Clawd SVG avatar component
function ClawdAvatar({ color = "hsl(15 63.1% 59.6%)", title }: { color?: string; title?: string }) {
  return (
    <div className="message-avatar" title={title}>
      <svg width="32" height="26" viewBox="0 0 66 52" fill="none">
        <rect x="0" y="13" width="6" height="13" fill={color} />
        <rect x="60" y="13" width="6" height="13" fill={color} />
        <rect x="6" y="39" width="6" height="13" fill={color} />
        <rect x="18" y="39" width="6" height="13" fill={color} />
        <rect x="42" y="39" width="6" height="13" fill={color} />
        <rect x="54" y="39" width="6" height="13" fill={color} />
        <rect x="6" width="54" height="39" fill={color} />
        <rect x="12" y="13" width="6" height="6.5" fill="#000" />
        <rect x="48" y="13" width="6" height="6.5" fill="#000" />
      </svg>
    </div>
  );
}

export default function ArticlePage({ articleId }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 });

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on click
  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0 });
  }, []);

  // Copy article content
  const copyContent = useCallback(() => {
    if (article) {
      navigator.clipboard.writeText(article.content);
      closeContextMenu();
    }
  }, [article, closeContextMenu]);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => closeContextMenu();
    if (contextMenu.visible) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu.visible, closeContextMenu]);

  useEffect(() => {
    async function loadArticle() {
      try {
        const res = await authFetch(`/api/articles.get?id=${encodeURIComponent(articleId)}`);
        const data = await res.json();
        if (data.ok) {
          setArticle(data.article);
        } else {
          setError(data.error || "Article not found");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
    loadArticle();
  }, [articleId]);

  // Format date as relative (same as chat messages)
  const formatRelativeDate = useCallback((timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (isToday) {
      return time;
    } else if (isYesterday) {
      return "Yesterday";
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  }, []);

  if (loading) {
    return (
      <div className="app loading">
        <header className="header">
          <div className="header-left">
            <div className="clawd-entrance">
              <svg width="28" height="22" viewBox="0 0 66 52" fill="none">
                <rect x="0" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                <rect x="60" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                <g className="leg1">
                  <rect x="6" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                  <rect x="42" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                </g>
                <g className="leg2">
                  <rect x="18" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                  <rect x="54" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                </g>
                <rect x="6" width="54" height="39" fill="hsl(15 63.1% 59.6%)" />
                <rect x="12" y="13" width="6" height="6.5" fill="#000" />
                <rect x="48" y="13" width="6" height="6.5" fill="#000" />
              </svg>
            </div>
          </div>
        </header>
      </div>
    );
  }

  if (error || !article) {
    return (
      <div className="app article-page">
        <header className="header">
          <div className="header-left">
            <div className="clawd-logo-wrapper">
              <svg width="28" height="22" viewBox="0 0 66 52" fill="none">
                <rect x="0" y="13" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="60" y="13" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="6" y="39" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="18" y="39" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="42" y="39" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="54" y="39" width="6" height="13" fill="hsl(0 0% 60%)" />
                <rect x="6" width="54" height="39" fill="hsl(0 0% 60%)" />
                <rect x="12" y="16" width="6" height="2" fill="#000" />
                <rect x="48" y="16" width="6" height="2" fill="#000" />
              </svg>
            </div>
          </div>
        </header>
        <div className="messages-wrapper article-scrollable">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              color: "var(--text-muted)",
            }}
          >
            {error || "Article not found"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app article-page" onContextMenu={handleContextMenu}>
      <header className="header">
        <div className="header-left">
          <div className="clawd-logo-wrapper">
            <svg width="28" height="22" viewBox="0 0 66 52" fill="none">
              <rect x="0" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="60" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="6" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="18" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="42" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="54" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
              <rect x="6" width="54" height="39" fill="hsl(15 63.1% 59.6%)" />
              <rect x="12" y="13" width="6" height="6.5" fill="#000" />
              <rect x="48" y="13" width="6" height="6.5" fill="#000" />
            </svg>
          </div>
        </div>
      </header>
      <div className="messages-wrapper article-scrollable">
        <div className="messages-list">
          <div className="message">
            <div className="message-row">
              <ClawdAvatar color={article.avatar_color} title={article.author} />
              <div className="message-body">
                <div className="message-header">
                  <span className="message-sender">{article.author}</span>
                  <span className="message-time">{formatRelativeDate(article.created_at)}</span>
                </div>
                <div className="message-content">
                  <MarkdownContent content={article.content} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {contextMenu.visible && (
        <div
          className="message-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={copyContent}>
            <CopyIcon />
            <span>Copy content</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Mount the app
const container = document.getElementById("root");
if (container) {
  const params = new URLSearchParams(window.location.search);
  const articleId = params.get("id") || window.location.pathname.split("/articles/")[1] || "";
  const root = createRoot(container);
  root.render(<ArticlePage articleId={articleId} />);
}
