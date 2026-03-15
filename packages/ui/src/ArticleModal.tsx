import { useCallback, useEffect, useState } from "react";
import { authFetch } from "./auth-fetch";
import MarkdownContent from "./MarkdownContent";

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
  articleId: string | null;
  onClose: () => void;
}

// Clawd SVG avatar component
function ClawdAvatar({ color = "hsl(15 63.1% 59.6%)" }: { color?: string }) {
  return (
    <div className="message-avatar">
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

export default function ArticleModal({ articleId, onClose }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!articleId) return;
    const id = articleId;
    async function loadArticle() {
      setLoading(true);
      try {
        const res = await authFetch(`/api/articles.get?id=${encodeURIComponent(id)}`);
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

  // Format date as relative
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

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!articleId) return null;

  return (
    <div className="article-modal-overlay" onClick={onClose}>
      <div className="article-modal" onClick={(e) => e.stopPropagation()}>
        <button className="article-modal-close" onClick={onClose} title="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        {loading ? (
          <div className="article-modal-loading">
            <div className="loading-spinner" />
          </div>
        ) : error ? (
          <div className="article-modal-error">{error}</div>
        ) : article ? (
          <>
            <div className="article-modal-date">{formatRelativeDate(article.created_at)}</div>
            <div className="article-modal-body">
              <MarkdownContent content={article.content} />
            </div>
            <div className="article-modal-author">
              <ClawdAvatar color={article.avatar_color} />
              <span className="article-modal-author-name">{article.author}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
