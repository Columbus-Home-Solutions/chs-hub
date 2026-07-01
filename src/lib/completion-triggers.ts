/**
 * completion-triggers.ts — Sprint 32: final-invoice-paid → client lien waiver auto-send.
 *
 * checkAndFireLienWaiver() is invoked non-blocking after invoice payments settle.
 * All heavy work runs inside ctx.waitUntil().
 */

import type { Env } from "../env.js";
import { getBoldSignConfig, sendDocumentForSignature } from "./boldsign.js";
import { triggerNotification } from "./notification-engine.js";
import { round2 } from "./invoicing.js";

const DEFAULT_CLIENT_LIEN_WAIVER_TEMPLATE_ID = "7d6692c2-21e9-4ae9-ba2a-7f45c1f33eba";

function resolveClientLienWaiverTemplateId(env: Env): string {
  const fromEnv = (env.BOLDSIGN_LIEN_WAIVER_CLIENT_TEMPLATE_ID ?? "").trim();
  return fromEnv || DEFAULT_CLIENT_LIEN_WAIVER_TEMPLATE_ID;
}

export async function checkAndFireLienWaiver({
  jobId,
  invoiceId,
  env,
  ctx,
}: {
  jobId: string;
  invoiceId: string;
  env: Env;
  ctx: ExecutionContext;
}): Promise<void> {
  ctx.waitUntil(
    (async () => {
      let waiverId: string | null = null;
      try {
        const job = await env.DB.prepare(
          `SELECT id, status, contract_total, client_id FROM jobs WHERE id = ?`,
        )
          .bind(jobId)
          .first<{ id: string; status: string; contract_total: number; client_id: string }>();

        if (!job || job.status !== "complete") return;

        const unpaid = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM invoices
            WHERE job_id = ? AND status NOT IN ('paid', 'void')`,
        )
          .bind(jobId)
          .first<{ count: number }>();

        if (unpaid && unpaid.count > 0) return;

        const financials = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE job_id = ?`,
        )
          .bind(jobId)
          .first<{ total_paid: number }>();

        const totalPaid = round2(financials?.total_paid ?? 0);
        const contractTotal = round2(job.contract_total ?? 0);
        if (totalPaid < contractTotal - 0.01) return;

        const existing = await env.DB.prepare(
          `SELECT id FROM client_lien_waivers
            WHERE job_id = ? AND status NOT IN ('failed')
            LIMIT 1`,
        )
          .bind(jobId)
          .first<{ id: string }>();

        if (existing) {
          console.log(`[CompletionTrigger] Lien waiver already exists for job ${jobId}`);
          return;
        }

        const client = await env.DB.prepare(
          `SELECT first_name, last_name, email FROM clients WHERE id = ?`,
        )
          .bind(job.client_id)
          .first<{ first_name: string; last_name: string; email: string }>();

        if (!client?.email) {
          console.error(`[CompletionTrigger] No client email for job ${jobId}`);
          return;
        }

        const invoice = await env.DB.prepare(`SELECT amount FROM invoices WHERE id = ?`)
          .bind(invoiceId)
          .first<{ amount: number }>();

        waiverId = crypto.randomUUID();
        const templateId = resolveClientLienWaiverTemplateId(env);

        await env.DB.prepare(
          `INSERT INTO client_lien_waivers
             (id, job_id, waiver_type, payment_amount, invoice_id, boldsign_template_id, status, created_at, updated_at)
           VALUES (?, ?, 'conditional', ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
        )
          .bind(waiverId, jobId, invoice?.amount ?? 0, invoiceId, templateId)
          .run();

        const config = await getBoldSignConfig(env);
        if (!config) {
          throw new Error("BOLDSIGN_API_KEY not configured");
        }

        const signerName = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Client";
        const jobMeta = await env.DB.prepare("SELECT title, job_number FROM jobs WHERE id = ?")
          .bind(jobId)
          .first<{ title: string; job_number: string }>();
        const title = jobMeta
          ? `Conditional Lien Waiver — ${jobMeta.title} (#${jobMeta.job_number})`
          : "Conditional Lien Waiver";

        const boldSignResult = await sendDocumentForSignature(config, {
          fileBlob: new Blob([]),
          filename: "lien-waiver-conditional.docx",
          title,
          message: "Please review and sign this conditional lien waiver at your earliest convenience.",
          signerEmail: client.email,
          signerName,
          signerRole: "Client",
          templateId,
        });

        await env.DB.prepare(
          `UPDATE client_lien_waivers
              SET boldsign_document_id = ?, status = 'sent', sent_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`,
        )
          .bind(boldSignResult.documentId, waiverId)
          .run();

        await triggerNotification(env, "lien_waiver_sent", {
          jobId,
          clientId: job.client_id,
          linkPath: `/app/jobs/${jobId}/completion-package`,
          instanceKey: waiverId,
        });

        console.log(`[CompletionTrigger] Lien waiver sent for job ${jobId}`);
      } catch (err) {
        console.error(`[CompletionTrigger] BoldSign send failed for job ${jobId}:`, err);
        if (waiverId) {
          await env.DB.prepare(
            `UPDATE client_lien_waivers SET status = 'failed', updated_at = datetime('now') WHERE id = ?`,
          )
            .bind(waiverId)
            .run()
            .catch(() => undefined);
        }
      }
    })(),
  );
}
