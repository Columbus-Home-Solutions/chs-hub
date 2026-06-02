/**
 * Document Template Manager — Sprint 15 (Module-Spec-Document-Management §3.2,
 * §4.3). DB-backed, general-purpose templates (lien waivers, proposals, ad-hoc
 * docs) with merge-field auto-population. This is ADDITIVE — it does NOT rewire
 * the Sprint 5 quote-delivery contract path (src/lib/contracts.ts stays the
 * source of truth for the deposit flow; carried-over decision: no consolidation
 * this sprint).
 *
 * ── Versioning invariant (business rule 4 — the hard part) ───────────────────
 * Templates use COPY-ON-WRITE versioning over a `previous_version_id` lineage
 * (migration 0037):
 *   • The HEAD of a lineage = the row no other row supersedes (no row points at
 *     it via previous_version_id). There is EXACTLY ONE head per lineage.
 *   • Editing content/name/type/merge_fields inserts a NEW head: version+1,
 *     previous_version_id → the prior head. The prior head becomes immutable
 *     history (is_active forced to 0 so it can never be used or toggled again).
 *   • is_active on the HEAD is the availability switch (activate/deactivate). It
 *     does not fork a version.
 *   • Generated documents are static R2 artifacts, so a doc generated from an
 *     old version keeps its original rendered content regardless of later edits
 *     — immutability is satisfied by the artifact, versioning is purely a
 *     template-row concern.
 *
 *   GET  /api/document-templates          (O)     list heads (current versions)
 *   GET  /api/document-templates/:id      (O)     detail + version history
 *   POST /api/document-templates          (O)     create (v1)
 *   PUT  /api/document-templates/:id      (O)     edit = new version (or activate/deactivate)
 *   POST /api/document-templates/:id/preview  (O)     render w/ sample data, no storage
 *   POST /api/document-templates/:id/generate (O/PM)  render w/ real ctx → documents row
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  resolveMergeFields,
  renderMergeContent,
  sampleMergeFields,
  MERGE_FIELD_CATALOG,
} from "../lib/merge-fields.js";
import { insertDocument } from "./documents.js";

const OWNER_ONLY = ["owner"] as const;
const GENERATE_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

interface TemplateRow {
  id: string;
  name: string;
  template_type: string;
  content: string;
  merge_fields: string;
  is_active: number;
  version: number;
  previous_version_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Map a template_type to the document_category its generated docs land in. */
function categoryForType(templateType: string): string {
  switch (templateType) {
    case "service_agreement":
    case "cost_plus_agreement":
      return "contract";
    case "change_order":
      return "change_order";
    case "lien_waiver":
      return "lien_waiver";
    default:
      return "other";
  }
}

async function loadTemplate(env: Env, id: string): Promise<TemplateRow | null> {
  return env.DB.prepare(
    `SELECT id, name, template_type, content, merge_fields, is_active, version,
            previous_version_id, created_at, updated_at
       FROM document_templates WHERE id = ?`,
  )
    .bind(id)
    .first<TemplateRow>();
}

/** Is this row the head of its lineage (nothing supersedes it)? */
async function isHead(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT 1 AS x FROM document_templates WHERE previous_version_id = ? LIMIT 1",
  )
    .bind(id)
    .first<{ x: number }>();
  return !r;
}

function parseMergeFields(raw: unknown): string {
  if (Array.isArray(raw)) return JSON.stringify(raw);
  if (typeof raw === "string" && raw.trim()) {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return JSON.stringify(raw.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return JSON.stringify([]);
}

// ─── GET /api/document-templates (heads only) ───────────────────────────────

export async function handleTemplateList(env: Env, _url: URL): Promise<Response> {
  // Heads (current versions) of every lineage, active or not. The manager dims
  // inactive ones; generation refuses inactive (handleTemplateGenerate).
  const { results } = await env.DB.prepare(
    `SELECT id, name, template_type, is_active, version, previous_version_id, created_at, updated_at
       FROM document_templates t
      WHERE NOT EXISTS (SELECT 1 FROM document_templates n WHERE n.previous_version_id = t.id)
      ORDER BY name ASC`,
  ).all<TemplateRow>();
  return json({ templates: results ?? [], merge_field_catalog: MERGE_FIELD_CATALOG });
}

// ─── GET /api/document-templates/:id (detail + history) ─────────────────────

export async function handleTemplateGet(env: Env, id: string): Promise<Response> {
  const head = await loadTemplate(env, id);
  if (!head) return err(404, "not_found");

  // Walk the lineage backward (head → … → v1) for version history.
  const history: Array<{ id: string; version: number; created_at: string; is_active: number }> = [];
  let cursor: TemplateRow | null = head;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    history.push({ id: cursor.id, version: cursor.version, created_at: cursor.created_at, is_active: cursor.is_active });
    cursor = cursor.previous_version_id ? await loadTemplate(env, cursor.previous_version_id) : null;
  }

  let mergeFields: unknown = [];
  try {
    mergeFields = JSON.parse(head.merge_fields || "[]");
  } catch {
    mergeFields = [];
  }
  return json({
    template: { ...head, merge_fields: mergeFields },
    history,
    merge_field_catalog: MERGE_FIELD_CATALOG,
  });
}

// ─── POST /api/document-templates (create v1) ───────────────────────────────

export async function handleTemplateCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const templateType = typeof body.template_type === "string" ? body.template_type.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !templateType || !content) return err(400, "name_type_content_required");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isActive = body.is_active === false ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO document_templates
       (id, name, template_type, content, merge_fields, is_active, version, previous_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  )
    .bind(id, name, templateType, content, parseMergeFields(body.merge_fields), isActive, now, now)
    .run();
  return json({ id, version: 1 }, { status: 201 });
}

// ─── PUT /api/document-templates/:id (edit = new version | toggle) ──────────

export async function handleTemplateUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const head = await loadTemplate(env, id);
  if (!head) return err(404, "not_found");
  if (!(await isHead(env, id))) {
    return err(409, "not_current_version", "Edit the current version of the template, not an archived one.");
  }

  const wantsContentEdit =
    typeof body.content === "string" ||
    typeof body.name === "string" ||
    typeof body.template_type === "string" ||
    body.merge_fields !== undefined;

  // Pure availability toggle → in-place on the head, no new version.
  if (!wantsContentEdit && typeof body.is_active === "boolean") {
    await env.DB.prepare("UPDATE document_templates SET is_active = ?, updated_at = ? WHERE id = ?")
      .bind(body.is_active ? 1 : 0, new Date().toISOString(), id)
      .run();
    return json({ ok: true, id, version: head.version, is_active: body.is_active ? 1 : 0, versioned: false });
  }

  if (!wantsContentEdit) return err(400, "no_changes");

  // Copy-on-write: new head row, prior head frozen as history (is_active=0).
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : head.name;
  const templateType =
    typeof body.template_type === "string" && body.template_type.trim()
      ? body.template_type.trim()
      : head.template_type;
  const content = typeof body.content === "string" ? body.content : head.content;
  const mergeFields = body.merge_fields !== undefined ? parseMergeFields(body.merge_fields) : head.merge_fields;
  const isActive = typeof body.is_active === "boolean" ? (body.is_active ? 1 : 0) : head.is_active;

  const batch = [
    env.DB.prepare(
      `INSERT INTO document_templates
         (id, name, template_type, content, merge_fields, is_active, version, previous_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId, name, templateType, content, mergeFields, isActive, head.version + 1, head.id, now, now),
    // Freeze the prior head as immutable history.
    env.DB.prepare("UPDATE document_templates SET is_active = 0, updated_at = ? WHERE id = ?").bind(now, head.id),
  ];
  await env.DB.batch(batch);
  return json({ id: newId, previous_version_id: head.id, version: head.version + 1, versioned: true });
}

// ─── POST /api/document-templates/:id/preview (no storage) ──────────────────

export async function handleTemplatePreview(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const tpl = await loadTemplate(env, id);
  if (!tpl) return err(404, "not_found");
  const rendered = renderMergeContent(tpl.content, sampleMergeFields());
  return json({ ok: true, preview: rendered.text, missing_fields: rendered.missing });
}

// ─── POST /api/document-templates/:id/generate → documents row ──────────────

export async function handleTemplateGenerate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...GENERATE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const tpl = await loadTemplate(env, id);
  if (!tpl) return err(404, "not_found");
  if (tpl.is_active !== 1) return err(409, "template_inactive", "Activate the template before generating.");

  const jobId = typeof body.job_id === "string" ? body.job_id : null;
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  const estimateId = typeof body.estimate_id === "string" ? body.estimate_id : null;

  const fields = await resolveMergeFields(env, { job_id: jobId, client_id: clientId, estimate_id: estimateId });
  const rendered = renderMergeContent(tpl.content, fields);

  const contextType: "job" | "client" | "estimate" | "company" = jobId
    ? "job"
    : clientId
      ? "client"
      : estimateId
        ? "estimate"
        : "company";
  const category =
    typeof body.document_category === "string" ? body.document_category : categoryForType(tpl.template_type);
  const titleSuffix = fields.client_name || fields.job_number || fields.today_date;
  const title = `${tpl.name}${titleSuffix ? ` — ${titleSuffix}` : ""}`;

  const docId = await insertDocument(env, {
    title,
    fileType: "text/plain",
    fileSize: rendered.text.length,
    bytes: new TextEncoder().encode(rendered.text).buffer as ArrayBuffer,
    contextType,
    jobId,
    clientId,
    estimateId,
    category,
    uploadedBy: user.email,
  });

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'document.generate', 'document', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), user.email, docId, JSON.stringify({ template_id: id, template_version: tpl.version, category }))
    .run();

  return json(
    {
      ok: true,
      document_id: docId,
      title,
      document_category: category,
      template_version: tpl.version,
      missing_fields: rendered.missing,
    },
    { status: 201 },
  );
}
