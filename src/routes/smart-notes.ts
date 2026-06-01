/**
 * Smart Notes (Sprint 8).
 *
 *   POST /api/smart-notes                       create + Claude process
 *   GET  /api/smart-notes        (?job_id=&category=)
 *   GET  /api/smart-notes/:id
 *   POST /api/smart-notes/:id/process           re-run Claude
 *   POST /api/smart-notes/:id/accept-task       → tasks row (O/PM)
 *   POST /api/smart-notes/:id/accept-expense    → expenses row (O/PM/FC)
 *   POST /api/smart-notes/:id/accept-change-order → change_orders draft (O/PM)
 *
 * A note's AI output is a set of SUGGESTIONS (business rule #4). The accept
 * endpoints are the only path that creates a real task/expense/change-order,
 * always from user-reviewed input. AI processing degrades gracefully when no
 * Claude key/proxy is reachable: the note persists with processing_status
 * 'failed' and can be re-processed (rule #7). This is the new smart_notes
 * table — distinct from the legacy /api/notes (notes table).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { processNote, type NoteProcessing } from "../lib/smart-notes.js";
import { insertFullExpense } from "./expenses.js";

const NOTE_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;
const TASK_ROLES = ["owner", "project_manager"] as const;
const EXPENSE_ROLES = ["owner", "project_manager", "field_crew"] as const;
const CO_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
function err(status: number, code: string, message?: string): Response {
  return json({ error: code, message: message ?? code }, { status });
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface NoteRow {
  id: string;
  job_id: string | null;
  raw_content: string;
  ai_summary: string | null;
  ai_category: string | null;
  ai_extracted_tasks: string | null;
  ai_extracted_expense: string | null;
  ai_extracted_change_order: string | null;
  is_processed: number | null;
  processing_status: string | null;
  entered_via: string;
  created_by: string | null;
  created_at: string;
}

function hydrate(row: NoteRow) {
  const parse = (s: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    job_id: row.job_id,
    raw_content: row.raw_content,
    ai_summary: row.ai_summary,
    ai_category: row.ai_category,
    ai_extracted_tasks: parse(row.ai_extracted_tasks) ?? [],
    ai_extracted_expense: parse(row.ai_extracted_expense),
    ai_extracted_change_order: parse(row.ai_extracted_change_order),
    is_processed: Boolean(row.is_processed),
    processing_status: row.processing_status,
    entered_via: row.entered_via,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

async function loadNote(env: Env, id: string): Promise<NoteRow | null> {
  return env.DB.prepare("SELECT * FROM smart_notes WHERE id = ?").bind(id).first<NoteRow>();
}

async function persistProcessing(env: Env, id: string, p: NoteProcessing): Promise<void> {
  const status = p.ok ? "processed" : "failed";
  await env.DB.prepare(
    `UPDATE smart_notes SET ai_summary = ?, ai_category = ?, ai_extracted_tasks = ?,
       ai_extracted_expense = ?, ai_extracted_change_order = ?, is_processed = ?,
       processing_status = ? WHERE id = ?`,
  )
    .bind(
      p.summary,
      p.category,
      JSON.stringify(p.tasks ?? []),
      p.expense ? JSON.stringify(p.expense) : null,
      p.change_order ? JSON.stringify(p.change_order) : null,
      p.ok ? 1 : 0,
      status,
      id,
    )
    .run();
}

// ─── POST /api/smart-notes ───────────────────────────────────────────────────

export async function handleSmartNoteCreate(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...NOTE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const rawContent = str(body.raw_content);
  if (!rawContent) return err(400, "raw_content_required");
  const jobId = str(body.job_id);
  const enteredVia = str(body.entered_via) ?? "text";

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO smart_notes
       (id, job_id, raw_content, processing_status, is_processed, entered_via, created_by, created_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, datetime('now'))`,
  )
    .bind(id, jobId, rawContent, enteredVia, user.email)
    .run();

  // Process now (graceful degrade — never blocks the note from existing).
  let jobTitle: string | null = null;
  if (jobId) {
    const j = await env.DB.prepare("SELECT title FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ title: string | null }>();
    jobTitle = j?.title ?? null;
  }
  const processing = await processNote(env, rawContent, { jobTitle });
  await persistProcessing(env, id, processing);

  const row = await loadNote(env, id);
  return json({ note: row ? hydrate(row) : null, ai_ok: processing.ok, ai_error: processing.error }, { status: 201 });
}

// ─── GET /api/smart-notes ─────────────────────────────────────────────────────

export async function handleSmartNoteList(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  const category = url.searchParams.get("category");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (jobId === "general") {
    where.push("job_id IS NULL");
  } else if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  if (category) {
    where.push("ai_category = ?");
    binds.push(category);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT * FROM smart_notes ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<NoteRow>();
  return json({ total: rows.results?.length ?? 0, notes: (rows.results ?? []).map(hydrate) });
}

export async function handleSmartNoteGet(env: Env, id: string): Promise<Response> {
  const row = await loadNote(env, id);
  if (!row) return err(404, "not_found");
  return json({ note: hydrate(row) });
}

// ─── POST /api/smart-notes/:id/process (re-trigger) ──────────────────────────

export async function handleSmartNoteProcess(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...NOTE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const row = await loadNote(env, id);
  if (!row) return err(404, "not_found");
  let jobTitle: string | null = null;
  if (row.job_id) {
    const j = await env.DB.prepare("SELECT title FROM jobs WHERE id = ?")
      .bind(row.job_id)
      .first<{ title: string | null }>();
    jobTitle = j?.title ?? null;
  }
  const processing = await processNote(env, row.raw_content, { jobTitle });
  await persistProcessing(env, id, processing);
  const updated = await loadNote(env, id);
  return json({ note: updated ? hydrate(updated) : null, ai_ok: processing.ok, ai_error: processing.error });
}

// ─── POST /api/smart-notes/:id/accept-task (O/PM) ────────────────────────────

export async function handleSmartNoteAcceptTask(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...TASK_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const note = await loadNote(env, id);
  if (!note) return err(404, "not_found");
  const body = (await readJson(request)) ?? {};

  const jobId = str(body.job_id) ?? note.job_id;
  if (!jobId) return err(400, "job_required", "A note must be linked to a job to create a task.");
  const jobOk = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!jobOk) return err(400, "unknown_job");

  // Default from the first extracted task suggestion, overridable by body.
  const extracted = firstExtractedTask(note);
  const title = str(body.title) ?? extracted?.title ?? null;
  if (!title) return err(400, "title_required");
  const taskGroup = str(body.task_group) ?? extracted?.task_group ?? "Field Notes";
  const isPunch = body.is_punch_list ? 1 : 0;

  const existingGroup = await env.DB.prepare(
    "SELECT task_group_order FROM tasks WHERE job_id = ? AND task_group = ? LIMIT 1",
  )
    .bind(jobId, taskGroup)
    .first<{ task_group_order: number }>();
  let groupOrder: number;
  if (existingGroup) {
    groupOrder = existingGroup.task_group_order;
  } else {
    const maxRow = await env.DB.prepare(
      "SELECT COALESCE(MAX(task_group_order), -1) AS m FROM tasks WHERE job_id = ?",
    )
      .bind(jobId)
      .first<{ m: number }>();
    groupOrder = (maxRow?.m ?? -1) + 1;
  }
  const sortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE job_id = ? AND task_group = ?",
  )
    .bind(jobId, taskGroup)
    .first<{ m: number }>();
  const sortOrder = (sortRow?.m ?? -1) + 1;

  const taskId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tasks (id, job_id, task_group, task_group_order, title, status,
        notes, sort_order, is_punch_list, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))`,
  )
    .bind(taskId, jobId, taskGroup, groupOrder, title, extracted?.notes ?? null, sortOrder, isPunch)
    .run();

  await logAudit(env, user.email, "smart_note_accept_task", "task", taskId, { note_id: id, job_id: jobId, title });
  return json({ ok: true, task_id: taskId, job_id: jobId }, { status: 201 });
}

// ─── POST /api/smart-notes/:id/accept-expense (O/PM/FC) ──────────────────────

export async function handleSmartNoteAcceptExpense(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...EXPENSE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const note = await loadNote(env, id);
  if (!note) return err(404, "not_found");
  const body = (await readJson(request)) ?? {};
  const suggestion = parseField<Record<string, unknown>>(note.ai_extracted_expense);

  const amount = Number(body.amount ?? suggestion?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return err(400, "amount_required", "amount must be a positive number");
  }
  const vendor = str(body.vendor) ?? (suggestion ? str(suggestion.vendor) : null);
  const category = str(body.category) ?? (suggestion ? str(suggestion.category) : null);
  const description =
    str(body.description) ?? (suggestion ? str(suggestion.description) : null) ?? (vendor ? `Note expense — ${vendor}` : "Note expense");
  const jobId = str(body.job_id) ?? note.job_id;
  const date = str(body.date) ?? new Date().toISOString().slice(0, 10);

  // Sprint 10: land the FULL expense shape via the shared helper (extend, don't
  // fork) so a note-sourced expense carries alignment / tax category / sub-1099.
  const expenseType = str(body.expense_type) ?? category ?? "material";
  const isSub = expenseType === "subcontractor";
  const expenseId = await insertFullExpense(env, {
    job_id: jobId,
    expense_type: expenseType,
    vendor,
    description,
    amount,
    incurred_date: date,
    estimate_line_item_id: str(body.estimate_line_item_id),
    tax_category: str(body.tax_category) ?? category,
    sub_id: isSub ? str(body.sub_id) : null,
    is_1099_reportable: isSub && Boolean(body.is_1099_reportable),
    receipt_photo_id: null,
    receipt_r2_key: null,
    entered_via: "auto",
    created_by: user.email,
  });

  await logAudit(env, user.email, "smart_note_accept_expense", "expense", expenseId, { note_id: id, amount });
  return json({ ok: true, expense_id: expenseId, job_id: jobId }, { status: 201 });
}

// ─── POST /api/smart-notes/:id/accept-change-order (O/PM) ────────────────────

export async function handleSmartNoteAcceptChangeOrder(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...CO_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const note = await loadNote(env, id);
  if (!note) return err(404, "not_found");
  const body = (await readJson(request)) ?? {};
  const suggestion = parseField<Record<string, unknown>>(note.ai_extracted_change_order);

  const jobId = str(body.job_id) ?? note.job_id;
  if (!jobId) return err(400, "job_required", "A note must be linked to a job to create a change order.");
  const jobOk = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!jobOk) return err(400, "unknown_job");

  const title = str(body.title) ?? (suggestion ? str(suggestion.title) : null) ?? "Change order";
  const description = str(body.description) ?? (suggestion ? str(suggestion.description) : null) ?? title;
  const amountRaw = Number(body.amount ?? suggestion?.amount);
  const amount = Number.isFinite(amountRaw) ? amountRaw : 0;

  const maxRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(change_order_number), 0) AS m FROM change_orders WHERE job_id = ?",
  )
    .bind(jobId)
    .first<{ m: number }>();
  const coNumber = (maxRow?.m ?? 0) + 1;

  const coId = crypto.randomUUID();
  // Draft, triggered by this note (#4 — user-reviewed, never auto-applied).
  await env.DB.prepare(
    `INSERT INTO change_orders
       (id, job_id, change_order_number, title, description, amount, status,
        requested_date, triggered_by_note_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', datetime('now'), ?, ?, datetime('now'))`,
  )
    .bind(coId, jobId, coNumber, title, description, amount, id, user.email)
    .run();

  await logAudit(env, user.email, "smart_note_accept_change_order", "change_order", coId, {
    note_id: id,
    job_id: jobId,
    change_order_number: coNumber,
  });
  return json({ ok: true, change_order_id: coId, change_order_number: coNumber, job_id: jobId }, { status: 201 });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseField<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function firstExtractedTask(note: NoteRow): { title: string; task_group: string | null; notes: string | null } | null {
  const tasks = parseField<unknown[]>(note.ai_extracted_tasks);
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const t = tasks[0];
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    const title = str(o.title);
    if (title) return { title, task_group: str(o.task_group), notes: str(o.notes) };
  } else if (typeof t === "string" && t.trim()) {
    return { title: t.trim(), task_group: null, notes: null };
  }
  return null;
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, entityType, entityId, JSON.stringify(details))
    .run();
}
