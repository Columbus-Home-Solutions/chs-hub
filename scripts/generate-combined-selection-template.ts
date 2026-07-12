/**
 * Builds the combined Selection Choice Approval template from the single-selection
 * template by swapping per-item fields for summary merge tags.
 *
 * Run: npx tsx scripts/generate-combined-selection-template.ts
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src/templates/CHS-Selection-Choice-Approval-Template-tagged.docx");
const OUT = path.join(ROOT, "src/templates/CHS-Selection-Combined-Approval-Template-tagged.docx");
const R2_COPY = path.join(ROOT, "src/templates/prepped/selection-combined-approval.docx");

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\{\{selection_title\}\}/g, "{{selections_heading}}"],
  [/\{\{selection_category\}\}/g, ""],
  [/\{\{selection_location\}\}/g, ""],
  [/\{\{allowance_amount\}\}/g, ""],
  [/\{\{choice_title\}\}/g, "{{selections_summary}}"],
  [/\{\{choice_vendor\}\}/g, ""],
  [/\{\{choice_description\}\}/g, ""],
  [/\{\{choice_price\}\}/g, ""],
  [/\{\{overage_amount\}\}/g, "{{total_overage_amount}}"],
];

function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`Source template not found: ${SRC}. Run inject-selection-approval-boldsign-tags.ts first.`);
  }
  const buf = fs.readFileSync(SRC);
  const zip = unzipSync(new Uint8Array(buf.buffer));
  let docXml = strFromU8(zip["word/document.xml"]);

  for (const [pattern, replacement] of REPLACEMENTS) {
    docXml = docXml.replace(pattern, replacement);
  }

  zip["word/document.xml"] = strToU8(docXml);
  const out = zipSync(zip);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  fs.writeFileSync(R2_COPY, out);
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${R2_COPY}`);
}

main();
