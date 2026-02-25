/**
 * Articles API - CRUD operations for articles
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

interface Article {
  id: string;
  channel: string;
  author: string | null;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  content: string;
  tags_json: string;
  published: number;
  created_at: number;
  updated_at: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function parseBody(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await req.json()) as Record<string, any>;
  }
  const formData = await req.formData();
  const obj: Record<string, any> = {};
  formData.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

/** Register article management API routes */
export function registerArticleRoutes(
  db: Database,
): (req: Request, url: URL, path: string, bunServer?: any) => Response | null {
  // Initialize articles table
  initArticlesTable(db);

  return (req: Request, url: URL, path: string): Response | null => {
    // GET /api/articles.list?channel=xxx&limit=20
    if (path === "/api/articles.list" && req.method === "GET") {
      return handleAsync(req, async () => {
        const channel = url.searchParams.get("channel");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const published = url.searchParams.get("published");

        let query = "SELECT * FROM articles";
        const params: string[] = [];
        const conditions: string[] = [];

        if (channel) {
          conditions.push("channel = ?");
          params.push(channel);
        }
        if (published !== null) {
          conditions.push("published = ?");
          params.push(published === "true" ? "1" : "0");
        }

        if (conditions.length > 0) {
          query += " WHERE " + conditions.join(" AND ");
        }

        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(String(limit), String(offset));

        const stmt = db.prepare(query);
        const articles = stmt.all(...params) as Article[];

        return json({ ok: true, articles });
      });
    }

    // GET /api/articles.get?id=xxx
    if (path === "/api/articles.get" && req.method === "GET") {
      return handleAsync(req, async () => {
        const id = url.searchParams.get("id");
        if (!id) {
          return json({ ok: false, error: "Article ID required" }, 400);
        }

        const stmt = db.prepare("SELECT * FROM articles WHERE id = ?");
        const article = stmt.get(id) as Article | null;

        if (!article) {
          return json({ ok: false, error: "Article not found" }, 404);
        }

        // Get avatar_color from agents table
        const agentStmt = db.prepare("SELECT avatar_color FROM agents WHERE id = ? AND channel = ?");
        const agent = agentStmt.get(article.author, article.channel) as { avatar_color: string } | null;
        const avatar_color = agent?.avatar_color || "#D97853";

        return json({ ok: true, article: { ...article, avatar_color } });
      });
    }

    // POST /api/articles.create
    if (path === "/api/articles.create" && req.method === "POST") {
      return handleAsync(req, async () => {
        const body = await parseBody(req);
        const { channel, author, title, description, thumbnail_url, content, tags, published } = body;

        if (!channel || !title || !content) {
          return json({ ok: false, error: "channel, title, and content are required" }, 400);
        }

        const id = body.id || randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : "[]";

        const stmt = db.prepare(`
          INSERT INTO articles (id, channel, author, title, description, thumbnail_url, content, tags_json, published, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        try {
          stmt.run(
            id,
            channel,
            author || null,
            title,
            description || null,
            thumbnail_url || null,
            content,
            tagsJson,
            published ? 1 : 0,
            now,
            now,
          );
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500);
        }

        const getStmt = db.prepare("SELECT * FROM articles WHERE id = ?");
        const article = getStmt.get(id) as Article;

        return json({ ok: true, article });
      });
    }

    // POST /api/articles.update
    if (path === "/api/articles.update" && req.method === "POST") {
      return handleAsync(req, async () => {
        const body = await parseBody(req);
        const { id, title, description, thumbnail_url, content, tags, published } = body;

        if (!id) {
          return json({ ok: false, error: "Article ID required" }, 400);
        }

        // Check if article exists
        const checkStmt = db.prepare("SELECT * FROM articles WHERE id = ?");
        const existing = checkStmt.get(id) as Article | null;
        if (!existing) {
          return json({ ok: false, error: "Article not found" }, 404);
        }

        const updates: string[] = [];
        const params: any[] = [];

        if (title !== undefined) {
          updates.push("title = ?");
          params.push(title);
        }
        if (description !== undefined) {
          updates.push("description = ?");
          params.push(description);
        }
        if (thumbnail_url !== undefined) {
          updates.push("thumbnail_url = ?");
          params.push(thumbnail_url);
        }
        if (content !== undefined) {
          updates.push("content = ?");
          params.push(content);
        }
        if (tags !== undefined) {
          updates.push("tags_json = ?");
          params.push(Array.isArray(tags) ? JSON.stringify(tags) : "[]");
        }
        if (published !== undefined) {
          updates.push("published = ?");
          params.push(published ? 1 : 0);
        }

        updates.push("updated_at = ?");
        params.push(Math.floor(Date.now() / 1000));
        params.push(id);

        const stmt = db.prepare(`UPDATE articles SET ${updates.join(", ")} WHERE id = ?`);
        stmt.run(...params);

        const getStmt = db.prepare("SELECT * FROM articles WHERE id = ?");
        const article = getStmt.get(id) as Article;

        return json({ ok: true, article });
      });
    }

    // POST /api/articles.delete
    if (path === "/api/articles.delete" && req.method === "POST") {
      return handleAsync(req, async () => {
        const body = await parseBody(req);
        const { id } = body;

        if (!id) {
          return json({ ok: false, error: "Article ID required" }, 400);
        }

        const stmt = db.prepare("DELETE FROM articles WHERE id = ?");
        stmt.run(id);

        return json({ ok: true });
      });
    }

    return null;
  };
}

function initArticlesTable(db: Database): void {
  // Table is created in database.ts initSchema
  // Additional migrations can be added here if needed
}

function handleAsync(req: Request, fn: () => Promise<Response>): Response {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.catch((err) => json({ ok: false, error: String(err) }, 500));
    }
    return result;
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}
