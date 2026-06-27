/**
 * prep-templates.ts — Sprint 19 build-time script.
 *
 * Reads each .docx from src/templates/, inserts {{field}} placeholders into
 * word/document.xml, embeds the contractor signature image, and writes the
 * prepped file to src/templates/prepped/.
 *
 * Run: npx tsx scripts/prep-templates.ts
 */

import * as fs from "fs";
import * as path from "path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

const TEMPLATES_DIR = path.join(process.cwd(), "src/templates");
const OUTPUT_DIR = path.join(process.cwd(), "src/templates/prepped");
const SIG_IMG_PATH = path.join(process.cwd(), "src/assets/contractor-signature.png");

// Relationship ID used for the embedded contractor signature image.
// High number to avoid colliding with existing document relationships.
const SIG_IMG_R_ID = "rId901";

// ─── Paragraph-level replacement helpers ────────────────────────────────────

/**
 * Within the XML of a single <w:p>…</w:p> segment:
 * replace the first occurrence of `searchText` in a <w:t> element with `replacement`.
 */
function replaceInPara(para: string, searchText: string, replacement: string): string {
  const escapedSearch = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(<w:t[^>]*>)(${escapedSearch})(<\\/w:t>)`);
  return para.replace(re, `$1${replacement}$3`);
}

/**
 * Split XML into paragraphs (preserving the <w:p> open tag), apply a
 * transformer to paragraphs matching a label, then reassemble.
 */
function transformParas(
  xml: string,
  label: string,
  transformer: (para: string) => string,
): string {
  const parts = xml.split(/(?=<w:p[ >])/);
  return parts
    .map((part) => {
      if (!part.includes(label)) return part;
      return transformer(part);
    })
    .join("");
}

/** Replace underscores blank in the paragraph that contains `label`. */
function replaceLabelBlank(xml: string, label: string, placeholder: string): string {
  return transformParas(xml, label, (para) => {
    return para.replace(/_{3,}/, placeholder);
  });
}

/** Replace standalone "$" run in the paragraph that contains `label` with "$placeholder". */
function replaceLabelDollar(xml: string, label: string, placeholder: string): string {
  return transformParas(xml, label, (para) => {
    return para.replace(
      /(<w:t[^>]*>)\$(<\/w:t>)/,
      `$1\${{${placeholder}}}$2`,
    );
  });
}

// ─── BoldSign tag stripping ──────────────────────────────────────────────────

/**
 * Remove any BoldSign text tags previously injected into the document XML.
 * Patterns: {{sign|…}}, {{date|…}}, {{fullname|…}}, {{initial|…}}
 */
function stripBoldSignTags(xml: string): string {
  return xml.replace(/\{\{(?:sign|date|fullname|initial)\|[^}]*\}\}/g, "");
}

// ─── Template-specific prep functions ───────────────────────────────────────

function prepServiceAgreement(xml: string): string {
  let out = xml;
  out = replaceLabelBlank(out, "Client Name: ", "{{client_name}}");
  out = replaceLabelBlank(out, "Client Address: ", "{{client_address}}");
  out = replaceLabelBlank(out, "Client Phone: ", "{{client_phone}}");
  out = replaceLabelBlank(out, "Client Email: ", "{{client_email}}");
  out = replaceLabelBlank(out, "Project Address: ", "{{job_address}}");
  out = replaceLabelBlank(out, "Project Description: ", "{{job_name}}");
  out = replaceLabelBlank(out, "Contract Date: ", "{{contract_date}}");
  out = replaceLabelDollar(out, "Total Contract Price: ", "contract_amount");
  out = replaceLabelBlank(out, "Estimated Start Date: ", "{{start_date}}");
  out = replaceLabelBlank(out, "Estimated Completion Date: ", "{{completion_date}}");
  out = transformParas(out, "Deposit (due before work begins)", (para) =>
    para.replace(/(<w:t[^>]*>)\$(<\/w:t>)/, "$1${{deposit_amount}}$2"),
  );
  return out;
}

function prepCostPlusAgreement(xml: string): string {
  let out = xml;
  out = replaceLabelBlank(out, "Client Name: ", "{{client_name}}");
  out = replaceLabelBlank(out, "Client Address: ", "{{client_address}}");
  out = replaceLabelBlank(out, "Client Phone: ", "{{client_phone}}");
  out = replaceLabelBlank(out, "Client Email: ", "{{client_email}}");
  out = replaceLabelBlank(out, "Project Address: ", "{{job_address}}");
  out = replaceLabelBlank(out, "Project Description: ", "{{job_name}}");
  out = replaceLabelBlank(out, "Contract Date: ", "{{contract_date}}");
  out = transformParas(
    out,
    "___% of total direct costs (markup)",
    (para) => para.replace(/_{3,}(?=%\s*of\s*total)/, "{{management_fee_rate}}"),
  );
  out = transformParas(
    out,
    "Management Fee Rate:",
    (para) => para.replace(/_{3,}(?=%\s*of\s*direct)/, "{{management_fee_rate}}"),
  );
  out = replaceLabelDollar(out, "Estimated Project Budget: ", "estimated_budget");
  out = replaceLabelDollar(out, "Deposit Amount: ", "deposit_amount");
  out = replaceLabelBlank(out, "Estimated Start Date: ", "{{start_date}}");
  out = replaceLabelBlank(out, "Estimated Completion Date: ", "{{completion_date}}");
  return out;
}

function prepChangeOrder(xml: string): string {
  let out = xml;
  out = transformParas(out, "Change Order #: ", (para) => para.replace(/_{3,}/, "{{change_order_number}}"));
  out = transformParas(out, "Date: ", (para) => para.replace(/_{3,}/, "{{contract_date}}"));
  out = replaceLabelBlank(out, "Client Name: ", "{{client_name}}");
  out = replaceLabelBlank(out, "Original Contract Date: ", "{{contract_date}}");
  out = replaceLabelBlank(out, "Project Address: ", "{{job_address}}");
  out = replaceLabelDollar(out, "Original Contract Amount: ", "original_contract_amount");
  out = replaceLabelDollar(out, "Net Change This Order: ", "net_change");
  out = out.replace(
    /(<w:t[^>]*>Revised Contract Total: )\$_{3,}(<\/w:t>)/,
    "$1${{revised_total}}$2",
  );
  return out;
}

function prepLienWaiverConditional(xml: string): string {
  let out = xml;

  function injectAfterLabel(src: string, labelText: string, placeholder: string): string {
    const labelIdx = src.indexOf(labelText);
    if (labelIdx === -1) return src;
    const paraEnd = src.indexOf("</w:p>", labelIdx);
    if (paraEnd === -1) return src;
    const nextParaStart = src.indexOf("<w:p", paraEnd + 6);
    if (nextParaStart === -1) return src;
    const nextParaEnd = src.indexOf("</w:p>", nextParaStart);
    if (nextParaEnd === -1) return src;
    const nextPara = src.substring(nextParaStart, nextParaEnd + 6);
    const updated = nextPara.replace(
      /(<w:t[^>]*>)(\s*)(<\/w:t>)/,
      `$1${placeholder}$3`,
    );
    return src.substring(0, nextParaStart) + updated + src.substring(nextParaEnd + 6);
  }

  out = injectAfterLabel(out, "Property Owner / General Contractor:", "{{client_name}}");
  out = injectAfterLabel(out, "Property / Project Address:", "{{job_address}}");
  out = injectAfterLabel(out, "Through Date:", "{{through_date}}");
  out = replaceLabelDollar(out, "Payment Amount This Waiver: ", "payment_amount");
  out = out.replace(
    /check from _{3,} \(Maker of Check\)/,
    "check from {{client_name}} (Maker of Check)",
  );
  out = out.replace(
    /in the sum of \$_{3,},/,
    "in the sum of ${{payment_amount}},",
  );

  return out;
}

function prepWarrantyCertificate(xml: string): string {
  let out = xml;
  out = replaceLabelBlank(out, "Certificate #: ", "{{certificate_number}}");
  out = replaceLabelBlank(out, "Issue Date: ", "{{contract_date}}");
  out = replaceLabelBlank(out, "Client Name: ", "{{client_name}}");
  out = replaceLabelBlank(out, "Client Phone: ", "{{client_phone}}");
  out = replaceLabelBlank(out, "Property Address: ", "{{job_address}}");
  out = replaceLabelBlank(out, "Completion Date: ", "{{completion_date}}");
  out = out.replace(
    /(<w:t[^>]*>Warranty Expires: )_{3,}(<\/w:t>)/,
    "$1{{warranty_expiry}}$2",
  );
  return out;
}

function prepSubLienWaiverUnconditional(xml: string): string {
  let out = xml;
  out = replaceLabelBlank(out, "Property / Job Address: ", "{{job_address}}");
  out = replaceLabelBlank(out, "Company Name: ", "{{sub_company_name}}");
  out = replaceLabelBlank(out, "Trade / Scope: ", "{{sub_trade}}");
  out = replaceLabelBlank(out, "Address: ", "{{sub_address}}");
  out = replaceLabelDollar(out, "Payment Amount: ", "payment_amount");
  out = replaceLabelBlank(out, "Payment Date: ", "{{payment_date}}");
  out = replaceLabelBlank(out, "Waiver Date: ", "{{contract_date}}");
  out = out.replace(
    /(<w:t[^>]*>Through Date \(work \/ materials covered through\): )_{3,}(<\/w:t>)/,
    "$1{{payment_date}}$2",
  );
  return out;
}

// ─── Contractor signature image embedding ────────────────────────────────────

/** Read PNG IHDR width/height (big-endian). Returns null if not a PNG. */
function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const width =
    (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height =
    (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * Reject wordmarks/logos masquerading as signature scans.
 * The CHS text logo is 500×150 (aspect 3.33); handwritten scans are typically ≤3:1.
 */
function isHandwrittenSignaturePng(bytes: Uint8Array): boolean {
  const dim = readPngDimensions(bytes);
  if (!dim) return false;
  const aspect = dim.width / dim.height;
  // Wide wordmarks (dense logo text) are usually >3.5:1; signature scans can be ~3.3:1.
  if (aspect > 3.5) return false;
  // Full square logos (e.g. 600×600 badge) — not a signature.
  if (aspect >= 0.85 && aspect <= 1.15 && dim.width >= 200) return false;
  return dim.height >= 30 && dim.height <= 400;
}

/**
 * Build an OOXML <w:drawing> inline image element referencing the contractor
 * signature PNG via relationship ID `rId`.
 *
 * Dimensions: 150pt wide × 40pt tall (1pt = 9525 EMU).
 * Namespaces are declared inline so the element is self-contained regardless
 * of which root-level namespace declarations the template already has.
 */
function buildSigDrawingXml(rId: string, cx = 1428750, cy = 381000): string {
  return (
    `<w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="901" name="contractor-sig"/>` +
    `<wp:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
    `</wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr>` +
    `<pic:cNvPr id="901" name="contractor-sig"/>` +
    `<pic:cNvPicPr/>` +
    `</pic:nvPicPr>` +
    `<pic:blipFill>` +
    `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
    `<a:stretch><a:fillRect/></a:stretch>` +
    `</pic:blipFill>` +
    `<pic:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `</pic:spPr>` +
    `</pic:pic>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:inline>` +
    `</w:drawing>`
  );
}

/**
 * Add the contractor signature PNG to the DOCX zip and register its
 * relationship in word/_rels/document.xml.rels.
 */
function addSigImageToZip(
  unzipped: Record<string, Uint8Array>,
  imgBytes: Uint8Array,
  rId: string,
): void {
  unzipped["word/media/contractor-sig.png"] = imgBytes;

  const relsKey = "word/_rels/document.xml.rels";
  if (unzipped[relsKey]) {
    let relsXml = strFromU8(unzipped[relsKey]);
    const newRel =
      `<Relationship Id="${rId}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
      `Target="media/contractor-sig.png"/>`;
    relsXml = relsXml.replace("</Relationships>", `${newRel}</Relationships>`);
    unzipped[relsKey] = strToU8(relsXml);
  }
}

// ─── Signature field injection into pBdr cells ───────────────────────────────

const BASE_PBDR =
  '<w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr>';

// The empty run inside each signature/date line cell in the SIGNATURES table.
const EMPTY_SIG_RUN =
  '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve"></w:t>';

// Contractor printed name is baked at prep time. Contractor date line removed from source
// templates — client date is handled by BoldSign on the template.
const CONTRACTOR_NAME = "Tony Columbus";

function buildVisibleNameRun(): string {
  return (
    '<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
    `<w:t xml:space="preserve">${CONTRACTOR_NAME}</w:t>`
  );
}

/** Bake contractor name only. */
function bakeStaticContractorName(xml: string): string {
  return xml.replace(/\{\{contractor_name\}\}/g, CONTRACTOR_NAME);
}

/**
 * Inject content into specific pBdr cells (0-indexed) WITHIN the SIGNATURES block.
 * tagMap = { pBdrOccurrenceIndex: replacementRunXml }
 *
 * Anchors to the "SIGNATURES" heading so indices are relative to the signature
 * table only:
 *   0 = Contractor signature line  → image drawing (or text fallback)
 *   1 = Client signature line      → (not injected — BoldSign template handles it)
 *   2 = Contractor printed name    → Tony Columbus (static)
 *   3 = Client printed name        → (not injected)
 *   4 = Client date underline      → (not injected — BoldSign template handles it)
 *   5 = Client Date label          → (not injected)
 */
function injectSignatureFields(xml: string, tagMap: Record<number, string>): string {
  const sigHeadingIdx = xml.indexOf("SIGNATURES");
  const startPos = sigHeadingIdx !== -1 ? sigHeadingIdx : 0;

  let result = xml;
  let searchPos = startPos;
  let occurrenceIndex = 0;

  while (true) {
    const pBdrIdx = result.indexOf(BASE_PBDR, searchPos);
    if (pBdrIdx === -1) break;

    const replacement = tagMap[occurrenceIndex];
    if (replacement !== undefined) {
      const runIdx = result.indexOf(EMPTY_SIG_RUN, pBdrIdx);
      if (runIdx !== -1 && runIdx < pBdrIdx + 400) {
        result =
          result.slice(0, runIdx) +
          replacement +
          result.slice(runIdx + EMPTY_SIG_RUN.length);
      }
    }

    searchPos = pBdrIdx + 1;
    occurrenceIndex++;
  }

  return result;
}

// ─── Template definitions ────────────────────────────────────────────────────

const TEMPLATES: {
  src: string;
  dest: string;
  prep: (xml: string) => string;
  /** True for two-party docs: inject contractor name + date text alongside image. */
  twoPartySig: boolean;
}[] = [
  { src: "CHS-Service-Agreement-Template.docx",          dest: "service-agreement.docx",          prep: prepServiceAgreement,          twoPartySig: true  },
  { src: "CHS-Cost-Plus-Agreement-Template.docx",        dest: "cost-plus-agreement.docx",        prep: prepCostPlusAgreement,        twoPartySig: true  },
  { src: "CHS-Change-Order-Template.docx",               dest: "change-order.docx",               prep: prepChangeOrder,               twoPartySig: true  },
  { src: "CHS-Lien-Waiver-Conditional-Template.docx",    dest: "lien-waiver-conditional.docx",    prep: prepLienWaiverConditional,    twoPartySig: false },
  { src: "CHS-Lien-Waiver-Sub-Unconditional-Template.docx", dest: "lien-waiver-sub-unconditional.docx", prep: prepSubLienWaiverUnconditional, twoPartySig: false },
  { src: "CHS-Warranty-Certificate-Template.docx",       dest: "warranty-certificate.docx",       prep: prepWarrantyCertificate,       twoPartySig: false },
  { src: "CHS-Working-Agreement-Template.docx",         dest: "working-agreement.docx",          prep: (xml) => xml,                      twoPartySig: false },
];

// ─── Diagnostics ─────────────────────────────────────────────────────────────

function countPlaceholders(xml: string): string[] {
  const matches = xml.match(/\{\{[a-z_]+\}\}/g) ?? [];
  return [...new Set(matches)];
}

function findUnreplacedBlanks(xml: string): string[] {
  const blanks: string[] = [];
  const underscores = xml.match(/_{5,}/g);
  if (underscores) blanks.push(...underscores.slice(0, 3).map((b) => `underscores: ${b.substring(0, 10)}…`));
  return blanks;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load contractor signature image once
  let sigImgBytes: Uint8Array | null = null;
  let sigDrawingXml: string | null = null;
  if (fs.existsSync(SIG_IMG_PATH)) {
    const candidate = new Uint8Array(fs.readFileSync(SIG_IMG_PATH));
    if (isHandwrittenSignaturePng(candidate)) {
      sigImgBytes = candidate;
      sigDrawingXml = buildSigDrawingXml(SIG_IMG_R_ID);
      const dim = readPngDimensions(candidate)!;
      console.log(
        `✓ Loaded contractor-signature.png (${dim.width}×${dim.height}, ${candidate.length} bytes)`,
      );
    } else {
      const dim = readPngDimensions(candidate);
      console.warn(
        `⚠ ${SIG_IMG_PATH} looks like a logo/wordmark (${dim ? `${dim.width}×${dim.height}` : "not PNG"}) — ` +
          `skipping image embed. Replace with a handwritten signature scan (wide PNG, ~150×50pt) and re-run.`,
      );
    }
  } else {
    console.warn(`⚠ ${SIG_IMG_PATH} not found — contractor signature line left blank`);
  }

  for (const t of TEMPLATES) {
    const srcPath = path.join(TEMPLATES_DIR, t.src);
    if (!fs.existsSync(srcPath)) {
      console.error(`✗ Source not found: ${t.src}`);
      continue;
    }

    const data = fs.readFileSync(srcPath);
    const unzipped = unzipSync(new Uint8Array(data)) as Record<string, Uint8Array>;
    let xml = strFromU8(unzipped["word/document.xml"]);

    // Strip any leftover BoldSign text tags before re-processing
    xml = stripBoldSignTags(xml);

    // Apply merge-field placeholders
    xml = t.prep(xml);

    // Build injection map:
    //   0 → contractor handwritten signature image (blank if no valid scan)
    //   2 → contractor printed name (two-party templates only)
    //   Client sig/date fields are omitted — BoldSign template controls placement.
    const tagMap: Record<number, string> = {};
    if (sigDrawingXml) {
      tagMap[0] = sigDrawingXml;
    }
    if (t.twoPartySig) {
      tagMap[2] = buildVisibleNameRun();
    }

    xml = injectSignatureFields(xml, tagMap);
    xml = bakeStaticContractorName(xml);

    // Embed contractor signature image in the zip
    if (sigImgBytes) {
      addSigImageToZip(unzipped, sigImgBytes, SIG_IMG_R_ID);
    }

    const placeholders = countPlaceholders(xml);
    const unreplaced = findUnreplacedBlanks(xml);

    unzipped["word/document.xml"] = strToU8(xml);
    const out = zipSync(unzipped);
    const outPath = path.join(OUTPUT_DIR, t.dest);
    fs.writeFileSync(outPath, out);

    console.log(`✓ ${t.dest}`);
    console.log(`  Placeholders: ${placeholders.join(", ") || "(none)"}`);
    if (unreplaced.length > 0) {
      console.log(`  ⚠ Unreplaced blanks: ${unreplaced.join(", ")}`);
    }
  }

  console.log("\nDone. Prepped files written to src/templates/prepped/");
}

main();
