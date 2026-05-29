/**
 * Pull approved-quote PDFs → `job_files.doc_type = 'contracts'` and
 * invoice / payment-receipt PDFs → `pay_stub`, mirroring to Drive like other hub files.
 *
 * Blocked on a **downloadable URL** in Jobber GraphQL: `previewUrl` was removed from
 * Quote and Invoice (Nov 2023). Inspect `Quote`, `Invoice`, and `PaymentRecord` in
 * GraphiQL for pdf/download/document-style fields, then implement fetch + R2 + INSERT
 * (reuse patterns from `job-files-ingest.ts`; idempotency via `jobber_attachment_id`
 * e.g. `jobber:quote:<id>:pdf`, `jobber:invoice:<id>:pdf`).
 */

export async function ingestJobberFinancialPdfsForJob(): Promise<void> {
  return;
}
