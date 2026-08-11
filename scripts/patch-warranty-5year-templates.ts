/**
 * Patch live warranty-certificate.docx + service-agreement.docx on R2:
 * - Warranty cert: fuller 5-year exclusions + liability wording (preserve merge
 *   tags + embedded contractor signature PNG).
 * - Service agreement WARRANTY section: 1 year → 5 years with cert cross-ref.
 *
 * Usage: npx tsx scripts/patch-warranty-5year-templates.ts
 * Reads /tmp/live-warranty.docx and /tmp/live-sa.docx (download first), writes
 * patched files to /tmp/patched-*.docx for upload.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

function patchXml(docxPath: string, outPath: string, patchFn: (xml: string) => string): void {
  const bytes = new Uint8Array(readFileSync(docxPath));
  const zip = unzipSync(bytes);
  const key = "word/document.xml";
  if (!zip[key]) throw new Error(`missing ${key} in ${docxPath}`);
  const before = strFromU8(zip[key]);
  const after = patchFn(before);
  if (after === before) {
    console.warn(`[patch] no changes applied to ${docxPath}`);
  } else {
    console.log(`[patch] applied changes → ${outPath} (Δ ${after.length - before.length} chars)`);
  }
  zip[key] = strToU8(after);
  writeFileSync(outPath, Buffer.from(zipSync(zip, { level: 6 })));
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function para(text: string, opts?: { bold?: boolean; size?: number; before?: number; after?: number }): string {
  const size = opts?.size ?? 20;
  const before = opts?.before ?? 60;
  const after = opts?.after ?? 60;
  const bold = opts?.bold ? "<w:b/><w:bCs/>" : "";
  return (
    `<w:p><w:pPr><w:spacing w:after="${after}" w:before="${before}"/></w:pPr>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>` +
    `${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
    `<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`
  );
}

function patchWarranty(xml: string): string {
  // Replace "What Is Covered" body through end of "Limitation of Liability" body,
  // keeping CERTIFICATION / signature block intact.
  const startMarker = "What Is Covered";
  const endMarker = "Transferability";
  const startIdx = xml.indexOf(startMarker);
  const endIdx = xml.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error("warranty markers not found (What Is Covered / Transferability)");
  }

  // Walk back to the containing <w:p> of "What Is Covered" heading
  const pStart = xml.lastIndexOf("<w:p", startIdx);
  // Walk back to the containing <w:p> of "Transferability" — keep that heading
  const pEnd = xml.lastIndexOf("<w:p", endIdx);
  if (pStart < 0 || pEnd < 0 || pEnd <= pStart) {
    throw new Error("could not locate paragraph boundaries for warranty body rewrite");
  }

  const covered =
    'Columbus Home Solutions, LLC certifies that the workmanship performed on this project is warrantied for the period stated below, subject to the conditions in this certificate. Columbus Home Solutions, LLC agrees to remedy defective workmanship without charge within the warranty period, measured from the date of project completion.';
  const period =
    "Warranty Period: Five (5) years from the date of project completion (see Warranty Expires date above).";
  const notCovered =
    "This warranty covers defects in workmanship only. It does not cover, and Columbus Home Solutions, LLC is not responsible for, defects or damage attributable to: normal wear and tear or normal weathering; damage caused by the Client, occupants, or third parties; damage resulting from improper maintenance or misuse (neglected routine maintenance is not warrantied); accidents, fire, lightning, flood, earthquake, windstorms, windborne objects, ice, hail, or other Acts of God; vandalism, riot, civil disorder, or harmful fumes, vapors, chemical pollutants, or air pollution; mildew, fungus, or salt from the atmosphere or any other source; building settlement or structural failure of the roof, walls, foundation, or any other part of the structure, unless directly caused by Contractor's defective workmanship; any other cause beyond Columbus Home Solutions, LLC's control; pre-existing conditions not included in the original scope of work; issues arising from modifications made by others after project completion; and defects in materials themselves (as distinct from their installation) — material defects are covered by the applicable manufacturer's warranty, not this warranty, and all manufacturer material warranties take precedence over this workmanship warranty.";
  const claimIntro = "To make a warranty claim during the Warranty Period, Client must:";
  const claim1 =
    "Submit a written description of the defect by email to tony@homesolutionsar.com or by mail to 4414 N Olive St, North Little Rock, AR 72116";
  const claim2 =
    "Describe the nature of the defect, when it was first noticed, and provide photographs if available";
  const claim3 =
    "Allow Contractor reasonable access to the property to inspect and repair the defect";
  const claimClose =
    "Contractor will acknowledge warranty claims within 5 business days and schedule repairs within a reasonable timeframe. Contractor's obligation under this warranty is limited to repair or replacement of defective workmanship at Contractor's sole discretion.";
  const liability =
    "Columbus Home Solutions, LLC shall not be liable for injury to persons or for damage to the building or its contents, nor for any incidental, special, or consequential damages, arising from any breach of this warranty, whether written or implied. THIS WARRANTY IS THE SOLE AND EXCLUSIVE WARRANTY PROVIDED BY CONTRACTOR. CONTRACTOR MAKES NO OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTY OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.";

  const replacement =
    para("What Is Covered", { bold: true, size: 22, before: 180, after: 80 }) +
    para(covered) +
    para(period, { bold: true, before: 120, after: 80 }) +
    para("What Is Not Covered", { bold: true, size: 22, before: 180, after: 80 }) +
    para(notCovered) +
    para("How to Make a Warranty Claim", { bold: true, size: 22, before: 180, after: 80 }) +
    para(claimIntro) +
    para("• " + claim1) +
    para("• " + claim2) +
    para("• " + claim3) +
    para(claimClose, { before: 120 }) +
    para("Limitation of Liability", { bold: true, size: 22, before: 180, after: 80 }) +
    para(liability);

  return xml.slice(0, pStart) + replacement + xml.slice(pEnd);
}

function patchServiceAgreement(xml: string): string {
  const old =
    "Contractor warrants all workmanship for a period of one (1) year from the date of substantial completion. This warranty covers defects in workmanship only and does not cover damage caused by Client, normal wear and tear, acts of God, or improper maintenance. Manufacturer warranties apply separately to materials and products. Warranty claims must be submitted in writing within the warranty period.";
  const next =
    "Contractor warrants all workmanship for a period of five (5) years from the date of substantial completion. This warranty covers defects in workmanship only; the full list of exclusions and the limitation of liability are set forth in the Warranty Certificate issued at project completion. Manufacturer warranties apply separately to materials and products. Warranty claims must be submitted in writing within the warranty period.";

  if (!xml.includes(old) && !xml.includes(escXml(old))) {
    // Try escaped form (apos already in XML as &apos; etc.)
    const oldEsc = escXml(old);
    if (xml.includes(oldEsc)) {
      return xml.replace(oldEsc, escXml(next));
    }
    // Fallback: just swap the term phrase if full paragraph not found
    if (xml.includes("one (1) year from the date of substantial completion")) {
      return xml
        .replace(
          "one (1) year from the date of substantial completion",
          "five (5) years from the date of substantial completion",
        )
        .replace(
          "This warranty covers defects in workmanship only and does not cover damage caused by Client, normal wear and tear, acts of God, or improper maintenance.",
          "This warranty covers defects in workmanship only; the full list of exclusions and the limitation of liability are set forth in the Warranty Certificate issued at project completion.",
        );
    }
    throw new Error("SA warranty paragraph not found");
  }
  return xml.replace(old, next).replace(escXml(old), escXml(next));
}

patchXml("/tmp/live-warranty.docx", "/tmp/patched-warranty-certificate.docx", patchWarranty);
patchXml("/tmp/live-sa.docx", "/tmp/patched-service-agreement.docx", patchServiceAgreement);

// Sanity checks
const wXml = strFromU8(unzipSync(new Uint8Array(readFileSync("/tmp/patched-warranty-certificate.docx")))["word/document.xml"]);
const sXml = strFromU8(unzipSync(new Uint8Array(readFileSync("/tmp/patched-service-agreement.docx")))["word/document.xml"]);
for (const tag of [
  "{{warranty_expiry}}",
  "{{contractor_signature}}",
  "{{contractor_date}}",
  "{{client_name}}",
  "Five (5) years",
  "Limitation of Liability",
]) {
  if (!wXml.includes(tag)) throw new Error(`warranty missing expected: ${tag}`);
}
if (!wXml.includes("contractor-sig") && !wXml.includes("contractor_signature")) {
  // drawing relationship may reference media without the filename in document.xml
  console.log("[check] contractor_signature merge tag present");
}
if (!sXml.includes("five (5) years from the date of substantial completion")) {
  throw new Error("SA missing five-year warranty term");
}
console.log("[ok] patched templates ready for R2 upload");
