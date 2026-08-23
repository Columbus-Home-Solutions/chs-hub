/**
 * Pending supplier-quote imports (email intake queue).
 *
 *   GET    /api/pending-quote-imports              list (?status=pending)
 *   GET    /api/pending-quote-imports/:id          detail
 *   POST   /api/pending-quote-imports/:id/discard  mark discarded
 *   POST   /api/pending-quote-imports/:id/assign   after confirm — mark assigned
 *   POST   /api/pending-quote-imports/simulate     owner test inject (no real email)
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { ingestQuoteEmailRaw, QUOTE_INTAKE_ADDRESS } from "../lib/inbound-quote-email.js";

const READ_ROLES = ["owner", "project_manager", "office_admin"] as const;
const WRITE_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, code: string, details?: string): Response {
  return json({ error: code, details }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

interface PendingRow {
  id: string;
  source: string;
  from_address: string | null;
  subject: string | null;
  received_at: string;
  raw_text: string | null;
  extraction_json: string | null;
  extraction_error: string | null;
  attachments: string | null;
  status: string;
  assigned_estimate_id: string | null;
  assigned_line_item_id: string | null;
  created_estimate_sub_item_ids: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

function parseExtraction(raw: string | null) {
  if (!raw) return { vendor_guess: null, lines: [], quote_total: null };
  try {
    const o = JSON.parse(raw) as {
      vendor_guess?: string | null;
      lines?: unknown[];
      quote_total?: number | null;
    };
    return {
      vendor_guess: o.vendor_guess ?? null,
      lines: Array.isArray(o.lines) ? o.lines : [],
      quote_total: o.quote_total ?? null,
    };
  } catch {
    return { vendor_guess: null, lines: [], quote_total: null };
  }
}

function parseAttachments(raw: string | null) {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function shape(row: PendingRow) {
  const extraction = parseExtraction(row.extraction_json);
  const attachments = parseAttachments(row.attachments);
  return {
    id: row.id,
    source: row.source,
    from_address: row.from_address,
    subject: row.subject,
    received_at: row.received_at,
    raw_text: row.raw_text,
    extraction,
    extraction_error: row.extraction_error,
    attachments,
    line_count: extraction.lines.length,
    vendor_guess: extraction.vendor_guess,
    quote_total: extraction.quote_total,
    status: row.status,
    assigned_estimate_id: row.assigned_estimate_id,
    assigned_line_item_id: row.assigned_line_item_id,
    created_estimate_sub_item_ids: row.created_estimate_sub_item_ids
      ? (() => {
          try {
            return JSON.parse(row.created_estimate_sub_item_ids);
          } catch {
            return null;
          }
        })()
      : null,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    intake_address: QUOTE_INTAKE_ADDRESS,
  };
}

export async function handlePendingQuoteImportList(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const status = str(url.searchParams.get("status")) ?? "pending";
  const rows =
    (
      await env.DB.prepare(
        `SELECT * FROM pending_quote_imports
         WHERE status = ?
         ORDER BY received_at DESC
         LIMIT 100`,
      )
        .bind(status)
        .all<PendingRow>()
    ).results ?? [];

  const pendingCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pending_quote_imports WHERE status = 'pending'`,
  ).first<{ n: number }>();

  return json({
    items: rows.map(shape),
    pending_count: pendingCount?.n ?? 0,
    intake_address: QUOTE_INTAKE_ADDRESS,
  });
}

export async function handlePendingQuoteImportGet(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare("SELECT * FROM pending_quote_imports WHERE id = ?")
    .bind(id)
    .first<PendingRow>();
  if (!row) return err(404, "not_found");
  return json({ item: shape(row) });
}

export async function handlePendingQuoteImportDiscard(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare("SELECT id, status FROM pending_quote_imports WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return err(404, "not_found");
  if (row.status !== "pending") return err(400, "bad_request", "Only pending imports can be discarded");

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE pending_quote_imports
       SET status = 'discarded', resolved_at = ?, resolved_by = ?
     WHERE id = ?`,
  )
    .bind(now, user.email, id)
    .run();

  return json({ ok: true });
}

/** Mark assigned after successful import-quote-confirm (called by UI). */
export async function handlePendingQuoteImportAssign(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const estimateId = str(body.estimate_id);
  const lineItemId = str(body.line_item_id);
  if (!estimateId || !lineItemId) {
    return err(400, "bad_request", "estimate_id and line_item_id are required");
  }

  const row = await env.DB.prepare("SELECT id, status FROM pending_quote_imports WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return err(404, "not_found");
  if (row.status !== "pending") return err(400, "bad_request", "Import is not pending");

  const subIds = Array.isArray(body.sub_item_ids)
    ? (body.sub_item_ids as unknown[]).map((x) => String(x))
    : [];

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE pending_quote_imports
       SET status = 'assigned',
           assigned_estimate_id = ?,
           assigned_line_item_id = ?,
           created_estimate_sub_item_ids = ?,
           resolved_at = ?,
           resolved_by = ?
     WHERE id = ?`,
  )
    .bind(estimateId, lineItemId, JSON.stringify(subIds), now, user.email, id)
    .run();

  return json({ ok: true });
}

/**
 * Owner-only simulate: inject a synthetic email body through the same ingest path
 * used by the Email Worker (for testing without live MX).
 */
export async function handlePendingQuoteImportSimulate(
  request: Request,
  env: Env,
): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const text = str(body.text);
  if (!text) return err(400, "bad_request", "text is required");

  const subject = str(body.subject) ?? "Simulated supplier quote";
  const from = str(body.from) ?? "quotes@lowes.com";
  const rawMime = [
    `From: ${from}`,
    `To: ${QUOTE_INTAKE_ADDRESS}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
  ].join("\r\n");

  const id = await ingestQuoteEmailRaw(env, {
    from,
    subject,
    receivedAt: new Date().toISOString(),
    raw: new TextEncoder().encode(rawMime).buffer,
  });

  const row = await env.DB.prepare("SELECT * FROM pending_quote_imports WHERE id = ?")
    .bind(id)
    .first<PendingRow>();
  return json({ item: row ? shape(row) : null }, { status: 201 });
}
