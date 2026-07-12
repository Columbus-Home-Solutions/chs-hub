/**
 * One-off repair: finalize approved selection approval documents that were
 * marked approved before webhook storage set is_signed / uploaded the PDF.
 *
 * Usage (requires BOLDSIGN_API_KEY in env — same secret as production worker):
 *   BOLDSIGN_API_KEY=… node scripts/backfill-selection-approval-docs.mjs [docId…]
 *
 * With no args, repairs all selection_approval rows linked to an approved choice.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const API_KEY = process.env.BOLDSIGN_API_KEY?.trim();
if (!API_KEY) {
  console.error("Set BOLDSIGN_API_KEY");
  process.exit(1);
}

const docIds = process.argv.slice(2);

function d1Query(sql) {
  const out = execSync(
    `npx wrangler d1 execute chs-hub-db --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

async function downloadBoldSignPdf(documentId) {
  const res = await fetch(
    `https://api.boldsign.com/v1/document/download?documentId=${encodeURIComponent(documentId)}`,
    { headers: { "X-API-KEY": API_KEY } },
  );
  if (!res.ok) {
    throw new Error(`BoldSign download ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function r2KeyFor(docId, sig) {
  if (sig.combined && sig.estimate_id) {
    return `selection-approvals/combined/${sig.estimate_id}/${docId}.pdf`;
  }
  return `selection-approvals/${sig.selection_id}/${sig.choice_id}/${docId}.pdf`;
}

async function repairDoc(row) {
  const sig = JSON.parse(row.signature_data);
  const boldSignId = sig.boldsign_document_id;
  if (!boldSignId) {
    console.warn(`skip ${row.id}: no boldsign_document_id`);
    return;
  }
  const r2Key = r2KeyFor(row.id, sig);
  console.log(`repair ${row.id} (${row.title}) → ${r2Key}`);
  const pdf = await downloadBoldSignPdf(boldSignId);
  const tmp = `/tmp/sel-backfill-${row.id}.pdf`;
  writeFileSync(tmp, pdf);
  execSync(
    `npx wrangler r2 object put chs-hub-files/${r2Key} --remote --file ${tmp} --content-type application/pdf`,
    { stdio: "inherit", cwd: process.cwd() },
  );
  unlinkSync(tmp);
  const signedOn = (row.signed_date || new Date().toISOString()).slice(0, 10);
  const meta = JSON.stringify({
    ...sig,
    signed_r2_key: r2Key,
    signature_completed_at: new Date().toISOString(),
  });
  const sql = `UPDATE documents SET r2_key='${r2Key}', file_type='application/pdf', file_size=${pdf.length}, is_signed=1, signed_date='${signedOn}', job_id=COALESCE(job_id,'${sig.job_id ?? ""}'), estimate_id=COALESCE(estimate_id,'${sig.estimate_id ?? ""}'), signature_data='${meta.replace(/'/g, "''")}', updated_at=datetime('now') WHERE id='${row.id}'`;
  execSync(`npx wrangler d1 execute chs-hub-db --remote --command ${JSON.stringify(sql)}`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  console.log(`done ${row.id}`);
}

const rows = docIds.length
  ? d1Query(
      `SELECT id, title, signature_data, signed_date FROM documents WHERE id IN (${docIds.map((id) => `'${id}'`).join(",")})`,
    )
  : d1Query(`
      SELECT d.id, d.title, d.signature_data, d.signed_date
        FROM documents d
        JOIN selection_choices sc ON sc.client_signature_document_id = d.id
       WHERE d.context_type = 'selection'
         AND d.document_category = 'selection_approval'
         AND COALESCE(d.is_signed, 0) = 0
         AND sc.approved = 1
    `);

if (rows.length === 0) {
  console.log("No documents to repair.");
  process.exit(0);
}

for (const row of rows) {
  await repairDoc(row);
}
