/**
 * Receipt AI extraction (Sprint 8).
 *
 * Given receipt image bytes, ask Claude (vision) to pull vendor / amount /
 * date / a suggested expense category + a confidence score, returned as strict
 * JSON. The result is always a *suggestion*: the receipt_photos row stores it,
 * but an expense is only created when the user confirms (business rule #3).
 *
 * Never throws for "AI unavailable" — returns { ok:false } so the caller marks
 * processing_status='failed' and the photo still persists for manual entry.
 */

import type { Env } from "../env.js";
import { claudeMessages, extractJson } from "./claude.js";

/** Categories the financial module recognises for an expense suggestion. */
export const RECEIPT_CATEGORIES = [
  "materials",
  "labor",
  "subcontractor",
  "equipment_rental",
  "permits",
  "fuel",
  "tools",
  "disposal",
  "other",
] as const;

export interface ReceiptExtraction {
  ok: boolean;
  vendor: string | null;
  amount: number | null;
  date: string | null; // YYYY-MM-DD
  category: string | null;
  confidence: number | null; // 0..1
  error: string | null;
}

const SYSTEM = [
  "You are an expense-entry assistant for Columbus Home Solutions, a residential general contractor.",
  "You are given a photo of a purchase receipt. Extract the fields below and return ONLY a JSON object, no prose, no markdown fences:",
  "{",
  '  "vendor": "store/merchant name or null",',
  '  "amount": <grand total as a number, no currency symbol, or null>,',
  '  "date": "YYYY-MM-DD or null",',
  `  "category": "one of: ${RECEIPT_CATEGORIES.join(" | ")}",`,
  '  "confidence": <0..1 how confident you are overall>',
  "}",
  "Use the receipt GRAND TOTAL for amount (after tax). If a field is illegible, use null. Pick the single best category for a construction job.",
].join("\n");

function clampConfidence(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeCategory(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toLowerCase().replace(/\s+/g, "_");
  return (RECEIPT_CATEGORIES as readonly string[]).includes(c) ? c : "other";
}

function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * @param imageBytes raw receipt image
 * @param mediaType  e.g. "image/jpeg" | "image/png"
 */
export async function extractReceipt(
  env: Env,
  imageBytes: ArrayBuffer,
  mediaType: string,
): Promise<ReceiptExtraction> {
  const empty: ReceiptExtraction = {
    ok: false,
    vendor: null,
    amount: null,
    date: null,
    category: null,
    confidence: null,
    error: null,
  };

  const base64 = arrayBufferToBase64(imageBytes);
  const media = /png|jpe?g|webp|gif/i.test(mediaType) ? mediaType : "image/jpeg";

  const call = await claudeMessages(env, {
    system: SYSTEM,
    maxTokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data: base64 } },
          { type: "text", text: "Extract the receipt fields as the JSON object specified." },
        ],
      },
    ],
  });

  if (!call.ok) return { ...empty, error: call.error };

  const parsed = extractJson<{
    vendor?: unknown;
    amount?: unknown;
    date?: unknown;
    category?: unknown;
    confidence?: unknown;
  }>(call.text);
  if (!parsed) return { ...empty, error: "receipt_json_parse_failed" };

  const amountNum = Number(parsed.amount);
  return {
    ok: true,
    vendor: typeof parsed.vendor === "string" ? parsed.vendor.trim() || null : null,
    amount: Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null,
    date: normalizeDate(parsed.date),
    category: normalizeCategory(parsed.category),
    confidence: clampConfidence(parsed.confidence),
    error: null,
  };
}

/** Base64-encode an ArrayBuffer in chunks (avoids call-stack overflow on big images). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
