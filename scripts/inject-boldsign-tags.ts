/**
 * inject-boldsign-tags.ts
 *
 * Injects BoldSign text tags into the prepped DOCX templates so signature
 * and date-signed fields land exactly on the client signature lines.
 *
 * Template layout (service-agreement, cost-plus-agreement, change-order):
 *   Row: "Columbus Home Solutions LLC" | spacer | "Client"
 *   Row: [pBdr line — SIGNATURE AREA]  | spacer | [pBdr line — CLIENT SIG ← TAG HERE]
 *   Row: "Signature" label             | spacer | "Signature" label
 *   Row: [pBdr line — printed name]    | spacer | [pBdr line — printed name]
 *   Row: "Printed Name" label          | spacer | "Printed Name" label
 *   Row: [pBdr line — date area]       | spacer | [pBdr line — CLIENT DATE ← TAG HERE]
 *   Row: "Date" label                  | spacer | "Date" label
 *
 * pBdr occurrences after SIGNATURES (3-column table: CHS | spacer | Client):
 *   0=CHS sig (image — skip), 1=client sig, 2=CHS printed name (Tony — skip),
 *   3=client printed name, 4=client date
 *
 * Run: npx tsx scripts/inject-boldsign-tags.ts
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import * as fs from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PREPPED_DIR = path.join(__dirname, "../src/templates/prepped");

const BASE_PBDR =
  '<w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr>';

// The empty run inside each signature/date line cell (includes run properties).
const EMPTY_SIG_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve"></w:t>';

// BoldSign text tag format (pipe-separated): {{type|signerIndex|required|placeholder|fieldId}}
// Placeholder slot must be present (can be empty) — omitting it makes fieldId parse as
// a TextBox placeholder and SendFailed with "Placeholder is only applicable for TextBox".
const SIG_TAG_RUN =
  '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="CCCCCC"/></w:rPr>' +
  '<w:t xml:space="preserve">{{sign|1|*| |client_sig}}</w:t>';
const DATE_TAG_RUN =
  '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="CCCCCC"/></w:rPr>' +
  '<w:t xml:space="preserve">{{date|1|*| |client_date}}</w:t>';

const LEGACY_SIG_TAG = '{{sign|1|*|sig}}';
const LEGACY_DATE_TAG = '{{date|1|*|date}}';
const CANONICAL_SIG_TAG = '{{sign|1|*| |client_sig}}';
const CANONICAL_DATE_TAG = '{{date|1|*| |client_date}}';

const CLIENT_NAME_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{client_name}}</w:t>';

const TWO_PARTY_TAGS: Record<number, string> = {
  1: SIG_TAG_RUN,       // Client signature line (2nd pBdr after SIGNATURES)
  3: CLIENT_NAME_RUN,   // Client printed name (4th pBdr)
  4: DATE_TAG_RUN,      // Client date line (5th pBdr)
};

// Templates to modify and their tag maps
const TEMPLATES: { file: string; tagMap: Record<number, string> }[] = [
  { file: "service-agreement.docx", tagMap: TWO_PARTY_TAGS },
  { file: "cost-plus-agreement.docx", tagMap: TWO_PARTY_TAGS },
  { file: "change-order.docx", tagMap: TWO_PARTY_TAGS },
  // lien-waiver-conditional is signed by CHS only — skip for now
  // warranty-certificate is signed by CHS only — skip for now
];

function injectTags(
  xml: string,
  tagMap: Record<number, string>,
): { xml: string; changed: number } {
  let result = xml;
  let changed = 0;

  // Anchor to SIGNATURES heading — the document has pBdr cells in other tables
  // (e.g. payment schedule) before the signature block; counting from there shifts all indices.
  const sigHeadingIdx = xml.indexOf("SIGNATURES");
  let searchPos = sigHeadingIdx !== -1 ? sigHeadingIdx : 0;
  let occurrenceIndex = 0;

  while (true) {
    const pBdrIdx = result.indexOf(BASE_PBDR, searchPos);
    if (pBdrIdx === -1) break;

    const replacement = tagMap[occurrenceIndex];
    if (replacement !== undefined) {
      // Find the empty run (rPr + w:t) after this pBdr
      const runIdx = result.indexOf(EMPTY_SIG_RUN, pBdrIdx);
      if (runIdx !== -1 && runIdx < pBdrIdx + 400) {
        result =
          result.slice(0, runIdx) +
          replacement +
          result.slice(runIdx + EMPTY_SIG_RUN.length);
        changed++;
        console.log(`  Occurrence ${occurrenceIndex}: injected tag`);
      } else {
        console.warn(
          `  Occurrence ${occurrenceIndex}: could not find empty run within 400 chars`,
        );
      }
    }

    searchPos = pBdrIdx + 1;
    occurrenceIndex++;
  }

  return { xml: result, changed };
}

let totalModified = 0;
for (const { file, tagMap } of TEMPLATES) {
  const filePath = path.join(PREPPED_DIR, file);
  const buf = fs.readFileSync(filePath);
  const zip = unzipSync(new Uint8Array(buf.buffer));

  let docXml = strFromU8(zip["word/document.xml"]);

  // Upgrade legacy 4-part tags (SendFailed: placeholder TextBox error)
  if (docXml.includes(LEGACY_SIG_TAG) || docXml.includes(LEGACY_DATE_TAG)) {
    docXml = docXml
      .replaceAll(LEGACY_SIG_TAG, CANONICAL_SIG_TAG)
      .replaceAll(LEGACY_DATE_TAG, CANONICAL_DATE_TAG);
    zip["word/document.xml"] = strToU8(docXml);
    fs.writeFileSync(filePath, zipSync(zip));
    totalModified++;
    console.log(`UPGRADED ${file} — legacy BoldSign tags fixed to 5-part format`);
    continue;
  }

  // Verify the template doesn't already have the correct tags
  if (docXml.includes("{{sign|1|")) {
    console.log(`SKIP ${file} — BoldSign tags already present`);
    continue;
  }

  const pBdrCount = (docXml.match(new RegExp(BASE_PBDR.replace(/[[\]()]/g, "\\$&"), "g")) || []).length;
  console.log(`\n${file}: found ${pBdrCount} pBdr occurrences`);

  const { xml: modified, changed } = injectTags(docXml, tagMap);

  if (changed > 0) {
    zip["word/document.xml"] = strToU8(modified);
    const out = zipSync(zip);
    fs.writeFileSync(filePath, out);
    totalModified++;
    console.log(`  Saved ${file} (${changed} tags injected)`);
  } else {
    console.log(`  No changes made to ${file}`);
  }
}

console.log(`\nDone — ${totalModified} templates updated.`);
