/**
 * Branded punch list document generation (Sprint 33).
 *
 * No PDF npm dependency — builds a minimal text PDF in-process (PDF 1.4 subset)
 * suitable for email attachment and R2 storage at
 * punch-lists/{punch_list_id}/{sub_id}.pdf.
 */

import type { Env } from "../env.js";
import { formatToday } from "./document-generator.js";

export interface PunchListPdfItem {
  description: string;
  scheduled_date: string | null;
}

export interface PunchListPdfInput {
  punch_list_id: string;
  sub_id: string;
  job_title: string;
  job_address: string;
  sub_company_name: string;
  scheduled_date: string | null;
  items: PunchListPdfItem[];
}

const PUNCH_LIST_ORIGIN = "https://dashboard.homesolutionsar.com";

/** Escape text for PDF string literals. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Wrap long lines for PDF text output (~72 chars). */
function wrapLines(text: string, maxLen = 72): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxLen && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Build a minimal single-page text PDF. */
export function buildPunchListPdf(input: PunchListPdfInput): Uint8Array {
  const today = formatToday();
  const sched =
    input.scheduled_date?.trim() ||
    input.items.find((i) => i.scheduled_date)?.scheduled_date?.trim() ||
    "To be scheduled";

  const bodyLines: string[] = [
    "COLUMBUS HOME SOLUTIONS LLC",
    input.job_address,
    "",
    `PUNCH LIST — ${input.job_title}`,
    `Prepared for: ${input.sub_company_name}`,
    `Date: ${today}`,
    `Scheduled Completion: ${sched}`,
    "",
    "─────────────────────────────────────────────",
    "ITEMS ASSIGNED TO YOU",
    "─────────────────────────────────────────────",
    "",
  ];

  input.items.forEach((item, idx) => {
    const itemSched = item.scheduled_date?.trim() || input.scheduled_date?.trim() || sched;
    bodyLines.push(`${idx + 1}. ${item.description}`);
    bodyLines.push(`   Scheduled: ${itemSched}`);
    bodyLines.push("   [ ] Complete");
    bodyLines.push("");
  });

  bodyLines.push(
    "─────────────────────────────────────────────",
    "Questions? Contact Tony Columbus",
    "(501) 551-1814 | tony@homesolutionsar.com",
    "─────────────────────────────────────────────",
  );

  const flatLines = bodyLines.flatMap((l) => (l === "" ? [""] : wrapLines(l)));

  const fontSize = 11;
  const lineHeight = 14;
  const startY = 750;
  let y = startY;
  const textOps: string[] = ["BT", `/F1 ${fontSize} Tf`];
  for (const line of flatLines) {
    if (y < 50) break;
    textOps.push(`1 0 0 1 50 ${y} Tm (${pdfEscape(line)}) Tj`);
    y -= lineHeight;
  }
  textOps.push("ET");
  const streamContent = textOps.join("\n");
  const streamLen = new TextEncoder().encode(streamContent).length;

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

export function punchListPdfR2Key(punchListId: string, subId: string): string {
  return `punch-lists/${punchListId}/${subId}.pdf`;
}

export async function storePunchListPdf(
  env: Env,
  punchListId: string,
  subId: string,
  bytes: Uint8Array,
): Promise<string> {
  const key = punchListPdfR2Key(punchListId, subId);
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
  return key;
}

export function punchListSecureLink(token: string): string {
  return `${PUNCH_LIST_ORIGIN}/punch/${token}`;
}

/** HTML variant for print preview (optional fallback). */
export function buildPunchListHtml(input: PunchListPdfInput): string {
  const today = formatToday();
  const sched =
    input.scheduled_date?.trim() ||
    input.items.find((i) => i.scheduled_date)?.scheduled_date?.trim() ||
    "To be scheduled";

  const itemsHtml = input.items
    .map((item, idx) => {
      const itemSched = item.scheduled_date?.trim() || input.scheduled_date?.trim() || sched;
      return `<li><strong>${idx + 1}. ${escapeHtml(item.description)}</strong><br>
        Scheduled: ${escapeHtml(itemSched)}<br>
        ☐ Complete</li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Punch List — ${escapeHtml(input.job_title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 700px; margin: 2rem auto; color: #222; }
  h1 { font-size: 1.1rem; letter-spacing: 0.05em; }
  hr { border: none; border-top: 1px solid #999; margin: 1.5rem 0; }
  li { margin-bottom: 1rem; }
  .footer { font-size: 0.9rem; color: #555; }
</style></head><body>
<h1>COLUMBUS HOME SOLUTIONS LLC</h1>
<p>${escapeHtml(input.job_address)}</p>
<h2>PUNCH LIST — ${escapeHtml(input.job_title)}</h2>
<p>Prepared for: ${escapeHtml(input.sub_company_name)}<br>
Date: ${escapeHtml(today)}<br>
Scheduled Completion: ${escapeHtml(sched)}</p>
<hr>
<h3>ITEMS ASSIGNED TO YOU</h3>
<ol>${itemsHtml}</ol>
<hr>
<p class="footer">Questions? Contact Tony Columbus<br>
(501) 551-1814 | tony@homesolutionsar.com</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
