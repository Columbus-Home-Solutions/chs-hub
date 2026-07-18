import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { canonicalizeBoldSignTextTags } from "../src/lib/document-generator.js";

function makeDocx(documentXml: string): ArrayBuffer {
  const unzipped: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    ),
    "word/document.xml": strToU8(documentXml),
  };
  return zipSync(unzipped).buffer;
}

function readDocumentXml(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)["word/document.xml"]);
}

describe("canonicalizeBoldSignTextTags", () => {
  it("forces gray text-tag runs to white so tags cannot ghost in the signed PDF", () => {
    const xml =
      `<w:document><w:body><w:p>` +
      `<w:r><w:rPr><w:sz w:val="24"/><w:color w:val="CCCCCC"/></w:rPr>` +
      `<w:t xml:space="preserve">{{sign|1|*| |client_sig}}</w:t></w:r>` +
      `<w:r><w:rPr><w:sz w:val="24"/><w:color w:val="CCCCCC"/></w:rPr>` +
      `<w:t xml:space="preserve">{{date|1|*| |client_date}}</w:t></w:r>` +
      `</w:p></w:body></w:document>`;

    const out = readDocumentXml(canonicalizeBoldSignTextTags(makeDocx(xml)));
    expect(out).toContain('w:val="FFFFFF"');
    expect(out).not.toContain('w:val="CCCCCC"');
    expect(out).toContain("{{sign|1|*| |client_sig}}");
    expect(out).toContain("{{date|1|*| |client_date}}");
  });

  it("upgrades legacy 4-part tags and paints them white", () => {
    const xml =
      `<w:document><w:body><w:p>` +
      `<w:r><w:rPr><w:sz w:val="24"/></w:rPr>` +
      `<w:t>{{sign|1|*|sig}}</w:t></w:r>` +
      `</w:p></w:body></w:document>`;

    const out = readDocumentXml(canonicalizeBoldSignTextTags(makeDocx(xml)));
    expect(out).toContain("{{sign|1|*| |client_sig}}");
    expect(out).not.toContain("{{sign|1|*|sig}}");
    expect(out).toContain('w:val="FFFFFF"');
  });
});
