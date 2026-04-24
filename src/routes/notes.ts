/**
 * Smart Notes — D1-backed CRUD.
 *
 *   POST   /api/notes           — create   (body: {category, raw_text, summary?, tags?, tasks_extracted?, task_count?, meeting_source?})
 *   GET    /api/notes           — list     (?status=active|archived|all, ?category=, ?q=, ?since=, ?until=, ?limit=)
 *   GET    /api/notes/:id       — read
 *   PATCH  /api/notes/:id       — update   (partial; archive/restore via status='archived'/'active')
 *   DELETE /api/notes/:id       — hard delete
 *
 * Claude processing stays in the browser: the frontend posts the raw note
 * to chs-claude-proxy.tony-bc5.workers.dev (existing) and then POSTs the
 * structured result here. Keeping it that way avoids a second Claude
 * gateway and preserves the current behaviour.
 */

import type { Env } from "../env.js";

export interface NoteRow {
  id: string;
  created_at: string;
  updated_at: string;
  category: string | null;
  raw_text: string;
  summary: string | null;
  tags: string[]; // deserialised
  tasks_extracted: unknown[]; // deserialised (array of {title,due,priority,category})
  task_count: number;
  status: "active" | "archived";
  archived_at: string | null;
  meeting_source: string | null;
}

interface RawNoteRow {
  id: string;
  created_at: string;
  updated_at: string;
  category: string | null;
  raw_text: string;
  summary: string | null;
  tags: string | null;
  tasks_extracted: string | null;
  task_count: number;
  status: string;
  archived_at: string | null;
  meeting_source: string | null;
}

function hydrate(row: RawNoteRow): NoteRow {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    category: row.category,
    raw_text: row.raw_text,
    summary: row.summary,
    tags: safeJsonArray(row.tags),
    tasks_extracted: safeJsonArray(row.tasks_extracted),
    task_count: row.task_count ?? 0,
    status: row.status === "archived" ? "archived" : "active",
    archived_at: row.archived_at,
    meeting_source: row.meeting_source,
  };
}

function safeJsonArray(s: string | null): never[] | unknown[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function newId(): string {
  // uuid v4-ish from Web Crypto; Workers provides crypto.randomUUID()
  return crypto.randomUUID();
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/notes
// ────────────────────────────────────────────────────────────────────────

export async function handleNoteCreate(
  env: Env,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const rawText = typeof body.raw_text === "string" ? body.raw_text.trim() : "";
  if (!rawText) return jsonErr(400, "raw_text_required");

  const id = newId();
  const now = new Date().toISOString();
  const category =
    typeof body.category === "string" && body.category.trim()
      ? body.category.trim()
      : "General";
  const summary = typeof body.summary === "string" ? body.summary : null;
  const tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : null;
  const tasksExtracted = Array.isArray(body.tasks_extracted)
    ? JSON.stringify(body.tasks_extracted)
    : null;
  const taskCount =
    typeof body.task_count === "number"
      ? body.task_count
      : Array.isArray(body.tasks_extracted)
        ? body.tasks_extracted.length
        : 0;
  const meetingSource =
    typeof body.meeting_source === "string" ? body.meeting_source : null;

  await env.DB.prepare(
    `INSERT INTO notes
       (id, created_at, updated_at, category, raw_text, summary, tags,
        tasks_extracted, task_count, status, archived_at, meeting_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
  )
    .bind(
      id,
      now,
      now,
      category,
      rawText,
      summary,
      tags,
      tasksExtracted,
      taskCount,
      meetingSource,
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM notes WHERE id = ?`)
    .bind(id)
    .first<RawNoteRow>();

  return json(201, { note: row ? hydrate(row) : null });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/notes
// ────────────────────────────────────────────────────────────────────────

export async function handleNoteList(
  env: Env,
  url: URL,
): Promise<Response> {
  const status = url.searchParams.get("status") ?? "active"; // active|archived|all
  const category = url.searchParams.get("category") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const since = url.searchParams.get("since"); // ISO date
  const until = url.searchParams.get("until"); // ISO date
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1000);

  const where: string[] = [];
  const binds: unknown[] = [];

  if (status === "active") where.push(`status = 'active'`);
  else if (status === "archived") where.push(`status = 'archived'`);
  // status = 'all' → no filter

  if (category) {
    where.push(`LOWER(category) = LOWER(?)`);
    binds.push(category);
  }
  if (since) {
    where.push(`created_at >= ?`);
    binds.push(since);
  }
  if (until) {
    where.push(`created_at < ?`);
    binds.push(until);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const stmt = env.DB.prepare(
    `SELECT * FROM notes ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...binds, limit);

  const rows = await stmt.all<RawNoteRow>();
  let notes = (rows.results ?? []).map(hydrate);

  if (q) {
    notes = notes.filter((n) => {
      const hay = [
        n.raw_text,
        n.summary ?? "",
        n.category ?? "",
        ...n.tags,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  return json(200, {
    as_of: new Date().toISOString(),
    total: notes.length,
    notes,
  });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/notes/:id
// ────────────────────────────────────────────────────────────────────────

export async function handleNoteGet(
  env: Env,
  id: string,
): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM notes WHERE id = ?`)
    .bind(id)
    .first<RawNoteRow>();
  if (!row) return jsonErr(404, "not_found");
  return json(200, { note: hydrate(row) });
}

// ────────────────────────────────────────────────────────────────────────
// PATCH /api/notes/:id   — partial update (status, category, raw_text, summary, tags, tasks_extracted)
// ────────────────────────────────────────────────────────────────────────

export async function handleNotePatch(
  env: Env,
  id: string,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const existing = await env.DB.prepare(`SELECT * FROM notes WHERE id = ?`)
    .bind(id)
    .first<RawNoteRow>();
  if (!existing) return jsonErr(404, "not_found");

  const updates: string[] = [];
  const binds: unknown[] = [];
  const now = new Date().toISOString();

  if (typeof body.category === "string") {
    updates.push("category = ?");
    binds.push(body.category);
  }
  if (typeof body.raw_text === "string") {
    updates.push("raw_text = ?");
    binds.push(body.raw_text);
  }
  if ("summary" in body) {
    updates.push("summary = ?");
    binds.push(typeof body.summary === "string" ? body.summary : null);
  }
  if (Array.isArray(body.tags)) {
    updates.push("tags = ?");
    binds.push(JSON.stringify(body.tags));
  }
  if (Array.isArray(body.tasks_extracted)) {
    updates.push("tasks_extracted = ?");
    binds.push(JSON.stringify(body.tasks_extracted));
    updates.push("task_count = ?");
    binds.push(body.tasks_extracted.length);
  }
  if (typeof body.task_count === "number") {
    updates.push("task_count = ?");
    binds.push(body.task_count);
  }
  if (body.status === "archived" || body.status === "active") {
    updates.push("status = ?");
    binds.push(body.status);
    updates.push("archived_at = ?");
    binds.push(body.status === "archived" ? now : null);
  }

  if (updates.length === 0) return jsonErr(400, "no_updatable_fields");

  updates.push("updated_at = ?");
  binds.push(now);
  binds.push(id);

  await env.DB.prepare(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM notes WHERE id = ?`)
    .bind(id)
    .first<RawNoteRow>();
  return json(200, { note: row ? hydrate(row) : null });
}

// ────────────────────────────────────────────────────────────────────────
// DELETE /api/notes/:id
// ────────────────────────────────────────────────────────────────────────

export async function handleNoteDelete(
  env: Env,
  id: string,
): Promise<Response> {
  const existing = await env.DB.prepare(`SELECT id FROM notes WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonErr(404, "not_found");
  await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(id).run();
  return json(200, { deleted: true });
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function jsonErr(status: number, code: string, message?: string): Response {
  return json(status, { error: code, message: message ?? code });
}
