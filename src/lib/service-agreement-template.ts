/**
 * Ensures the service-agreement DOCX template has payment-schedule merge tags and
 * correctly placed client signature fields. Idempotent — safe on already-patched templates.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

const RUN_20 =
  '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
  '<w:t xml:space="preserve">{{TAG}}</w:t></w:r>';

const PAYMENT_ROWS: { anchor: string; amountTag: string; dueTag: string }[] = [
  { anchor: "Deposit (due before work begins)", amountTag: "payment_1_amount", dueTag: "payment_1_due" },
  { anchor: "Progress Payment", amountTag: "payment_2_amount", dueTag: "payment_2_due" },
  { anchor: "Final Payment (due upon completion)", amountTag: "payment_3_amount", dueTag: "payment_3_due" },
];

const PBDR = '<w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr>';

const EMPTY_SIG_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve"></w:t>';

const CONTRACTOR_NAME = "Tony Columbus";
const CONTRACTOR_NAME_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  `<w:t xml:space="preserve">${CONTRACTOR_NAME}</w:t>`;

// White-on-white: BoldSign leaves tag text in the finished PDF (does not strip it).
const SIG_TAG_RUN =
  '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="FFFFFF"/></w:rPr>' +
  '<w:t xml:space="preserve">{{sign|1|*| |client_sig}}</w:t>';

const DATE_TAG_RUN =
  '<w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="FFFFFF"/></w:rPr>' +
  '<w:t xml:space="preserve">{{date|1|*| |client_date}}</w:t>';

const CLIENT_NAME_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{client_name}}</w:t>';

/**
 * pBdr indices within the SIGNATURES table (matches prep-templates layout):
 *   0 = Contractor signature line (image)
 *   1 = Client signature line      → BoldSign sign tag
 *   2 = Contractor printed name      → Tony Columbus (static from prep)
 *   3 = Client printed name          → {{client_name}}
 *   4 = Client date line             → BoldSign date tag
 */
const SIGNATURE_PBDR_TAG_MAP: Record<number, string> = {
  1: SIG_TAG_RUN,
  3: CLIENT_NAME_RUN,
  4: DATE_TAG_RUN,
};

function patchPaymentRow(xml: string, anchor: string, amountTag: string, dueTag: string): string {
  const anchorIdx = xml.indexOf(anchor);
  if (anchorIdx === -1) return xml;
  if (xml.includes(`{{${amountTag}}}`)) return xml;

  const amountRun = RUN_20.replace("{{TAG}}", "{{" + amountTag + "}}");
  const dueRun = RUN_20.replace("{{TAG}}", "{{" + dueTag + "}}");
  const amountPara = `<w:p><w:pPr><w:spacing w:after="60" w:before="60"/></w:pPr>${amountRun}</w:p>`;
  const duePara = `<w:p><w:pPr><w:spacing w:after="60" w:before="60"/></w:pPr>${dueRun}</w:p>`;

  let tail = xml.slice(anchorIdx);
  let searchFrom = 0;
  for (let n = 0; n < 2; n++) {
    const tcOpen = tail.indexOf("<w:tc>", searchFrom);
    if (tcOpen === -1) break;
    const tcClose = tail.indexOf("</w:tc>", tcOpen);
    if (tcClose === -1) break;
    const cell = tail.slice(tcOpen, tcClose + "</w:tc>".length);
    const patched = cell.replace(/<w:p>[\s\S]*?<\/w:p>(?=\s*<\/w:tc>)/, n === 0 ? amountPara : duePara);
    tail = tail.slice(0, tcOpen) + patched + tail.slice(tcClose + "</w:tc>".length);
    searchFrom = tcOpen + patched.length;
  }
  return xml.slice(0, anchorIdx) + tail;
}

function injectTagsAtPbdrOccurrences(table: string, tagMap: Record<number, string>): string {
  let result = table;
  let searchPos = 0;
  let occurrenceIndex = 0;

  while (true) {
    const pBdrIdx = result.indexOf(PBDR, searchPos);
    if (pBdrIdx === -1) break;

    const replacement = tagMap[occurrenceIndex];
    if (replacement !== undefined) {
      const runIdx = result.indexOf(EMPTY_SIG_RUN, pBdrIdx);
      if (runIdx !== -1 && runIdx < pBdrIdx + 400) {
        result =
          result.slice(0, runIdx) + replacement + result.slice(runIdx + EMPTY_SIG_RUN.length);
      }
    }

    searchPos = pBdrIdx + 1;
    occurrenceIndex++;
  }

  return result;
}

/** Undo misplaced tags from the old row-splicing patch — restore contractor printed name. */
function repairMisplacedSignatureTags(table: string): string {
  let result = table;
  let searchPos = 0;
  let occurrenceIndex = 0;

  while (true) {
    const pBdrIdx = result.indexOf(PBDR, searchPos);
    if (pBdrIdx === -1) break;

    if (occurrenceIndex === 2) {
      const slice = result.slice(pBdrIdx, pBdrIdx + 600);
      if (slice.includes("client_sig") && !slice.includes(CONTRACTOR_NAME)) {
        const runIdx = result.indexOf(EMPTY_SIG_RUN, pBdrIdx);
        const tagIdx = result.indexOf("{{sign|1|*| |client_sig}}", pBdrIdx);
        const replaceIdx = runIdx !== -1 && runIdx < pBdrIdx + 400 ? runIdx : tagIdx;
        if (replaceIdx !== -1 && replaceIdx < pBdrIdx + 600) {
          const endIdx = result.indexOf("</w:r>", replaceIdx);
          if (endIdx !== -1) {
            result =
              result.slice(0, replaceIdx) +
              CONTRACTOR_NAME_RUN +
              result.slice(endIdx + "</w:r>".length);
          }
        }
      }
    }

    searchPos = pBdrIdx + 1;
    occurrenceIndex++;
  }

  return result;
}

function patchSignatureTable(xml: string): string {
  const sigIdx = xml.indexOf("SIGNATURES");
  if (sigIdx === -1) return xml;

  const tail = xml.slice(sigIdx);
  const tblStart = tail.indexOf("<w:tbl>");
  const tblEnd = tail.indexOf("</w:tbl>", tblStart);
  if (tblStart === -1 || tblEnd === -1) return xml;

  let table = tail.slice(tblStart, tblEnd + "</w:tbl>".length);

  // Remove contract_date wrongly placed in the 360dxa spacer column.
  table = table.replace(
    /(<w:tcW w:type="dxa" w:w="360"\/>\s*<w:tcBorders>[\s\S]*?<\/w:tcPr>\s*)<w:p>[\s\S]*?\{\{contract_date\}\}[\s\S]*?<\/w:p>/,
    `$1<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr><w:spacing w:after="60" w:before="60"/></w:pPr><w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve"></w:t></w:r></w:p>`,
  );

  table = repairMisplacedSignatureTags(table);
  table = injectTagsAtPbdrOccurrences(table, SIGNATURE_PBDR_TAG_MAP);

  return xml.slice(0, sigIdx) + tail.slice(0, tblStart) + table + tail.slice(tblEnd + "</w:tbl>".length);
}

/** Patch service-agreement template bytes before merge if tags are missing. */
export function ensureServiceAgreementTemplate(docxBytes: ArrayBuffer): ArrayBuffer {
  const zip = unzipSync(new Uint8Array(docxBytes));
  let xml = strFromU8(zip["word/document.xml"]);

  if (!xml.includes("payment_1_amount")) {
    for (const row of PAYMENT_ROWS) {
      xml = patchPaymentRow(xml, row.anchor, row.amountTag, row.dueTag);
    }
  }
  xml = patchSignatureTable(xml);

  zip["word/document.xml"] = strToU8(xml);
  return zipSync(zip).buffer;
}
