/**
 * Shared estimate sub-item creation — used by POST /api/line-items/:id/sub-items
 * ("+ Add Sub-Item" / "+ Add Labor/Sub") and bid award when no linked sub-item exists.
 */

import type { Env } from "../env.js";
import { recomputeEstimate } from "../routes/estimates.js";

export const MATERIAL_FLOW_CATEGORIES = ["material", "permit", "equipment", "other"] as const;

export interface CreateEstimateSubItemInput {
  description?: string | null;
  category?: string | null;
  vendor?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unit_cost?: number | null;
  material_id?: string | null;
  notes?: string | null;
  sort_order?: number | null;
  /** When set, description/vendor/category are derived from the subcontractors row. */
  sub_id?: string | null;
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

export function displayNameFromSub(sub: {
  company_name?: string | null;
  company?: string | null;
  contact_name?: string | null;
  primary_contact?: string | null;
}): string {
  return (
    str(sub.company_name) ??
    str(sub.company) ??
    str(sub.contact_name) ??
    str(sub.primary_contact) ??
    "Vendor"
  );
}

export function categoryFromWorkerType(workerType: string | null | undefined): "labor" | "subcontractor" {
  return workerType === "day_rate_labor" ? "labor" : "subcontractor";
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
  let unit = str(input.unit);

  let materialId = str(input.material_id);
  let resolvedVendor = str(input.vendor);
  let description = str(input.description);
  let category = str(input.category);
  let subId = str(input.sub_id);

  if (subId) {
    const sub = await env.DB.prepare(
      `SELECT id, company_name, company, contact_name, primary_contact, worker_type, day_rate
         FROM subcontractors WHERE id = ?`,
    )
      .bind(subId)
      .first<{
        id: string;
        company_name: string | null;
        company: string | null;
        contact_name: string | null;
        primary_contact: string | null;
        worker_type: string | null;
        day_rate: number | null;
      }>();
    if (!sub) {
      throw new SubItemValidationError("unknown_sub", "sub_id does not match a subcontractor");
    }
    const name = displayNameFromSub(sub);
    description = name;
    resolvedVendor = name;
    category = categoryFromWorkerType(sub.worker_type);
    if (
      sub.worker_type === "day_rate_labor" &&
      sub.day_rate != null &&
      Number.isFinite(sub.day_rate) &&
      (input.unit_cost == null || input.unit_cost === 0) &&
      unitCost === 0
    ) {
      unitCost = sub.day_rate;
      if (!unit) unit = "day";
    }
  } else {
    if (!description) {
      throw new SubItemValidationError("description_required", "description is required");
    }
    if (!category) {
      throw new SubItemValidationError("category_required", "category is required");
    }
    if (category === "labor" || category === "subcontractor") {
      throw new SubItemValidationError(
        "use_labor_sub_flow",
        "Labor and subcontractor costs must be added via the Labor/Sub flow with a linked person (sub_id)",
      );
    }
    if (!(MATERIAL_FLOW_CATEGORIES as readonly string[]).includes(category)) {
      throw new SubItemValidationError(
        "invalid_category",
        `category must be one of: ${MATERIAL_FLOW_CATEGORIES.join(", ")}`,
      );
    }
  }

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
      (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, sub_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      lineItemId,
      sortOrder,
      description,
      category,
      resolvedVendor,
      quantity,
      unit,
      unitCost,
      round2((quantity ?? 0) * unitCost),
      materialId,
      str(input.notes),
      subId,
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
        JSON.stringify({ parent_line_item_id: lineItemId, category, sub_id: subId }),
      )
      .run();
  }

  return { id, estimate_id: parent.estimate_id };
}

export class SubItemValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SubItemValidationError";
  }
}
