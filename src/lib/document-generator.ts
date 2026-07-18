/**
 * document-generator.ts — Sprint 19 Worker runtime DOCX merge engine.
 *
 * Uses fflate (zip/unzip only) — the docx npm package is NEVER imported here
 * because it doesn't run in the Cloudflare Workers runtime.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { getContractorSignaturePng } from "./contractor-signature-bytes.js";

export interface GenerateDocumentOptions {
  /** Embed contractor-signature.png for {{contractor_signature}} (warranty certificate). */
  embedContractorSignature?: boolean;
}

const SIG_MEDIA_PATH = "word/media/contractor-sig.png";
const SIG_REL_ID = "rId901";
const SIG_REL_TARGET = "media/contractor-sig.png";
/** 200px × 65px at 9144 EMU/px */
const SIG_CX = 1828800;
const SIG_CY = 593820;

/** Inline OOXML drawing block — namespaces declared on wp:inline (matches prep-templates.ts). */
function buildContractorSignatureDrawingRun(rId: string): string {
  return (
    `<w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${SIG_CX}" cy="${SIG_CY}"/>` +
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
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${SIG_CX}" cy="${SIG_CY}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `</pic:spPr>` +
    `</pic:pic>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:inline>` +
    `</w:drawing>`
  );
}

/** Exact prep-templates run shape (preferred). */
const SIG_RUN_PATTERN =
  /<w:r><w:rPr><w:sz w:val="28"\/><w:szCs w:val="28"\/><\/w:rPr><w:t xml:space="preserve">\{\{contractor_signature\}\}<\/w:t><\/w:r>/;

/**
 * Fallback: any single run whose text is exactly the placeholder (font/size may differ).
 * JOB-108 showed the exact pattern can be absent after prep/R2 drift while the token remains.
 */
const SIG_RUN_FALLBACK =
  /<w:r(?:\s[^>]*)?>((?:(?!<\/w:r>).)*?)<w:t([^>]*)>\{\{contractor_signature\}\}<\/w:t>((?:(?!<\/w:r>).)*?)<\/w:r>/;

function ensureSignatureImageInZip(unzipped: Record<string, Uint8Array>, png: Uint8Array): void {
  unzipped[SIG_MEDIA_PATH] = png;

  const relsKey = "word/_rels/document.xml.rels";
  if (unzipped[relsKey]) {
    let relsXml = strFromU8(unzipped[relsKey]);
    if (!relsXml.includes(`Id="${SIG_REL_ID}"`)) {
      const rel =
        `<Relationship Id="${SIG_REL_ID}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
        `Target="${SIG_REL_TARGET}"/>`;
      relsXml = relsXml.replace("</Relationships>", `${rel}</Relationships>`);
      unzipped[relsKey] = strToU8(relsXml);
    }
  }

  const typesKey = "[Content_Types].xml";
  if (unzipped[typesKey]) {
    let typesXml = strFromU8(unzipped[typesKey]);
    if (!typesXml.includes('Extension="png"')) {
      typesXml = typesXml.replace(
        "</Types>",
        `<Default Extension="png" ContentType="image/png"/></Types>`,
      );
      unzipped[typesKey] = strToU8(typesXml);
    }
  }
}

function embedContractorSignatureInXml(docXml: string): string {
  // Prep may already bake the drawing (lien waiver); nothing to do.
  if (!docXml.includes("{{contractor_signature}}")) {
    return docXml;
  }
  const drawingRun = `<w:r>${buildContractorSignatureDrawingRun(SIG_REL_ID)}</w:r>`;
  if (SIG_RUN_PATTERN.test(docXml)) {
    return docXml.replace(SIG_RUN_PATTERN, drawingRun);
  }
  if (SIG_RUN_FALLBACK.test(docXml)) {
    console.warn("[document-generator] using fallback {{contractor_signature}} run match");
    return docXml.replace(SIG_RUN_FALLBACK, drawingRun);
  }
  console.warn("[document-generator] {{contractor_signature}} run pattern not found — clearing token");
  return docXml.replace(/\{\{contractor_signature\}\}/g, "");
}

/**
 * Takes a prepped .docx template (ArrayBuffer from R2) and a map of merge
 * fields, replaces every {{field_name}} in word/document.xml, and returns the
 * resulting .docx as a Uint8Array.
 *
 * Business rule 5: fields that resolve to null/undefined/empty become "".
 * Business rule 3: currency values must be formatted before being passed in.
 * Business rule 4: dates must be formatted before being passed in.
 */
export async function generateDocument(
  templateBuffer: ArrayBuffer,
  mergeFields: Record<string, string>,
  options?: GenerateDocumentOptions,
): Promise<Uint8Array> {
  const zipData = new Uint8Array(templateBuffer);
  const unzipped = unzipSync(zipData);

  let docXml = strFromU8(unzipped["word/document.xml"]);

  console.log(`[document-generator] merge fields before substitution: ${JSON.stringify(mergeFields)}`);

  const embedSig = options?.embedContractorSignature === true;
  const textFields = { ...mergeFields };
  if (embedSig) delete textFields.contractor_signature;

  for (const [key, value] of Object.entries(textFields)) {
    const safe = (value ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    docXml = docXml.replaceAll(`{{${key}}}`, safe);
  }

  if (embedSig) {
    ensureSignatureImageInZip(unzipped, getContractorSignaturePng());
    docXml = embedContractorSignatureInXml(docXml);
  }

  // Business rule 5: clear any unreplaced {{token}} placeholders
  docXml = docXml.replace(/\{\{[a-z_]+\}\}/g, "");

  unzipped["word/document.xml"] = strToU8(docXml);
  return zipSync(unzipped);
}

/**
 * Normalize BoldSign text tags before send.
 *
 * BoldSign converts tags to form fields but does NOT remove the underlying tag
 * text from the finished PDF — tags must be white-on-white or they ghost behind
 * the signed values (see BoldSign text-tags docs).
 */
export function canonicalizeBoldSignTextTags(docxBytes: ArrayBuffer): Uint8Array {
  const LEGACY_SIG = "{{sign|1|*|sig}}";
  const LEGACY_DATE = "{{date|1|*|date}}";
  const CANON_SIG = "{{sign|1|*| |client_sig}}";
  const CANON_DATE = "{{date|1|*| |client_date}}";

  const unzipped = unzipSync(new Uint8Array(docxBytes));
  const xmlKey = "word/document.xml";
  if (!unzipped[xmlKey]) return new Uint8Array(docxBytes);

  let docXml = strFromU8(unzipped[xmlKey]);
  const hadLegacy = docXml.includes(LEGACY_SIG) || docXml.includes(LEGACY_DATE);
  const hadTextTag = /\{\{(?:sign|date|text|checkbox)\|/.test(docXml);
  if (!hadLegacy && !hadTextTag) {
    return new Uint8Array(docxBytes);
  }

  if (hadLegacy) {
    docXml = docXml.replaceAll(LEGACY_SIG, CANON_SIG).replaceAll(LEGACY_DATE, CANON_DATE);
  }

  // Force every run that contains a BoldSign text tag to white (#FFFFFF).
  docXml = docXml.replace(
    /<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>(\s*<w:t[^>]*>\{\{(?:sign|date|text|checkbox)\|)/g,
    (_m, rPrInner: string, rest: string) => {
      let next = rPrInner;
      if (/<w:color\b/.test(next)) {
        next = next.replace(/<w:color\b[^/]*\/>/g, '<w:color w:val="FFFFFF"/>');
      } else {
        next += '<w:color w:val="FFFFFF"/>';
      }
      return `<w:rPr>${next}</w:rPr>${rest}`;
    },
  );

  unzipped[xmlKey] = strToU8(docXml);
  return zipSync(unzipped);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Format a number as "$X,XXX.XX" (business rule 3). */
export function formatCurrency(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format a date string as "MMMM D, YYYY" (business rule 4). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : value + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(d);
}

/** Today's date formatted as "MMMM D, YYYY". */
export function formatToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date());
}

/** Add five years (1825 days) to a date string for warranty expiry display. */
export function formatDatePlusOneYear(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : value + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + 1825);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(d);
}

/** Format a number as "15%" (percentage). */
export function formatPercent(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return `${n}%`;
  return `${n}%`;
}
