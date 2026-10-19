/**
 * Replace only the due-date and late-fee sentences in the agreement files.
 *
 * Wording is copied from src/lib/contracts.ts (the quote page). The signed
 * Service and Cost-Plus .docx files are a shorter form than the quote page,
 * so this script does not rebuild them. It swaps those sentences inside the
 * existing Word XML and leaves merge fields, BoldSign tags, and formatting.
 *
 * Live R2 text is not read here. These replacements start from the repo files.
 *
 * Run: npx tsx scripts/generate-agreement-late-fee-wording.ts
 */

import * as fs from "fs";
import * as path from "path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const SERVICE_DUE_AND_LATE =
  "All invoices are due within seven (7) days of the date the invoice is sent to Client. " +
  "If an invoice is not paid in full within seven (7) days after its due date, Contractor may, at its discretion, add a one-time late fee of five percent (5%) of the unpaid balance. " +
  "Contractor may waive or delay this fee at its sole discretion. " +
  "Contractor reserves the right to suspend work if payment is more than fourteen (14) days past due. " +
  "Work will resume once all outstanding balances and any late fee are paid in full.";

const COST_PLUS_DUE_AND_LATE =
  "The cycle is invoiced and due within twenty-four (24) hours. " +
  "No late fee applies to Cost-Plus invoices. " +
  "If an invoice is not paid by its due date, work will pause and will not continue until the invoice is paid in full.";

const COST_PLUS_CARVE_OUT =
  "The Late Payment Fee in the Service Agreement does not apply to this Cost-Plus Billing Agreement.";

const WORKING_DUE_AND_LATE =
  "All invoices are due within seven (7) days of the date the invoice is sent. " +
  "If an invoice is not paid within seven (7) days after its due date, Columbus Home Solutions may, at its discretion, add a one-time late fee of five percent (5%) of the unpaid balance, and may waive or delay it.";

const DOCX_REPLACEMENTS: { file: string; from: string; to: string }[] = [
  {
    file: "src/templates/CHS-Service-Agreement-Template.docx",
    from: "Late payments are subject to a 1.5% monthly late fee after 30 days past due.",
    to: SERVICE_DUE_AND_LATE,
  },
  {
    file: "src/templates/prepped/service-agreement.docx",
    from: "Late payments are subject to a 1.5% monthly late fee after 30 days past due.",
    to: SERVICE_DUE_AND_LATE,
  },
  {
    file: "src/templates/CHS-Cost-Plus-Agreement-Template.docx",
    from: "Payment is due within 7 days of invoice date.",
    to: COST_PLUS_DUE_AND_LATE,
  },
  {
    file: "src/templates/prepped/cost-plus-agreement.docx",
    from: "Payment is due within 7 days of invoice date.",
    to: COST_PLUS_DUE_AND_LATE,
  },
  {
    file: "src/templates/CHS-Cost-Plus-Agreement-Template.docx",
    from: " Late payments are subject to 1.5% monthly late fee after 7 days past due.",
    to: ` ${COST_PLUS_CARVE_OUT}`,
  },
  {
    file: "src/templates/prepped/cost-plus-agreement.docx",
    from: " Late payments are subject to 1.5% monthly late fee after 7 days past due.",
    to: ` ${COST_PLUS_CARVE_OUT}`,
  },
  {
    file: "src/templates/prepped/working-agreement.docx",
    from: "All invoices are due within seven (7) days of receipt. A late fee of $50.00 per day applies to invoices not paid within seven (7) days.",
    to: WORKING_DUE_AND_LATE,
  },
];

const TEXT_REPLACEMENTS: { file: string; from: string; to: string }[] = [
  {
    file: "public/docs/CHS-Service-Agreement-Template.docx",
    from: "All invoices are due within seven (7) days of receipt.",
    to: "All invoices are due within seven (7) days of the date the invoice is sent to Client.",
  },
  {
    file: "public/docs/CHS-Service-Agreement-Template.docx",
    from:
      "A late fee of $50.00 per day will be added to any invoice not paid within seven (7) days of receipt. Contractor reserves the right to suspend work if payment is more than fourteen (14) days past due. Work will resume once all outstanding balances and accrued late fees are paid in full.",
    to: SERVICE_DUE_AND_LATE.slice(SERVICE_DUE_AND_LATE.indexOf("If an invoice")),
  },
  {
    file: "public/docs/CHS-Cost-Plus-Agreement-Template.docx",
    from: "Payment is due within twenty-four (24) hours of receipt.",
    to: COST_PLUS_DUE_AND_LATE,
  },
  {
    file: "public/docs/CHS-Cost-Plus-Agreement-Template.docx",
    from:
      "This Cost-Plus Billing Agreement is supplemental to the Service Agreement and is governed by its terms for warranty, insurance, termination, dispute resolution, and all other provisions not specifically addressed here.",
    to:
      "This Cost-Plus Billing Agreement is supplemental to the Service Agreement and is governed by its terms for warranty, insurance, termination, dispute resolution, and all other provisions not specifically addressed here. " +
      COST_PLUS_CARVE_OUT,
  },
];

function replaceOnce(text: string, from: string, to: string, label: string): string {
  if (text.includes(to) && !text.includes(from)) return text;
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected the old sentence once, found ${count}`);
  }
  return text.replace(from, to);
}

function patchDocx(rel: string, from: string, to: string): void {
  const full = path.join(process.cwd(), rel);
  const unzipped = unzipSync(new Uint8Array(fs.readFileSync(full)));
  const key = "word/document.xml";
  const xml = strFromU8(unzipped[key]);
  const next = replaceOnce(xml, from, to, rel);
  if (next === xml) {
    console.log(`unchanged ${rel}`);
    return;
  }
  unzipped[key] = strToU8(next);
  fs.writeFileSync(full, zipSync(unzipped));
  console.log(`updated ${rel}`);
}

function patchText(rel: string, from: string, to: string): void {
  const full = path.join(process.cwd(), rel);
  const text = fs.readFileSync(full, "utf8");
  const next = replaceOnce(text, from, to, rel);
  if (next === text) {
    console.log(`unchanged ${rel}`);
    return;
  }
  fs.writeFileSync(full, next);
  console.log(`updated ${rel}`);
}

for (const item of DOCX_REPLACEMENTS) patchDocx(item.file, item.from, item.to);
for (const item of TEXT_REPLACEMENTS) patchText(item.file, item.from, item.to);
