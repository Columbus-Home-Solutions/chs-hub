/**
 * Scope draft API — AI-generated estimate line items from visit notes (Sprint 28).
 *
 *   POST   /api/estimate-requests/:id/scope-draft   generate draft (Claude)
 *   PATCH  /api/estimate-requests/:id/scope-draft   update one draft item
 *   DELETE /api/estimate-requests/:id/scope-draft     clear draft
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  generateScopeDraft,
  parseStoredScopeDraft,
  type ScopeDraftItem,
  type ScopeDraftStatus,
  type SketchImageBlock,
} from "../lib/scope-draft.js";
import { parseSketches } from "../lib/sketches.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;
const VALID_STATUSES: ReadonlySet<ScopeDraftStatus> = new Set([
  "pending",
  "accepted",
  "discarded",
]);

interface CatalogRow {
  id: string;
  name: string;
  unit: string | null;
  unit_price: number;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, ...(details ? { details } : {}) }, { status });
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

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function loadRequest(
  env: Env,
  id: string,
): Promise<{
  id: string;
  visit_notes: string | null;
  scope_draft: string | null;
  sketches: string | null;
} | null> {
  return env.DB.prepare(
    "SELECT id, visit_notes, scope_draft, sketches FROM estimate_requests WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      visit_notes: string | null;
      scope_draft: string | null;
      sketches: string | null;
    }>();
}

async function fetchActiveCatalog(env: Env): Promise<CatalogRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, unit, unit_price FROM line_item_catalog WHERE is_active = 1 ORDER BY name ASC",
  ).all<CatalogRow>();
  return results ?? [];
}

/** POST /api/estimate-requests/:id/scope-draft */
export async function handleScopeDraftGenerate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, id);
  if (!row) return err(404, "not_found", "Estimate request not found");

  const visitNotes = str(row.visit_notes);
  const sketches = parseSketches(row.sketches);
  const hasSketches = sketches.length > 0;

  const visitPhotoRows = await env.DB.prepare(
    `SELECT id, thumb_key, r2_thumbnail_key, r2_key
       FROM photos
      WHERE estimate_request_id = ?
        AND COALESCE(is_active, 1) = 1
      ORDER BY COALESCE(taken_at, created_at) ASC
      LIMIT 6`,
  )
    .bind(id)
    .all<{
      id: string;
      thumb_key: string | null;
      r2_thumbnail_key: string | null;
      r2_key: string | null;
    }>();
  const visitPhotos = visitPhotoRows.results ?? [];
  const hasPhotos = visitPhotos.length > 0;

  if (!visitNotes && !hasSketches && !hasPhotos) {
    return json(
      { error: "Add visit notes, a sketch, or photos before generating a scope draft." },
      { status: 400 },
    );
  }

  const visionImages: SketchImageBlock[] = [];
  if (hasSketches) {
    for (const sketch of sketches.slice(0, 3)) {
      try {
        const thumbObj = await env.FILES.get(sketch.thumbnail_key);
        if (!thumbObj) continue;
        const bytes = await thumbObj.arrayBuffer();
        visionImages.push({
          base64: arrayBufferToBase64(bytes),
          mediaType: "image/png",
        });
      } catch {
        // Skip failed fetches — graceful degradation
      }
    }
  }
  // Visit photos as JPEG vision input (same Claude path as sketch thumbs).
  const photoSlots = Math.max(0, 6 - visionImages.length);
  for (const photo of visitPhotos.slice(0, photoSlots)) {
    const key = photo.r2_thumbnail_key ?? photo.thumb_key ?? photo.r2_key;
    if (!key) continue;
    try {
      const thumbObj = await env.FILES.get(key);
      if (!thumbObj) continue;
      const bytes = await thumbObj.arrayBuffer();
      visionImages.push({
        base64: arrayBufferToBase64(bytes),
        mediaType: "image/jpeg",
      });
    } catch {
      // Skip failed fetches — graceful degradation
    }
  }

  const catalogItems = await fetchActiveCatalog(env);
  const result = await generateScopeDraft(env, visitNotes, visionImages, catalogItems);
  if (!result.ok) {
    return json(
      { error: "Scope draft generation failed.", details: result.error },
      { status: 500 },
    );
  }

  const generatedAt = result.items[0]?.generated_at ?? new Date().toISOString();
  const scopeDraftJson = JSON.stringify(result.items);

  await env.DB.prepare(
    "UPDATE estimate_requests SET scope_draft = ?, updated_at = ? WHERE id = ?",
  )
    .bind(scopeDraftJson, generatedAt, id)
    .run();

  return json({ draft: result.items, generated_at: generatedAt });
}

/** PATCH /api/estimate-requests/:id/scope-draft */
export async function handleScopeDraftPatch(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, id);
  if (!row) return err(404, "not_found", "Estimate request not found");

  const draft = parseStoredScopeDraft(row.scope_draft);
  if (!draft || draft.length === 0) {
    return err(400, "bad_request", "No scope draft exists for this request");
  }

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const itemIndex = Number(body.item_index);
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= draft.length) {
    return err(400, "bad_request", "item_index is out of range");
  }

  const updates = body.updates;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return err(400, "bad_request", "updates object is required");
  }
  const patch = updates as Record<string, unknown>;

  const item: ScopeDraftItem = { ...draft[itemIndex] };

  if ("status" in patch) {
    const status = str(patch.status) as ScopeDraftStatus | null;
    if (!status || !VALID_STATUSES.has(status)) {
      return err(400, "bad_request", 'status must be "pending", "accepted", or "discarded"');
    }
    item.status = status;
  }
  if ("product_service" in patch) {
    const v = str(patch.product_service);
    if (!v) return err(400, "bad_request", "product_service cannot be empty");
    item.product_service = v;
  }
  if ("description" in patch) {
    item.description = str(patch.description) ?? "";
  }
  if ("quantity" in patch) {
    const q = Number(patch.quantity);
    if (!Number.isFinite(q) || q <= 0) {
      return err(400, "bad_request", "quantity must be a positive number");
    }
    item.quantity = q;
  }
  if ("unit" in patch) {
    const v = str(patch.unit);
    if (!v) return err(400, "bad_request", "unit cannot be empty");
    item.unit = v;
  }
  if ("unit_price" in patch) {
    item.unit_price = numOrNull(patch.unit_price);
  }

  draft[itemIndex] = item;
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE estimate_requests SET scope_draft = ?, updated_at = ? WHERE id = ?",
  )
    .bind(JSON.stringify(draft), now, id)
    .run();

  return json({ draft });
}

/** DELETE /api/estimate-requests/:id/scope-draft */
export async function handleScopeDraftDelete(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, id);
  if (!row) return err(404, "not_found", "Estimate request not found");

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE estimate_requests SET scope_draft = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();

  return json({ success: true });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function recomputeEstimateTotals(env: Env, estimateId: string): Promise<void> {
  const lineItems = (
    await env.DB.prepare("SELECT id, quantity, unit_price FROM estimate_line_items WHERE estimate_id = ?")
      .bind(estimateId)
      .all<{ id: string; quantity: number; unit_price: number }>()
  ).results ?? [];

  let subtotal = 0;
  for (const li of lineItems) {
    const lineTotal = round2((li.quantity ?? 0) * (li.unit_price ?? 0));
    subtotal += lineTotal;
    await env.DB.prepare("UPDATE estimate_line_items SET total = ? WHERE id = ?")
      .bind(lineTotal, li.id)
      .run();
  }
  subtotal = round2(subtotal);

  const est = await env.DB.prepare(
    "SELECT tax_amount, deposit_type, deposit_percentage FROM estimates WHERE id = ?",
  )
    .bind(estimateId)
    .first<{
      tax_amount: number | null;
      deposit_type: string | null;
      deposit_percentage: number | null;
    }>();

  const tax = est?.tax_amount ?? 0;
  const total = round2(subtotal + tax);
  const now = new Date().toISOString();

  if (est?.deposit_type === "percentage" && est.deposit_percentage != null) {
    const depositAmount = round2((est.deposit_percentage / 100) * total);
    await env.DB.prepare(
      "UPDATE estimates SET subtotal = ?, total = ?, deposit_amount = ?, updated_at = ? WHERE id = ?",
    )
      .bind(subtotal, total, depositAmount, now, estimateId)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE estimates SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?",
    )
      .bind(subtotal, total, now, estimateId)
      .run();
  }
}

async function insertLineItemsFromDraft(
  env: Env,
  estimateId: string,
  items: ScopeDraftItem[],
): Promise<number> {
  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS n FROM estimate_line_items WHERE estimate_id = ?",
  )
    .bind(estimateId)
    .first<{ n: number }>();
  let sortOrder = (maxSort?.n ?? -1) + 1;
  const now = new Date().toISOString();

  for (const item of items) {
    const quantity = item.quantity > 0 ? item.quantity : 1;
    const unitPrice = item.unit_price ?? 0;
    const lineTotal = round2(quantity * unitPrice);
    await env.DB.prepare(
      `INSERT INTO estimate_line_items
        (id, estimate_id, sort_order, product_service, description, quantity, unit, unit_price, total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        estimateId,
        sortOrder,
        item.product_service,
        item.description ?? "",
        quantity,
        item.unit,
        unitPrice,
        lineTotal,
        now,
      )
      .run();
    sortOrder += 1;
  }

  await recomputeEstimateTotals(env, estimateId);
  return items.length;
}

/** POST /api/estimate-requests/:id/push-to-estimate */
export async function handlePushToEstimate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    `SELECT id, client_id, job_type, property_address, estimate_id, scope_draft, status
     FROM estimate_requests WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      client_id: string;
      job_type: string;
      property_address: string;
      estimate_id: string | null;
      scope_draft: string | null;
      status: string;
    }>();
  if (!row) return err(404, "not_found", "Estimate request not found");

  const draft = parseStoredScopeDraft(row.scope_draft);
  const accepted = (draft ?? []).filter((item) => item.status === "accepted");
  if (accepted.length === 0) {
    return json({ error: "No accepted scope draft items to push." }, { status: 400 });
  }

  const now = new Date().toISOString();
  let estimateId = row.estimate_id;
  let estimateCreated = false;

  if (!estimateId) {
    const maxNum = await env.DB.prepare(
      "SELECT COALESCE(MAX(estimate_number), 0) AS n FROM estimates",
    ).first<{ n: number }>();
    const estimateNumber = (maxNum?.n ?? 0) + 1;
    estimateId = crypto.randomUUID();
    const title = `${(row.job_type ?? "Estimate").replace(/_/g, " ")} — ${row.property_address ?? ""}`.trim();

    await env.DB.prepare(
      `INSERT INTO estimates (
        id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
        status, subtotal, tax_amount, total, margin_percent,
        deposit_amount, deposit_type, deposit_percentage, valid_days,
        include_reviews, include_contract, version,
        created_at, updated_at, created_by
      ) VALUES (?, ?, ?, ?, ?, 'lump_sum', 'fixed_price', 'draft', 0, 0, 0, 0, 0, 'percentage', 33, 7, 1, 1, 1, ?, ?, ?)`,
    )
      .bind(estimateId, estimateNumber, id, row.client_id, title, now, now, user.id)
      .run();

    await env.DB.prepare("UPDATE estimate_requests SET estimate_id = ?, updated_at = ? WHERE id = ?")
      .bind(estimateId, now, id)
      .run();

    estimateCreated = true;

    try {
      await env.DB.prepare(
        `UPDATE estimate_requests SET status = 'building', updated_at = ?
         WHERE id = ? AND status IN ('appointment_set', 'visit_done')`,
      )
        .bind(now, id)
        .run();
    } catch (e) {
      console.warn("[push-to-estimate] status advance failed:", (e as Error).message);
    }

    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'estimate_created', 'estimate', ?, ?, datetime('now'))",
    )
      .bind(
        crypto.randomUUID(),
        user.email,
        estimateId,
        JSON.stringify({ request_id: id, source: "scope_draft_push" }),
      )
      .run();
  } else {
    const existing = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?")
      .bind(estimateId)
      .first();
    if (!existing) return err(404, "not_found", "Linked estimate not found");
  }

  const itemsAdded = await insertLineItemsFromDraft(env, estimateId, accepted);

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'scope_draft_pushed', 'estimate_request', ?, ?, datetime('now'))",
  )
    .bind(
      crypto.randomUUID(),
      user.email,
      id,
      JSON.stringify({ estimate_id: estimateId, items_added: itemsAdded, estimate_created: estimateCreated }),
    )
    .run();

  return json({
    estimate_id: estimateId,
    items_added: itemsAdded,
    estimate_created: estimateCreated,
  });
}
