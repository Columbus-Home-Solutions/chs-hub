/**
 * Lien Waivers — Sprint 15 (carried from S14; Financial-Management lien context
 * + Document-Management generation). Tracks per-job, per-sub waiver requests and
 * generates the waiver document from the DB-backed Lien Waiver template into
 * `documents`, linking `lien_waivers.document_id`.
 *
 *   GET  /api/jobs/:id/lien-waivers     (O/PM)  waivers for a job
 *   POST /api/lien-waivers              (O/PM)  create request (status='requested')
 *   PUT  /api/lien-waivers/:id          (O/PM)  lifecycle (received / filed, received_date)
 *   POST /api/lien-waivers/:id/generate (O/PM)  render template → documents row, link
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { resolveMergeFields, renderMergeContent } from "../lib/merge-fields.js";
import { insertDocument } from "./documents.js";

const WRITE_ROLES = ["owner", "project_manager"] as const;
const WAIVER_TYPES = new Set(["conditional", "unconditional", "partial", "final"]);
const STATUSES = new Set(["requested", "received", "filed"]);

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

interface WaiverRow {
  id: string;
  job_id: string;
  sub_id: string;
  waiver_type: string;
  payment_amount: number;
  status: string;
  requested_date: string;
  received_date: string | null;
  document_id: string | null;
  notes: string | null;
  created_at: string;
}

// ─── GET /api/jobs/:id/lien-waivers ─────────────────────────────────────────

export async function handleJobLienWaivers(env: Env, jobId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT lw.id, lw.job_id, lw.sub_id, lw.waiver_type, lw.payment_amount, lw.status,
            lw.requested_date, lw.received_date, lw.document_id, lw.notes, lw.created_at,
            s.company AS sub_name
       FROM lien_waivers lw
       LEFT JOIN subcontractors s ON s.id = lw.sub_id
      WHERE lw.job_id = ?
      ORDER BY datetime(lw.created_at) DESC`,
  )
    .bind(jobId)
    .all<WaiverRow & { sub_name: string | null }>();
  return json({ job_id: jobId, lien_waivers: results ?? [] });
}

// ─── POST /api/lien-waivers ─────────────────────────────────────────────────

export async function handleLienWaiverCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const subId = typeof body.sub_id === "string" ? body.sub_id : "";
  const waiverType = typeof body.waiver_type === "string" ? body.waiver_type : "";
  const paymentAmount = Number(body.payment_amount);
  if (!jobId || !subId) return err(400, "job_and_sub_required");
  if (!WAIVER_TYPES.has(waiverType)) return err(400, "invalid_waiver_type");
  if (!Number.isFinite(paymentAmount)) return err(400, "invalid_payment_amount");

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first();
  if (!job) return err(404, "job_not_found");
  const sub = await env.DB.prepare("SELECT id FROM subcontractors WHERE id = ?").bind(subId).first();
  if (!sub) return err(404, "sub_not_found");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO lien_waivers
       (id, job_id, sub_id, waiver_type, payment_amount, status, requested_date, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
  )
    .bind(id, jobId, subId, waiverType, paymentAmount, now, typeof body.notes === "string" ? body.notes : null, now)
    .run();
  return json({ id, status: "requested" }, { status: 201 });
}

// ─── PUT /api/lien-waivers/:id (lifecycle) ──────────────────────────────────

export async function handleLienWaiverUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const row = await env.DB.prepare("SELECT id, status FROM lien_waivers WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return err(404, "not_found");

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (typeof body.status === "string") {
    if (!STATUSES.has(body.status)) return err(400, "invalid_status");
    sets.push("status = ?");
    binds.push(body.status);
    // Auto-stamp received_date when moving to received/filed (unless provided).
    if ((body.status === "received" || body.status === "filed") && body.received_date === undefined) {
      sets.push("received_date = COALESCE(received_date, ?)");
      binds.push(new Date().toISOString());
    }
  }
  if (typeof body.received_date === "string") {
    sets.push("received_date = ?");
    binds.push(body.received_date);
  }
  if (typeof body.notes === "string") {
    sets.push("notes = ?");
    binds.push(body.notes);
  }
  if (sets.length === 0) return err(400, "no_fields");
  binds.push(id);
  await env.DB.prepare(`UPDATE lien_waivers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return json({ ok: true });
}

// ─── POST /api/lien-waivers/:id/generate ────────────────────────────────────

export async function handleLienWaiverGenerate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const lw = await env.DB.prepare(
    `SELECT lw.id, lw.job_id, lw.sub_id, lw.waiver_type, lw.payment_amount, lw.document_id,
            s.company AS sub_name
       FROM lien_waivers lw LEFT JOIN subcontractors s ON s.id = lw.sub_id
      WHERE lw.id = ?`,
  )
    .bind(id)
    .first<WaiverRow & { sub_name: string | null }>();
  if (!lw) return err(404, "not_found");

  // Find the active Lien Waiver template head.
  const tpl = await env.DB.prepare(
    `SELECT id, name, content, version FROM document_templates t
      WHERE template_type = 'lien_waiver' AND is_active = 1
        AND NOT EXISTS (SELECT 1 FROM document_templates n WHERE n.previous_version_id = t.id)
      ORDER BY version DESC LIMIT 1`,
  ).first<{ id: string; name: string; content: string; version: number }>();
  if (!tpl) return err(409, "no_lien_waiver_template", "Seed/activate a Lien Waiver document template first.");

  const fields = await resolveMergeFields(env, { job_id: lw.job_id });
  fields.sub_name = lw.sub_name ?? "Subcontractor";
  fields.waiver_type = lw.waiver_type;
  fields.payment_amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    lw.payment_amount,
  );
  const rendered = renderMergeContent(tpl.content, fields);

  const title = `Lien Waiver — ${fields.sub_name} (${lw.waiver_type})`;
  const docId = await insertDocument(env, {
    title,
    fileType: "text/plain",
    fileSize: rendered.text.length,
    bytes: new TextEncoder().encode(rendered.text).buffer as ArrayBuffer,
    contextType: "job",
    jobId: lw.job_id,
    category: "lien_waiver",
    uploadedBy: user.email,
  });

  await env.DB.prepare("UPDATE lien_waivers SET document_id = ? WHERE id = ?").bind(docId, id).run();
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'lien_waiver.generate', 'lien_waiver', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), user.email, id, JSON.stringify({ document_id: docId, template_version: tpl.version }))
    .run();

  return json({ ok: true, document_id: docId, title, missing_fields: rendered.missing }, { status: 201 });
}
