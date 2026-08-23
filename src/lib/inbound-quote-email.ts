/**
 * Inbound email → pending_quote_imports (never writes estimate_sub_items).
 * Stores every attachment in R2 + metadata; extracts from image/* and application/pdf.
 */

import PostalMime from "postal-mime";
import type { Env } from "../env.js";
import { extractSupplierQuote } from "./quote-import.js";

export const QUOTE_INTAKE_ADDRESS = "lowes-import@quotes.homesolutionsar.com";

export interface QuoteAttachmentMeta {
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string | null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Best-effort trim of quoted reply / signature noise — keep it light. */
export function trimEmailNoise(text: string): string {
  let t = text.trim();
  const cuts = [
    /\nOn .{10,120} wrote:\s*\n/i,
    /\n-{2,}\s*\nSent from my /i,
    /\nGet Outlook for /i,
    /\n_{5,}\n/,
    /\nFrom:\s+.+\nSent:\s+/i,
  ];
  for (const re of cuts) {
    const m = t.search(re);
    if (m > 80) t = t.slice(0, m).trim();
  }
  return t.slice(0, 80_000);
}

function attachmentBytes(content: unknown): Uint8Array | null {
  if (!content) return null;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  return null;
}

function safeFilename(name: string | undefined | null, mime: string, index: number): string {
  const raw = (name || "").trim() || `attachment-${index + 1}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9._\-]+/g, "_").slice(0, 120);
  if (cleaned.includes(".")) return cleaned;
  if (mime === "application/pdf") return `${cleaned}.pdf`;
  if (mime.startsWith("image/")) {
    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "bin";
    return `${cleaned}.${ext}`;
  }
  return cleaned;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function ingestQuoteEmailRaw(
  env: Env,
  opts: {
    from: string | null;
    subject: string | null;
    receivedAt: string;
    raw: ArrayBuffer;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  let rawText = "";
  let extractionJson: string | null = null;
  let extractionError: string | null = null;
  const attachmentMetas: QuoteAttachmentMeta[] = [];

  let imageBase64: string | null = null;
  let imageMediaType: string | null = null;
  let pdfBase64: string | null = null;

  try {
    const parsed = await PostalMime.parse(opts.raw);
    const plain = (parsed.text ?? "").trim();
    const html = (parsed.html ?? "").trim();
    rawText = trimEmailNoise(plain || (html ? htmlToText(html) : ""));

    const attachments = parsed.attachments ?? [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const mimeRaw = String(att.mimeType || "application/octet-stream").toLowerCase();
      const filename = safeFilename(att.filename, mimeRaw, i);
      const mime =
        mimeRaw === "application/pdf" || /\.pdf$/i.test(filename)
          ? "application/pdf"
          : mimeRaw;
      const bytes = attachmentBytes(att.content);
      const size = bytes?.byteLength ?? 0;
      let r2Key: string | null = null;

      if (bytes && size > 0 && size < 12_000_000) {
        r2Key = `quote-imports/${id}/${filename}`;
        try {
          await env.FILES.put(r2Key, bytes, {
            httpMetadata: { contentType: mime },
          });
        } catch {
          r2Key = null;
        }
      }

      attachmentMetas.push({
        filename,
        mime_type: mime,
        size_bytes: size,
        r2_key: r2Key,
      });

      // First usable PDF / image wins for extraction (prefer PDF when both exist).
      if (mime === "application/pdf" && bytes && size > 0 && size < 12_000_000 && !pdfBase64) {
        pdfBase64 = uint8ToBase64(bytes);
      } else if (mime.startsWith("image/") && bytes && size > 0 && size < 4_500_000 && !imageBase64) {
        imageBase64 = uint8ToBase64(bytes);
        imageMediaType = mime;
      }
    }

    if (!rawText && !imageBase64 && !pdfBase64) {
      extractionError = "empty_body";
    } else {
      const result = await extractSupplierQuote(env, {
        text: rawText || null,
        imageBase64,
        mediaType: imageMediaType,
        pdfBase64,
      });
      if (result.ok) {
        extractionJson = JSON.stringify({
          vendor_guess: result.vendor_guess,
          lines: result.lines,
          quote_total: result.quote_total,
        });
      } else {
        extractionError = result.error ?? "extraction_failed";
        extractionJson = JSON.stringify({
          vendor_guess: null,
          lines: [],
          quote_total: null,
        });
      }
    }
  } catch (e) {
    extractionError = `parse_failed: ${(e as Error).message?.slice(0, 200) ?? String(e)}`;
    rawText = rawText || "";
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO pending_quote_imports (
       id, source, from_address, subject, received_at, raw_text,
       extraction_json, extraction_error, attachments, status, created_at
     ) VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      id,
      opts.from,
      opts.subject,
      opts.receivedAt,
      rawText || null,
      extractionJson,
      extractionError,
      attachmentMetas.length ? JSON.stringify(attachmentMetas) : null,
      now,
    )
    .run();

  return id;
}

/** Cloudflare Email Worker entry — never rejects; always records a pending row. */
export async function handleInboundQuoteEmail(
  message: {
    from: string;
    to: string;
    headers: Headers;
    raw: ReadableStream | ArrayBuffer;
    setReject?: (reason: string) => void;
  },
  env: Env,
): Promise<void> {
  const rawBuf =
    message.raw instanceof ArrayBuffer
      ? message.raw
      : await new Response(message.raw).arrayBuffer();

  const subject = message.headers.get("subject");
  const dateHdr = message.headers.get("date");
  const receivedAt = dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();
  const receivedAtSafe = Number.isNaN(Date.parse(receivedAt))
    ? new Date().toISOString()
    : receivedAt;

  await ingestQuoteEmailRaw(env, {
    from: message.from || null,
    subject: subject || null,
    receivedAt: receivedAtSafe,
    raw: rawBuf,
  });
}
