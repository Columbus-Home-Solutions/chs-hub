/**
 * AI extraction of a pasted (or imaged/PDF) supplier quote into material line items.
 * Read-only — never writes to estimate_sub_items. Reuses claudeMessages + extractJson.
 * PDF uses Anthropic native `document` content blocks (no separate PDF parser).
 */

import type { Env } from "../env.js";
import { claudeMessages, extractJson, type ClaudeBlock } from "./claude.js";

export interface QuoteImportLine {
  description: string;
  sku: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
}

export interface QuoteImportExtraction {
  ok: boolean;
  vendor_guess: string | null;
  lines: QuoteImportLine[];
  quote_total: number | null;
  error: string | null;
}

const SYSTEM = [
  "You are a materials takeoff assistant for Columbus Home Solutions, a residential GC.",
  "Extract MATERIAL line items from a supplier quote, cart, order confirmation, or attached PDF (Lowe's, Home Depot, lumber yard, etc.).",
  "Return ONLY a JSON object, no prose, no markdown fences:",
  "{",
  '  "vendor_guess": "store/supplier name or null",',
  '  "lines": [',
  '    { "description": "item name", "sku": "sku or null", "quantity": <number or null>, "unit": "each|lf|sqft|box|bag|etc or null", "unit_cost": <number or null>, "total": <line total or null> }',
  "  ],",
  '  "quote_total": <grand total number or null>',
  "}",
  "If both an email/notification body AND an attached PDF/image are present, prefer the attachment for line items — the body is often just 'your quote is attached' with no SKUs.",
  "Include real merchandise/material lines. Prefer excluding tax, delivery fees, tips, and payment lines — but if unsure, include them and Tony will uncheck.",
  "Do not fabricate SKUs. Numbers must be plain numbers (no $). If a field is unknown, use null.",
].join("\n");

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function normalizeLines(raw: unknown): QuoteImportLine[] {
  if (!Array.isArray(raw)) return [];
  const out: QuoteImportLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const description = strOrNull(o.description);
    if (!description) continue;
    out.push({
      description,
      sku: strOrNull(o.sku),
      quantity: numOrNull(o.quantity),
      unit: strOrNull(o.unit),
      unit_cost: numOrNull(o.unit_cost),
      total: numOrNull(o.total),
    });
  }
  return out;
}

export async function extractSupplierQuote(
  env: Env,
  opts: {
    text?: string | null;
    imageBase64?: string | null;
    mediaType?: string | null;
    /** Base64 PDF bytes (no data: prefix) — Anthropic document block. */
    pdfBase64?: string | null;
  },
): Promise<QuoteImportExtraction> {
  const empty: QuoteImportExtraction = {
    ok: false,
    vendor_guess: null,
    lines: [],
    quote_total: null,
    error: null,
  };

  const text = (opts.text ?? "").trim();
  const imageBase64 = (opts.imageBase64 ?? "").trim();
  const pdfBase64 = (opts.pdfBase64 ?? "").trim();
  if (!text && !imageBase64 && !pdfBase64) {
    return { ...empty, error: "Provide pasted quote text, an image, or a PDF" };
  }

  const content: ClaudeBlock[] = [];
  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }
  if (imageBase64) {
    const media = /png|jpe?g|webp|gif/i.test(opts.mediaType ?? "")
      ? (opts.mediaType as string)
      : "image/jpeg";
    content.push({
      type: "image",
      source: { type: "base64", media_type: media, data: imageBase64 },
    });
  }
  content.push({
    type: "text",
    text: pdfBase64
      ? text
        ? `Extract material lines from the attached PDF quote. Email body (may be a notification shell — prefer the PDF):\n\n${text}`
        : "Extract material lines from the attached supplier quote PDF."
      : text
        ? `Extract material lines from this supplier quote:\n\n${text}`
        : "Extract material lines from this supplier quote image.",
  });

  const call = await claudeMessages(env, {
    system: SYSTEM,
    maxTokens: 8192,
    messages: [{ role: "user", content }],
  });

  if (!call.ok) return { ...empty, error: call.error };

  const parsed = extractJson<{
    vendor_guess?: unknown;
    lines?: unknown;
    quote_total?: unknown;
  }>(call.text);
  if (!parsed) return { ...empty, error: "quote_json_parse_failed" };

  return {
    ok: true,
    vendor_guess: strOrNull(parsed.vendor_guess),
    lines: normalizeLines(parsed.lines),
    quote_total: numOrNull(parsed.quote_total),
    error: null,
  };
}
