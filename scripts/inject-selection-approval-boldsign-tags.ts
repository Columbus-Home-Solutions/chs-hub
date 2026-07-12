/**
 * Injects BoldSign text tags into CHS-Selection-Choice-Approval-Template.docx
 * at the CLIENT signature/date lines (mirrors subcontractor agreement pattern).
 *
 * Run: npx tsx scripts/inject-selection-approval-boldsign-tags.ts
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src/templates/CHS-Selection-Choice-Approval-Template.docx");
const OUT = path.join(ROOT, "src/templates/CHS-Selection-Choice-Approval-Template-tagged.docx");
const R2_COPY = path.join(ROOT, "src/templates/prepped/selection-choice-approval.docx");

const EMPTY_RUN = '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
const SIG_TAG_RUN =
  '<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{sign|1|*|           |client_sig}}</w:t></w:r>';
const DATE_TAG_RUN =
  '<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  '<w:t xml:space="preserve">{{date|1|*|      |client_date}}</w:t></w:r>';

function injectClientSignatureTags(xml: string): { xml: string; changed: number } {
  const clientIdx = xml.indexOf("CLIENT:");
  if (clientIdx === -1) throw new Error("CLIENT: anchor not found in document.xml");

  let tail = xml.slice(clientIdx);
  let changed = 0;

  const sigLabel = "Signature (or Digital Signature)";
  const sigLabelIdx = tail.indexOf(sigLabel);
  if (sigLabelIdx === -1) throw new Error("Signature label not found after CLIENT:");

  const sigEmptyIdx = tail.lastIndexOf(EMPTY_RUN, sigLabelIdx);
  if (sigEmptyIdx === -1) throw new Error("Signature empty run not found");

  tail = tail.slice(0, sigEmptyIdx) + SIG_TAG_RUN + tail.slice(sigEmptyIdx + EMPTY_RUN.length);
  changed++;

  const dateLabelIdx = tail.indexOf("Date", sigLabelIdx - clientIdx + 1);
  const dateEmptyIdx = tail.lastIndexOf(EMPTY_RUN, dateLabelIdx);
  if (dateEmptyIdx === -1) throw new Error("Date empty run not found");

  tail = tail.slice(0, dateEmptyIdx) + DATE_TAG_RUN + tail.slice(dateEmptyIdx + EMPTY_RUN.length);
  changed++;

  return { xml: xml.slice(0, clientIdx) + tail, changed };
}

function main() {
  const buf = fs.readFileSync(SRC);
  const zip = unzipSync(new Uint8Array(buf.buffer));
  let docXml = strFromU8(zip["word/document.xml"]);

  if (docXml.includes("{{sign|1|")) {
    console.log("BoldSign tags already present — copying source to outputs.");
  } else {
    const { xml, changed } = injectClientSignatureTags(docXml);
    docXml = xml;
    console.log(`Injected ${changed} BoldSign text tags.`);
  }

  zip["word/document.xml"] = strToU8(docXml);
  const out = zipSync(zip);
  fs.writeFileSync(OUT, out);
  fs.mkdirSync(path.dirname(R2_COPY), { recursive: true });
  fs.writeFileSync(R2_COPY, out);
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${R2_COPY}`);
}

main();
