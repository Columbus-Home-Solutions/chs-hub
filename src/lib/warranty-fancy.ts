/**
 * Companion "fancy" Workmanship Warranty PDF — static Redmond design with
 * completion date stamped on the signature DATE line. Generated alongside the
 * personalized warranty certificate on job_complete.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Env } from "../env.js";
import { formatDate, formatToday } from "./document-generator.js";

export const WARRANTY_FANCY_TEMPLATE_R2 = "documents/templates/warranty-fancy-static.pdf";
export const WARRANTY_FANCY_TEMPLATE_TYPE = "warranty_fancy";

/** PDF bottom-left coordinates — verified visually against the Redmond PDF. */
export const WARRANTY_FANCY_DATE = {
  /** Horizontal line under the date sits at y≈109.2; baseline just above it. */
  baselineY: 112,
  /** Center of the date line (x 445.5–641.2). */
  centerX: 543.4,
  fontSize: 11,
} as const;

export interface FancyWarrantyResult {
  generated: boolean;
  reason?: string;
  docId?: string;
}

/** Overlay a formatted date on the static fancy warranty PDF. */
export async function stampFancyWarrantyDate(
  templateBytes: ArrayBuffer | Uint8Array,
  dateLabel: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(templateBytes);
  const page = pdf.getPages()[0];
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const width = font.widthOfTextAtSize(dateLabel, WARRANTY_FANCY_DATE.fontSize);
  page.drawText(dateLabel, {
    x: WARRANTY_FANCY_DATE.centerX - width / 2,
    y: WARRANTY_FANCY_DATE.baselineY,
    size: WARRANTY_FANCY_DATE.fontSize,
    font,
    color: rgb(0.15, 0.15, 0.16),
  });
  return pdf.save();
}

/**
 * Generate the fancy warranty for a job (deduped). Never throws to callers —
 * returns { generated:false } and logs on failure (mirrors autotrigger posture).
 */
export async function maybeAutoGenerateFancyWarranty(
  env: Env,
  jobId: string,
  triggerEvent = "job_complete",
): Promise<FancyWarrantyResult> {
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM job_documents
        WHERE job_id = ?
          AND template_type = ?
          AND review_status IN ('pending_review', 'approved', 'discarded', 'manual')
        LIMIT 1`,
    )
      .bind(jobId, WARRANTY_FANCY_TEMPLATE_TYPE)
      .first<{ id: string }>();
    if (existing) {
      return { generated: false, reason: "already_exists", docId: existing.id };
    }

    const job = await env.DB.prepare(
      `SELECT id, job_number, actual_end_date, target_end_date FROM jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<{
        id: string;
        job_number: string | null;
        actual_end_date: string | null;
        target_end_date: string | null;
      }>();
    if (!job) return { generated: false, reason: "job_not_found" };

    const templateObj = await env.FILES.get(WARRANTY_FANCY_TEMPLATE_R2);
    if (!templateObj) {
      throw new Error(`template not found in R2: ${WARRANTY_FANCY_TEMPLATE_R2}`);
    }
    const templateBytes = await templateObj.arrayBuffer();
    const completionRaw = job.actual_end_date ?? job.target_end_date ?? null;
    const dateLabel = formatDate(completionRaw) || formatToday();
    const pdfBytes = await stampFancyWarrantyDate(templateBytes, dateLabel);

    const today = new Date().toISOString().slice(0, 10);
    const jobNum = (job.job_number ?? jobId).toString().replace(/\s+/g, "-");
    const filename = `5-year-workmanship-warranty-${jobNum}-${today}.pdf`;
    const generatedKey = `documents/generated/${jobId}/${crypto.randomUUID()}-${filename}`;

    await env.FILES.put(generatedKey, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    const written = await env.FILES.head(generatedKey);
    if (!written || written.size !== pdfBytes.byteLength) {
      throw new Error(
        `r2_put_verify_failed: key=${generatedKey} expected=${pdfBytes.byteLength} got=${written?.size ?? "missing"}`,
      );
    }

    const docId = crypto.randomUUID();
    const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
    await env.DB.prepare(
      `INSERT INTO job_documents
         (id, job_id, template_type, filename, r2_key, generated_at,
          generated_by, review_status, auto_generated, trigger_event, related_record_id,
          signature_status, signature_completed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 'system', 'pending_review', 1, ?, NULL, 'completed', ?)`,
    )
      .bind(docId, jobId, WARRANTY_FANCY_TEMPLATE_TYPE, filename, generatedKey, triggerEvent, nowIso)
      .run();

    console.log(`[AUTOTRIGGER] fancy warranty SUCCESS — docId=${docId} key=${generatedKey}`);
    return { generated: true, docId };
  } catch (err_) {
    const errMsg = err_ instanceof Error ? err_.message : String(err_);
    console.error(`[AUTOTRIGGER] fancy warranty FAILED (${jobId}):`, errMsg);
    await env.DB.prepare(
      `INSERT INTO dead_letter_queue
         (id, operation, payload, error_message, retry_count, max_retries, status, created_at)
       VALUES (?, 'doc_autogen', ?, ?, 0, 3, 'pending', datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        JSON.stringify({ jobId, templateType: WARRANTY_FANCY_TEMPLATE_TYPE, triggerEvent }),
        errMsg,
      )
      .run()
      .catch((dlqErr: unknown) => {
        console.error("[warranty-fancy] DLQ insert also failed:", dlqErr);
      });
    return { generated: false, reason: "error" };
  }
}
