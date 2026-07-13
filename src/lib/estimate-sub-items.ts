/**
 * Shared estimate sub-item creation — used by POST /api/line-items/:id/sub-items
 * ("+ Add Sub-Item") and bid award when no linked sub-item exists.
 */

import type { Env } from "../env.js";
import { recomputeEstimate } from "../routes/estimates.js";

export interface CreateEstimateSubItemInput {
  description: string;
  category: string;
  vendor?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unit_cost?: number | null;
  material_id?: string | null;
  notes?: string | null;
  sort_order?: number | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Insert an estimate_sub_items row and recompute the parent estimate totals.
 * Mirrors the core logic of handleSubItemCreate (Estimate Builder "+ Add Sub-Item").
 */
export async function createEstimateSubItem(
  env: Env,
  lineItemId: string,
  input: CreateEstimateSubItemInput,
  opts?: { auditUserEmail?: string | null },
): Promise<{ id: string; estimate_id: string } | null> {
  const parent = await env.DB.prepare(
    "SELECT id, estimate_id FROM estimate_line_items WHERE id = ?",
  )
    .bind(lineItemId)
    .first<{ id: string; estimate_id: string }>();
  if (!parent) return null;

  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS n FROM estimate_sub_items WHERE parent_line_item_id = ?",
  )
    .bind(lineItemId)
    .first<{ n: number }>();
  const sortOrder = input.sort_order ?? (maxSort?.n ?? -1) + 1;

  const id = crypto.randomUUID();
  const quantity = input.quantity ?? null;
  let unitCost = input.unit_cost ?? 0;

  let materialId = str(input.material_id);
  let resolvedVendor = str(input.vendor);
  if (materialId) {
    const mat = await env.DB.prepare(
      "SELECT id, vendor_name, last_price FROM vendor_materials WHERE id = ?",
    )
      .bind(materialId)
      .first<{ id: string; vendor_name: string; last_price: number }>();
    if (mat) {
      if (input.unit_cost == null) unitCost = mat.last_price;
      if (!resolvedVendor) resolvedVendor = mat.vendor_name;
    } else {
      materialId = null;
    }
  }

  await env.DB.prepare(
    `INSERT INTO estimate_sub_items
      (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      lineItemId,
      sortOrder,
      input.description,
      input.category,
      resolvedVendor,
      quantity,
      str(input.unit),
      unitCost,
      round2((quantity ?? 0) * unitCost),
      materialId,
      str(input.notes),
    )
    .run();

  await recomputeEstimate(env, parent.estimate_id);

  if (opts?.auditUserEmail) {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    )
      .bind(
        crypto.randomUUID(),
        opts.auditUserEmail,
        "estimate_sub_item_created",
        "estimate_sub_item",
        id,
        JSON.stringify({ parent_line_item_id: lineItemId, category: input.category }),
      )
      .run();
  }

  return { id, estimate_id: parent.estimate_id };
}
