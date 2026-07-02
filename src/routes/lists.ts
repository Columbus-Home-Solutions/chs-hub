/**
 * Managed Lists API — Sprint 34 (Client Page / Estimating Addendum).
 * Two admin-managed vocabulary lists: tag_definitions and referral_sources.
 * Both follow the same add/archive pattern — no renames in v1.
 *
 *   GET  /api/tags                       list all tag_definitions (active + archived)
 *   POST /api/tags                       create a new tag_definition
 *   PUT  /api/tags/:id/archive           toggle archived flag
 *
 *   GET  /api/referral-sources           list all referral_sources (active + archived)
 *   POST /api/referral-sources           create a new referral_source
 *   PUT  /api/referral-sources/:id/archive  toggle archived flag
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export async function handleTagList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM tag_definitions ORDER BY archived ASC, tag_text ASC",
  ).all();
  return json({ tags: results ?? [] });
}

export async function handleTagCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const tagText = str(body.tag_text);
  if (!tagText) return err(422, "validation_error", "tag_text is required");

  const existing = await env.DB.prepare(
    "SELECT id FROM tag_definitions WHERE LOWER(tag_text) = LOWER(?)",
  )
    .bind(tagText)
    .first<{ id: string }>();
  if (existing) return err(409, "conflict", "A tag with that text already exists");

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO tag_definitions (id, tag_text) VALUES (?, ?)").bind(id, tagText).run();

  const row = await env.DB.prepare("SELECT * FROM tag_definitions WHERE id = ?").bind(id).first();
  return json({ tag: row }, { status: 201 });
}

export async function handleTagArchive(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare("SELECT id, archived FROM tag_definitions WHERE id = ?")
    .bind(id)
    .first<{ id: string; archived: number }>();
  if (!existing) return err(404, "not_found", "Tag not found");

  const newArchived = existing.archived === 1 ? 0 : 1;
  await env.DB.prepare("UPDATE tag_definitions SET archived = ? WHERE id = ?")
    .bind(newArchived, id)
    .run();

  const row = await env.DB.prepare("SELECT * FROM tag_definitions WHERE id = ?").bind(id).first();
  return json({ tag: row });
}

// ─── Referral Sources ─────────────────────────────────────────────────────────

export async function handleReferralSourceList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM referral_sources ORDER BY archived ASC, label ASC",
  ).all();
  return json({ referral_sources: results ?? [] });
}

export async function handleReferralSourceCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const label = str(body.label);
  if (!label) return err(422, "validation_error", "label is required");

  const existing = await env.DB.prepare(
    "SELECT id FROM referral_sources WHERE LOWER(label) = LOWER(?)",
  )
    .bind(label)
    .first<{ id: string }>();
  if (existing) return err(409, "conflict", "A referral source with that label already exists");

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO referral_sources (id, label) VALUES (?, ?)").bind(id, label).run();

  const row = await env.DB.prepare("SELECT * FROM referral_sources WHERE id = ?").bind(id).first();
  return json({ referral_source: row }, { status: 201 });
}

export async function handleReferralSourceArchive(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare("SELECT id, archived FROM referral_sources WHERE id = ?")
    .bind(id)
    .first<{ id: string; archived: number }>();
  if (!existing) return err(404, "not_found", "Referral source not found");

  const newArchived = existing.archived === 1 ? 0 : 1;
  await env.DB.prepare("UPDATE referral_sources SET archived = ? WHERE id = ?")
    .bind(newArchived, id)
    .run();

  const row = await env.DB.prepare("SELECT * FROM referral_sources WHERE id = ?").bind(id).first();
  return json({ referral_source: row });
}
