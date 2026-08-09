/**
 * Scope draft AI generation (Sprint 28).
 *
 * Reads site visit notes + active catalog items, asks Claude for structured
 * estimate line-item suggestions, and normalises the result for storage in
 * estimate_requests.scope_draft (JSON array).
 */

import type { Env } from "../env.js";
import { claudeMessages, type ClaudeBlock, type ClaudeMessage } from "./claude.js";

export const SCOPE_DRAFT_MODEL = "claude-sonnet-4-6";

export type ScopeDraftStatus = "pending" | "accepted" | "discarded";

export interface ScopeDraftItem {
  id: string;
  product_service: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number | null;
  catalog_match_id: string | null;
  catalog_match_name: string | null;
  status: ScopeDraftStatus;
  generated_at: string;
}

export interface CatalogMatchInput {
  id: string;
  name: string;
  unit: string | null;
  unit_price: number;
}

export interface SketchImageBlock {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
}

const SYSTEM_PROMPT = `You are a construction estimating assistant for a residential remodeling company
in Arkansas. Your job is to read field notes from a site visit and extract a list
of scope items that belong on a construction estimate.

Return ONLY a valid JSON array. No explanation, no markdown, no preamble.
Each item in the array must have exactly these fields:
- product_service: string — short name of the scope item (matches how it would appear on an estimate line item)
- description: string — one to two sentence scope description suitable for a client-facing estimate
- quantity: number — your best estimate based on the notes, or 1 if unknown
- unit: string — "sqft", "lf", "each", "job", "hr", or other appropriate unit
- unit_price: number or null — null unless the notes contain a price or you matched a catalog item
- catalog_match_id: string or null — the catalog item ID if this item closely matches one, otherwise null
- catalog_match_name: string or null — the catalog item name if matched, otherwise null
- status: "pending"

Rules:
- Only extract items that represent actual work scope — not client preferences like "wants white cabinets" unless they define a scope item
- Measurements in the notes should inform quantity where possible
- If notes mention demolition separately from installation, create separate line items
- Do not invent scope items not mentioned or implied in the notes, sketches, or visit photos
- Catalog match only when the name and work type are a clear match — do not force matches
- When sketch images are provided, extract scope items visible in the drawings including any labeled dimensions, room names, or annotations
- When visit photos are provided, infer visible existing conditions and scope (damage, finishes, rooms, measurements if labeled)`;

export function buildClaudeMessages(
  notes: string | null,
  sketchImages: SketchImageBlock[],
  catalogItems: CatalogMatchInput[],
): ClaudeMessage[] {
  const content: ClaudeBlock[] = [];

  for (const img of sketchImages) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.base64,
      },
    });
  }

  const catalogJson = JSON.stringify(
    catalogItems.map((c) => ({
      id: c.id,
      name: c.name,
      unit: c.unit,
      unit_price: c.unit_price,
    })),
  );

  const notesSection = notes
    ? `<notes>\n${notes}\n</notes>`
    : `<notes>No written notes provided. Use the sketch images above to identify scope items.</notes>`;

  const catalogSection =
    catalogItems.length > 0
      ? `\n\nAvailable catalog items for matching:\n<catalog>\n${catalogJson}\n</catalog>`
      : "";

  const intro =
    sketchImages.length > 0
      ? "Review the site visit sketch images and notes below."
      : "Site visit notes:";

  content.push({
    type: "text",
    text: `${intro}\n${notesSection}${catalogSection}\n\nExtract the scope items from these notes and sketches.`.trim(),
  });

  return [{ role: "user", content }];
}

/** Strip markdown fences and parse a JSON array from Claude's reply. */
export function parseScopeDraftArray(text: string): unknown[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Claude response was not a JSON array");
  }
  return parsed;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeItem(
  raw: unknown,
  generatedAt: string,
  catalogById: Map<string, CatalogMatchInput>,
): ScopeDraftItem {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const catalogMatchId = str(row.catalog_match_id) || null;
  const catalogMatch = catalogMatchId ? catalogById.get(catalogMatchId) : undefined;

  let unitPrice = numOrNull(row.unit_price);
  if (catalogMatch && unitPrice == null) {
    unitPrice = catalogMatch.unit_price;
  }

  const quantityRaw = Number(row.quantity);
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;

  return {
    id: crypto.randomUUID(),
    product_service: str(row.product_service) || "Scope item",
    description: str(row.description),
    quantity,
    unit: str(row.unit) || "each",
    unit_price: unitPrice,
    catalog_match_id: catalogMatch ? catalogMatch.id : catalogMatchId,
    catalog_match_name: catalogMatch
      ? catalogMatch.name
      : str(row.catalog_match_name) || null,
    status: "pending",
    generated_at: generatedAt,
  };
}

export async function generateScopeDraft(
  env: Env,
  visitNotes: string | null,
  sketchImages: SketchImageBlock[],
  catalogItems: CatalogMatchInput[],
): Promise<{ ok: true; items: ScopeDraftItem[] } | { ok: false; error: string }> {
  const call = await claudeMessages(env, {
    system: SYSTEM_PROMPT,
    model: SCOPE_DRAFT_MODEL,
    maxTokens: 2000,
    messages: buildClaudeMessages(visitNotes, sketchImages, catalogItems),
  });

  if (!call.ok) {
    return { ok: false, error: call.error ?? "Claude call failed" };
  }

  let parsed: unknown[];
  try {
    parsed = parseScopeDraftArray(call.text!);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to parse scope draft JSON",
    };
  }

  const generatedAt = new Date().toISOString();
  const catalogById = new Map(catalogItems.map((c) => [c.id, c]));
  const items = parsed.map((raw) => normalizeItem(raw, generatedAt, catalogById));

  return { ok: true, items };
}

export function parseStoredScopeDraft(raw: string | null): ScopeDraftItem[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as ScopeDraftItem[];
  } catch {
    return null;
  }
}
