/**
 * Voice notes API (Sprint 33).
 *
 *   POST /api/voice-notes              global capture + optional Claude job match
 *   GET  /api/voice-notes/unmatched    notes needing job assignment
 *   PUT  /api/voice-notes/:id/assign   assign unmatched note to a job
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { processNote } from "../lib/smart-notes.js";
import { triggerNotification } from "../lib/notification-engine.js";
import {
  loadActiveJobsForMatch,
  matchJobFromTranscript,
} from "../lib/voice-note-match.js";

const NOTE_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;
const ASSIGN_ROLES = ["owner", "project_manager"] as const;

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

async function persistProcessing(
  env: Env,
  id: string,
  p: Awaited<ReturnType<typeof processNote>>,
): Promise<void> {
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

export async function handleVoiceNoteCreate(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...NOTE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const transcript = str(body.transcript);
  if (!transcript) return err(400, "transcript_required");

  const enteredViaRaw = str(body.entered_via) ?? "web";
  const enteredVia = ["siri", "quick_capture", "web"].includes(enteredViaRaw)
    ? enteredViaRaw
    : "web";

  let matchedJobId = str(body.job_id);
  if (!matchedJobId) {
    const activeJobs = await loadActiveJobsForMatch(env);
    matchedJobId = await matchJobFromTranscript(env, transcript, activeJobs);
  }

  const noteId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO smart_notes
       (id, job_id, raw_content, entered_via, is_processed, processing_status, created_by, created_at)
     VALUES (?, ?, ?, ?, 0, 'pending', ?, datetime('now'))`,
  )
    .bind(noteId, matchedJobId, transcript, enteredVia, user.email)
    .run();

  let jobTitle: string | null = null;
  if (matchedJobId) {
    const j = await env.DB.prepare("SELECT title FROM jobs WHERE id = ?")
      .bind(matchedJobId)
      .first<{ title: string | null }>();
    jobTitle = j?.title ?? null;
  }

  const processing = await processNote(env, transcript, { jobTitle });
  await persistProcessing(env, noteId, processing);

  if (!matchedJobId) {
    await triggerNotification(env, "voice_note_unmatched", {
      linkPath: "/app/dashboard",
    });
  }

  return json(
    {
      note_id: noteId,
      job_id: matchedJobId,
      matched: Boolean(matchedJobId),
      ai_ok: processing.ok,
    },
    { status: 201 },
  );
}

export async function handleVoiceNoteUnmatchedList(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...NOTE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const { results } = await env.DB.prepare(
    `SELECT id, raw_content, entered_via, created_at, processing_status
       FROM smart_notes
      WHERE job_id IS NULL
        AND entered_via IN ('siri', 'quick_capture')
      ORDER BY created_at DESC
      LIMIT 100`,
  ).all<{
    id: string;
    raw_content: string;
    entered_via: string;
    created_at: string;
    processing_status: string | null;
  }>();

  return json({ notes: results ?? [] });
}

export async function handleVoiceNoteAssign(
  env: Env,
  request: Request,
  noteId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ASSIGN_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const jobId = str(body.job_id);
  if (!jobId) return err(400, "job_id_required");

  const note = await env.DB.prepare("SELECT id, job_id FROM smart_notes WHERE id = ?")
    .bind(noteId)
    .first<{ id: string; job_id: string | null }>();
  if (!note) return err(404, "not_found");

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: string }>();
  if (!job) return err(404, "job_not_found");

  await env.DB.prepare("UPDATE smart_notes SET job_id = ? WHERE id = ?")
    .bind(jobId, noteId)
    .run();

  return json({ ok: true, note_id: noteId, job_id: jobId });
}
