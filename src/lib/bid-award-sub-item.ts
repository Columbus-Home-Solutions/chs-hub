/**
 * Apply a winning bid price to the estimate internal cost breakdown.
 * When no estimate_sub_item_id exists but estimate_line_item_id does,
 * creates a subcontractor sub-item via createEstimateSubItem (same as "+ Add Sub-Item").
 */

import type { Env } from "../env.js";
import { recomputeEstimate } from "../routes/estimates.js";
import { createEstimateSubItem } from "./estimate-sub-items.js";

export interface BidAwardCostContext {
  id: string;
  estimate_id: string | null;
  estimate_line_item_id: string | null;
  estimate_sub_item_id: string | null;
  title: string;
  quantities_notes: string | null;
}

/**
 * Parse a simple "number unit" quantities_notes string (e.g. "1000 sqft").
 * Returns null if the whole string doesn't cleanly match — no partial guessing.
 */
export function parseQuantitiesNotes(
  notes: string | null | undefined,
): { quantity: number; unit: string } | null {
  if (!notes) return null;
  const trimmed = notes.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s+((?:[A-Za-z][\w.\-]*)(?:\s+[A-Za-z][\w.\-]*){0,1})$/);
  if (!match) return null;
  const quantity = parseFloat(match[1]);
  const unit = match[2].trim();
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  return { quantity, unit };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Create or update estimate_sub_items for an awarded bid.
 * Returns the sub-item id that received the cost (new or existing).
 */
export async function applyBidAwardSubItemCost(
  env: Env,
  br: BidAwardCostContext,
  winningPrice: number,
  vendorName: string | null,
): Promise<string | null> {
  const price = round2(winningPrice);
  if (price <= 0) return null;

  if (br.estimate_sub_item_id) {
    const subItem = await env.DB.prepare(
      `SELECT id, material_id, quantity FROM estimate_sub_items WHERE id = ?`,
    )
      .bind(br.estimate_sub_item_id)
      .first<{ id: string; material_id: string | null; quantity: number | null }>();

    if (!subItem) return null;

    const qty = subItem.quantity ?? 1;
    const unitCost = round2(price / qty);
    await env.DB.prepare(
      `UPDATE estimate_sub_items SET unit_cost = ?, total_cost = ? WHERE id = ?`,
    )
      .bind(unitCost, price, br.estimate_sub_item_id)
      .run();

    if (subItem.material_id) {
      const { applyVendorMaterialPriceUpdate } = await import("./receipt-matching.js");
      const today = new Date().toISOString().slice(0, 10);
      await applyVendorMaterialPriceUpdate(env.DB, subItem.material_id, price, today);
    }

    if (br.estimate_id) await recomputeEstimate(env, br.estimate_id);
    return br.estimate_sub_item_id;
  }

  if (!br.estimate_line_item_id) return null;

  const parsed = parseQuantitiesNotes(br.quantities_notes);
  // "+ Add Sub-Item" always sends quantity: 1 when none is specified.
  const quantity = parsed?.quantity ?? 1;
  const unitCost = round2(price / quantity);

  const created = await createEstimateSubItem(env, br.estimate_line_item_id, {
    description: br.title,
    category: "subcontractor",
    vendor: vendorName,
    quantity: parsed ? parsed.quantity : 1,
    unit: parsed?.unit ?? null,
    unit_cost: unitCost,
  });

  return created?.id ?? null;
}
