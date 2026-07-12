/**
 * Adds client date BoldSign text tag to service/cost-plus agreement templates.
 * The generic inject-boldsign-tags script maps occurrence 4 to CHS contract_date
 * but misses the client date tag when the signature table has fewer pBdr rows.
 *
 * Run after inject-boldsign-tags.ts:
 *   npx tsx scripts/patch-service-agreement-client-date-tag.ts
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import * as fs from "fs";
import * as path from "path";

const PREPPED_DIR = path.join(import.meta.dirname, "../src/templates/prepped");
const FILES = ["service-agreement.docx", "cost-plus-agreement.docx"];

const DATE_TAG_RUN =
  '<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{date|1|*| |client_date}}</w:t></w:r>';

const CLIENT_DATE_PBDR =
  '<w:pPr><w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr></w:pPr>' +
  DATE_TAG_RUN;

const CHS_DATE_PBDR =
  '<w:pPr><w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr>' +
  '<w:spacing w:after="60" w:before="60"/></w:pPr>' +
  '<w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{contract_date}}</w:t></w:r>';

const EMPTY_PARA =
  '<w:pPr><w:spacing w:after="60" w:before="60"/></w:pPr>' +
  '<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
  '<w:t xml:space="preserve"></w:t></w:r>';

function patchXml(xml: string): string {
  let signIdx = xml.indexOf("{{sign|1|*| |client_sig}}");
  if (signIdx === -1) {
    signIdx = xml.indexOf("{{sign|1|*|sig}}");
    if (signIdx === -1) throw new Error("sign tag not found — run inject-boldsign-tags.ts first");
  }

  if (xml.includes("{{date|1|*| |client_date}}") || xml.includes("{{date|1|*|date}}")) {
    console.log("  client date tag already present");
    return xml;
  }

  const wrongClientDate =
    '<w:pPr><w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr></w:pPr>' +
    '<w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
    '<w:t xml:space="preserve">{{contract_date}}</w:t></w:r>';

  const clientDateIdx = xml.indexOf(wrongClientDate, signIdx);
  if (clientDateIdx === -1) {
    throw new Error("client date pBdr row not found after sign tag");
  }

  let result =
    xml.slice(0, clientDateIdx) + CLIENT_DATE_PBDR + xml.slice(clientDateIdx + wrongClientDate.length);

  const rowStart = result.lastIndexOf("<w:tr>", signIdx, clientDateIdx);
  const rowEnd = result.indexOf("</w:tr>", clientDateIdx);
  if (rowStart === -1 || rowEnd === -1) throw new Error("date row bounds not found");

  const row = result.slice(rowStart, rowEnd);
  if (row.includes("{{contract_date}}")) {
    console.log("  CHS contract_date already in date row");
  } else if (row.includes(EMPTY_PARA)) {
    const patchedRow = row.replace(EMPTY_PARA, CHS_DATE_PBDR);
    result = result.slice(0, rowStart) + patchedRow + result.slice(rowEnd);
    console.log("  added CHS contract_date cell in date row");
  }

  return result;
}

for (const file of FILES) {
  const filePath = path.join(PREPPED_DIR, file);
  const buf = fs.readFileSync(filePath);
  const zip = unzipSync(new Uint8Array(buf.buffer));
  let docXml = strFromU8(zip["word/document.xml"]);
  console.log(`\n${file}:`);
  docXml = patchXml(docXml);
  zip["word/document.xml"] = strToU8(docXml);
  fs.writeFileSync(filePath, zipSync(zip));
  console.log(`  saved ${file}`);
}

console.log("\nDone.");
