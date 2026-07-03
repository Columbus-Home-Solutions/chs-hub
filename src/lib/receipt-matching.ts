/**
 * Receipt line-item extraction + estimate/catalog matching (Sprint 30 + 37).
 *
 * Claude vision reads individual line items from a receipt photo; text-only
 * calls match them to:
 *   Match A — estimate_sub_items (for bid-accuracy variance report)
 *   Match B — vendor_materials (for pricing-catalog updates)
 *
 * Extracted items are persisted to expense_line_items (Sprint 37). Failures
 * degrade gracefully — callers persist empty arrays, never abort upload.
 */

import type { Env } from "../env.js";
import { claudeMessages } from "./claude.js";
import { triggerNotification } from "./notification-engine.js";

export const RECEIPT_MATCH_MODEL = "claude-sonnet-4-6";
const MAX_EXTRACTED_ITEMS = 50;
const PRICE_HISTORY_CAP = 20;

export interface ExtractedItem {
  id: string;
  description: string;
  amount: number;
  quantity: number | null;
  unit_price: number | null;
}

/** Match A — estimate_sub_items */
export interface MatchResult {
  item_id: string;
  status: "matched" | "ambiguous" | "unmatched";
  suggested_line_item_id: string | null;
  suggested_line_item_name: string | null;
  confidence: number;
  alternatives: Array<{ line_item_id: string; line_item_name: string; confidence: number }>;
  confirmed_line_item_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

export interface LineItemForMatching {
  id: string;
  description: string;
}

/** Match B — vendor_materials */
export interface VendorMaterialForMatching {
  id: string;
  vendor_name: string;
  material_name: string;
  category: string | null;
  unit: string | null;
  last_price: number | null;
}

export interface VendorMatchResult {
  item_id: string;
  matched_vendor_material_id: string | null;
  match_confidence: number;
  /** true when unit_price is known but no catalog entry exists yet */
  is_new_material_candidate: boolean;
}

const EXTRACT_SYSTEM = `You are a receipt parser. Extract every individual line item from this receipt photo.
Return only a JSON array. Each element must have:
  - "description": the item name/description as printed on the receipt
  - "amount": the line item total as a number (not a string)
  - "quantity": the quantity if shown, otherwise null
  - "unit_price": the unit price if shown, otherwise null

Do not include the receipt subtotal, tax, total, tips, or discounts as line items.
Return an empty array [] if no individual items are visible (e.g. the receipt only shows a total).
Return only raw JSON — no markdown, no explanation.`;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function parseJsonArray(text: string | null): unknown[] | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function unmatchedResult(item: ExtractedItem): MatchResult {
  return {
    item_id: item.id,
    status: "unmatched",
    suggested_line_item_id: null,
    suggested_line_item_name: null,
    confidence: 0,
    alternatives: [],
    confirmed_line_item_id: null,
    confirmed_by: null,
    confirmed_at: null,
  };
}

function computeStatus(
  confidence: number,
  suggestedId: string | null,
  alternatives: MatchResult["alternatives"],
): MatchResult["status"] {
  if (confidence < 0.5 || !suggestedId) return "unmatched";
  const topAlt = alternatives.reduce((max, a) => Math.max(max, a.confidence), 0);
  const hasCloseAlt = topAlt >= confidence - 0.15;
  if (confidence >= 0.8 && !hasCloseAlt) return "matched";
  if (confidence >= 0.5) return "ambiguous";
  return "unmatched";
}

/** Extract individual line items from a receipt image stored in R2. */
export async function extractReceiptLineItems(
  imageR2Key: string,
  env: Env,
): Promise<ExtractedItem[]> {
  const obj = await env.FILES.get(imageR2Key);
  if (!obj) {
    console.warn(`[receipt-matching] R2 object missing: ${imageR2Key}`);
    return [];
  }

  const bytes = await obj.arrayBuffer();
  const base64 = arrayBufferToBase64(bytes);
  const mediaType = "image/jpeg";

  const call = await claudeMessages(env, {
    model: RECEIPT_MATCH_MODEL,
    system: EXTRACT_SYSTEM,
    maxTokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Extract all individual line items from this receipt." },
        ],
      },
    ],
  });

  if (!call.ok) {
    console.warn(`[receipt-matching] line-item extraction failed: ${call.error}`);
    return [];
  }

  const parsed = parseJsonArray(call.text);
  if (!parsed) {
    console.warn("[receipt-matching] unparseable line-item extraction response");
    return [];
  }

  const items: ExtractedItem[] = [];
  for (const raw of parsed) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const description = typeof row.description === "string" ? row.description.trim() : "";
    const amount = Number(row.amount);
    if (!description || !Number.isFinite(amount) || amount <= 0) continue;
    items.push({
      id: crypto.randomUUID(),
      description,
      amount,
      quantity: numOrNull(row.quantity),
      unit_price: numOrNull(row.unit_price),
    });
  }

  if (items.length > MAX_EXTRACTED_ITEMS) {
    console.warn(
      `[receipt-matching] truncating ${items.length} extracted items to ${MAX_EXTRACTED_ITEMS}`,
    );
    return items.slice(0, MAX_EXTRACTED_ITEMS);
  }

  return items;
}

/** Match extracted receipt items to parent estimate line items via Claude. */
export async function matchItemsToEstimate(
  extractedItems: ExtractedItem[],
  estimateLineItems: LineItemForMatching[],
  env: Env,
): Promise<MatchResult[]> {
  if (extractedItems.length === 0 || estimateLineItems.length === 0) {
    return extractedItems.map(unmatchedResult);
  }

  const prompt = `You are helping match receipt line items to construction estimate line items for job costing.

Estimate line items for this job:
${JSON.stringify(estimateLineItems, null, 2)}

Receipt items to match:
${JSON.stringify(
    extractedItems.map((i) => ({ id: i.id, description: i.description, amount: i.amount })),
    null,
    2,
  )}

For each receipt item, determine which estimate line item it most likely belongs to.
A receipt item may be a material purchase (e.g. "12x24 Porcelain Tile") that belongs
to an estimate line item (e.g. "Tile Installation").

Return only a JSON array, one object per receipt item, in the same order as the input:
[
  {
    "item_id": "<receipt item id>",
    "suggested_line_item_id": "<estimate line item id or null if no match>",
    "suggested_line_item_name": "<estimate line item description or null>",
    "confidence": 0.0 to 1.0,
    "alternatives": [
      { "line_item_id": "...", "line_item_name": "...", "confidence": 0.0 }
    ]
  }
]

Confidence guidelines:
- 0.90+: clear, obvious match (e.g. receipt says "tile" → estimate has "Tile Installation")
- 0.70–0.89: likely match with some ambiguity
- 0.50–0.69: possible match, user should confirm
- below 0.50: no good match found — set suggested_line_item_id to null

alternatives: include up to 2 other candidates if their confidence is above 0.30.
If there are no good alternatives, return an empty array.

Return only raw JSON — no markdown, no explanation.`;

  const call = await claudeMessages(env, {
    model: RECEIPT_MATCH_MODEL,
    system: "Return only valid JSON arrays. No markdown fences or prose.",
    maxTokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  if (!call.ok) {
    console.warn(`[receipt-matching] match call failed: ${call.error}`);
    return extractedItems.map(unmatchedResult);
  }

  const parsed = parseJsonArray(call.text);
  if (!parsed) {
    console.warn("[receipt-matching] unparseable match response");
    return extractedItems.map(unmatchedResult);
  }

  const lineItemById = new Map(estimateLineItems.map((li) => [li.id, li.description]));
  const results: MatchResult[] = [];

  for (let i = 0; i < extractedItems.length; i++) {
    const item = extractedItems[i];
    const raw = parsed[i];
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

    const suggestedId =
      typeof row.suggested_line_item_id === "string" && lineItemById.has(row.suggested_line_item_id)
        ? row.suggested_line_item_id
        : null;
    const confidence = clampConfidence(row.confidence);

    let suggestedName: string | null = null;
    if (typeof row.suggested_line_item_name === "string" && row.suggested_line_item_name.trim()) {
      suggestedName = row.suggested_line_item_name.trim();
    } else if (suggestedId) {
      suggestedName = lineItemById.get(suggestedId) ?? null;
    }

    const alternatives: MatchResult["alternatives"] = [];
    if (Array.isArray(row.alternatives)) {
      for (const alt of row.alternatives.slice(0, 2)) {
        if (!alt || typeof alt !== "object") continue;
        const a = alt as Record<string, unknown>;
        const lineItemId = typeof a.line_item_id === "string" ? a.line_item_id : null;
        if (!lineItemId || !lineItemById.has(lineItemId)) continue;
        const altConfidence = clampConfidence(a.confidence);
        if (altConfidence < 0.3) continue;
        alternatives.push({
          line_item_id: lineItemId,
          line_item_name:
            typeof a.line_item_name === "string" && a.line_item_name.trim()
              ? a.line_item_name.trim()
              : (lineItemById.get(lineItemId) ?? ""),
          confidence: altConfidence,
        });
      }
    }

    results.push({
      item_id: item.id,
      status: computeStatus(confidence, suggestedId, alternatives),
      suggested_line_item_id: suggestedId,
      suggested_line_item_name: suggestedName,
      confidence,
      alternatives,
      confirmed_line_item_id: null,
      confirmed_by: null,
      confirmed_at: null,
    });
  }

  return results;
}

/** Match B: fuzzy-match extracted items against vendor_materials catalog via Claude. */
export async function matchItemsToVendorMaterials(
  extractedItems: ExtractedItem[],
  vendorName: string | null,
  materials: VendorMaterialForMatching[],
  env: Env,
): Promise<VendorMatchResult[]> {
  const fallback = (item: ExtractedItem): VendorMatchResult => ({
    item_id: item.id,
    matched_vendor_material_id: null,
    match_confidence: 0,
    is_new_material_candidate: item.unit_price !== null && item.unit_price > 0,
  });

  if (extractedItems.length === 0) return [];

  // No catalog entries yet → everything with a unit_price is a new-entry candidate.
  if (materials.length === 0) {
    return extractedItems.map(fallback);
  }

  const prompt = `You are helping match receipt line items to a vendor/material catalog for a residential contractor.

Receipt vendor: ${vendorName ?? "unknown"}

Catalog entries (vendor_materials):
${JSON.stringify(materials.map((m) => ({ id: m.id, vendor_name: m.vendor_name, material_name: m.material_name, category: m.category, unit: m.unit })), null, 2)}

Receipt items to match:
${JSON.stringify(extractedItems.map((i) => ({ id: i.id, description: i.description, amount: i.amount, unit_price: i.unit_price })), null, 2)}

For each receipt item, find the best matching catalog entry (same material, same or similar vendor).
Return ONLY a JSON array, one object per receipt item in the same order as input:
[
  {
    "item_id": "<receipt item id>",
    "matched_vendor_material_id": "<catalog id or null if no good match>",
    "confidence": 0.0 to 1.0
  }
]

Confidence guidelines:
- 0.85+: clear match (same material name, same vendor)
- 0.65–0.84: likely same material but vendor differs slightly
- below 0.65: no reliable match — set matched_vendor_material_id to null

Return only raw JSON, no markdown.`;

  const call = await claudeMessages(env, {
    model: RECEIPT_MATCH_MODEL,
    system: "Return only valid JSON arrays. No markdown fences or prose.",
    maxTokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  if (!call.ok) {
    console.warn(`[receipt-matching] vendor match call failed: ${call.error}`);
    return extractedItems.map(fallback);
  }

  const parsed = parseJsonArray(call.text);
  if (!parsed) {
    console.warn("[receipt-matching] unparseable vendor match response");
    return extractedItems.map(fallback);
  }

  const materialById = new Set(materials.map((m) => m.id));
  const results: VendorMatchResult[] = [];

  for (let i = 0; i < extractedItems.length; i++) {
    const item = extractedItems[i];
    const raw = parsed[i];
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const confidence = clampConfidence(row.confidence);
    const matchedId =
      typeof row.matched_vendor_material_id === "string" && materialById.has(row.matched_vendor_material_id)
        ? row.matched_vendor_material_id
        : null;
    const effectiveId = confidence >= 0.65 ? matchedId : null;
    results.push({
      item_id: item.id,
      matched_vendor_material_id: effectiveId,
      match_confidence: effectiveId ? confidence : 0,
      is_new_material_candidate: !effectiveId && item.unit_price !== null && item.unit_price > 0,
    });
  }

  return results;
}

/** Update vendor_materials price history on catalog update confirm. */
export async function applyVendorMaterialPriceUpdate(
  db: D1Database,
  materialId: string,
  newPrice: number,
  purchaseDate: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT price_history FROM vendor_materials WHERE id = ?")
    .bind(materialId)
    .first<{ price_history: string | null }>();
  if (!row) return;

  let history: Array<{ price: number; date: string }> = [];
  if (row.price_history) {
    try {
      const parsed = JSON.parse(row.price_history) as unknown;
      if (Array.isArray(parsed)) {
        history = parsed as Array<{ price: number; date: string }>;
      }
    } catch {
      history = [];
    }
  }

  history.push({ price: newPrice, date: purchaseDate });
  if (history.length > PRICE_HISTORY_CAP) {
    history = history.slice(history.length - PRICE_HISTORY_CAP);
  }

  const avgPrice = history.reduce((sum, e) => sum + e.price, 0) / history.length;

  await db
    .prepare(
      `UPDATE vendor_materials
       SET last_price = ?, last_purchased_date = ?, average_price = ?, price_history = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(newPrice, purchaseDate, Math.round(avgPrice * 100) / 100, JSON.stringify(history), materialId)
    .run();
}

async function maybeNotifyUnresolvedMatches(
  env: Env,
  receiptPhotoId: string,
  jobId: string,
  extractedItems: ExtractedItem[],
  matchResults: MatchResult[],
): Promise<void> {
  if (extractedItems.length === 0) return;
  const needsReview = matchResults.some(
    (r) => r.status === "ambiguous" || r.status === "unmatched",
  );
  if (!needsReview) return;

  await triggerNotification(env, "receipt_match_review", {
    jobId,
    instanceKey: receiptPhotoId,
    linkPath: jobId ? `/app/jobs/${jobId}` : null,
    merge: {
      receipt_photo_id: receiptPhotoId,
      unresolved_count: String(
        matchResults.filter((r) => r.status === "ambiguous" || r.status === "unmatched").length,
      ),
    },
  }).catch((e) =>
    console.warn("[receipt-matching] notification trigger failed:", (e as Error).message),
  );
}

/** Full extraction + matching pipeline for a receipt photo row. */
export async function processReceiptMatching(
  receiptPhotoId: string,
  photoR2Key: string,
  jobId: string | null,
  db: D1Database,
  env: Env,
): Promise<void> {
  try {
    // Get vendor name from the receipt_photos AI extraction for Match B.
    const rpRow = await db
      .prepare("SELECT ai_vendor FROM receipt_photos WHERE id = ?")
      .bind(receiptPhotoId)
      .first<{ ai_vendor: string | null }>();
    const vendorName = rpRow?.ai_vendor ?? null;

    // Match A: use estimate_sub_items (not parent line items) so that
    // expenses.estimate_line_item_id → estimate_sub_items.id for Report 5.
    let estimateSubItems: LineItemForMatching[] = [];
    if (jobId) {
      const { results: subRows } = await db
        .prepare(
          `SELECT esi.id, esi.description
           FROM estimate_sub_items esi
           JOIN estimate_line_items eli ON eli.id = esi.parent_line_item_id
           JOIN estimates e ON e.id = eli.estimate_id
           WHERE e.job_id = ?
           ORDER BY eli.sort_order, esi.sort_order`,
        )
        .bind(jobId)
        .all<{ id: string; description: string }>();
      estimateSubItems = subRows ?? [];
    }

    // Match B: all vendor_materials (catalog is small, full scan is fine).
    const { results: materialRows } = await db
      .prepare(
        `SELECT id, vendor_name, material_name, category, unit, last_price
         FROM vendor_materials
         ORDER BY vendor_name, material_name`,
      )
      .all<VendorMaterialForMatching>();
    const vendorMaterials = materialRows ?? [];

    const extractedItems = await extractReceiptLineItems(photoR2Key, env);
    const matchResults = await matchItemsToEstimate(extractedItems, estimateSubItems, env);
    const vendorMatchResults = await matchItemsToVendorMaterials(
      extractedItems,
      vendorName,
      vendorMaterials,
      env,
    );

    // Build a lookup for vendor match results by item_id.
    const vendorMatchById = new Map(vendorMatchResults.map((r) => [r.item_id, r]));

    // Persist expense_line_items rows (delete any stale rows from a reprocess first).
    await db
      .prepare("DELETE FROM expense_line_items WHERE receipt_photo_id = ? AND expense_id IS NULL")
      .bind(receiptPhotoId)
      .run();

    for (const item of extractedItems) {
      const matchA = matchResults.find((r) => r.item_id === item.id);
      const matchB = vendorMatchById.get(item.id);
      const subItemId =
        matchA?.status === "matched" ? matchA.suggested_line_item_id : null;
      await db
        .prepare(
          `INSERT INTO expense_line_items
             (id, receipt_photo_id, description, quantity, unit, unit_price, amount,
              matched_estimate_sub_item_id, matched_vendor_material_id, match_confidence, expense_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
        )
        .bind(
          crypto.randomUUID(),
          receiptPhotoId,
          item.description,
          item.quantity,
          null, // unit not extracted from receipt image currently
          item.unit_price,
          item.amount,
          subItemId,
          matchB?.matched_vendor_material_id ?? null,
          matchA ? matchA.confidence : null,
        )
        .run();
    }

    // Fallback: if no individual items extracted, insert a single row for the
    // whole receipt so the confirm flow always has at least one expense_line_items row.
    if (extractedItems.length === 0) {
      const rpFull = await db
        .prepare("SELECT ai_vendor, ai_amount, ai_date, ai_category FROM receipt_photos WHERE id = ?")
        .bind(receiptPhotoId)
        .first<{ ai_vendor: string | null; ai_amount: number | null; ai_date: string | null; ai_category: string | null }>();
      if (rpFull?.ai_amount && rpFull.ai_amount > 0) {
        await db
          .prepare(
            `INSERT INTO expense_line_items
               (id, receipt_photo_id, description, quantity, unit, unit_price, amount,
                matched_estimate_sub_item_id, matched_vendor_material_id, match_confidence, expense_id, created_at)
             VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, datetime('now'))`,
          )
          .bind(
            crypto.randomUUID(),
            receiptPhotoId,
            rpFull.ai_vendor ? `Receipt — ${rpFull.ai_vendor}` : "Receipt",
            rpFull.ai_amount,
          )
          .run();
      }
    }

    await db
      .prepare(
        `UPDATE receipt_photos
         SET extracted_items = ?,
             match_results = ?,
             processing_status = CASE WHEN processing_status = 'confirmed' THEN 'confirmed' ELSE 'processed' END
         WHERE id = ?`,
      )
      .bind(JSON.stringify(extractedItems), JSON.stringify(matchResults), receiptPhotoId)
      .run();

    if (jobId) {
      await maybeNotifyUnresolvedMatches(env, receiptPhotoId, jobId, extractedItems, matchResults);
    }
  } catch (e) {
    console.error("[receipt-matching] processReceiptMatching failed:", (e as Error).message);
    try {
      await db
        .prepare(
          `UPDATE receipt_photos
           SET extracted_items = '[]', match_results = '[]',
               processing_status = CASE WHEN processing_status = 'confirmed' THEN 'confirmed' ELSE 'processed' END
           WHERE id = ?`,
        )
        .bind(receiptPhotoId)
        .run();
    } catch {
      // best-effort degradation
    }
  }
}

export function parseStoredExtractedItems(raw: string | null): ExtractedItem[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ExtractedItem[]) : [];
  } catch {
    return [];
  }
}

export function parseStoredMatchResults(raw: string | null): MatchResult[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MatchResult[]) : [];
  } catch {
    return [];
  }
}

export function hasUnresolvedMatches(
  extractedItems: ExtractedItem[],
  matchResults: MatchResult[],
): boolean {
  if (extractedItems.length === 0) return false;
  return matchResults.some(
    (r) =>
      (r.status === "ambiguous" && r.confirmed_line_item_id == null) ||
      (r.status === "unmatched" && extractedItems.length > 0),
  );
}
