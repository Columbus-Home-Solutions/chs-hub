/**
 * document-generator.ts — Sprint 19 Worker runtime DOCX merge engine.
 *
 * Uses fflate (zip/unzip only) — the docx npm package is NEVER imported here
 * because it doesn't run in the Cloudflare Workers runtime.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

/**
 * Takes a prepped .docx template (ArrayBuffer from R2) and a map of merge
 * fields, replaces every {{field_name}} in word/document.xml, and returns the
 * resulting .docx as a Uint8Array.
 *
 * Business rule 5: fields that resolve to null/undefined/empty become "".
 * Business rule 3: currency values must be formatted before being passed in.
 * Business rule 4: dates must be formatted before being passed in.
 */
export async function generateDocument(
  templateBuffer: ArrayBuffer,
  mergeFields: Record<string, string>,
): Promise<Uint8Array> {
  const zipData = new Uint8Array(templateBuffer);
  const unzipped = unzipSync(zipData);

  let docXml = strFromU8(unzipped["word/document.xml"]);

  console.log(`[document-generator] merge fields before substitution: ${JSON.stringify(mergeFields)}`);

  for (const [key, value] of Object.entries(mergeFields)) {
    const safe = (value ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    docXml = docXml.replaceAll(`{{${key}}}`, safe);
  }

  // Business rule 5: clear any unreplaced {{token}} placeholders
  docXml = docXml.replace(/\{\{[a-z_]+\}\}/g, "");

  unzipped["word/document.xml"] = strToU8(docXml);
  return zipSync(unzipped);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Format a number as "$X,XXX.XX" (business rule 3). */
export function formatCurrency(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format a date string as "MMMM D, YYYY" (business rule 4). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : value + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(d);
}

/** Today's date formatted as "MMMM D, YYYY". */
export function formatToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date());
}

/** Add one year to a date string, return formatted. */
export function formatDatePlusOneYear(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : value + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setFullYear(d.getFullYear() + 1);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(d);
}

/** Format a number as "15%" (percentage). */
export function formatPercent(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return `${n}%`;
  return `${n}%`;
}
