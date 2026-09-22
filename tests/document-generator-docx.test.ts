import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { generateDocument, repairWordDocumentXml } from "../src/lib/document-generator.js";

function makeTemplate(documentXml: string): ArrayBuffer {
  const unzipped: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    ),
    "word/document.xml": strToU8(documentXml),
  };
  return zipSync(unzipped).buffer as ArrayBuffer;
}

describe("repairWordDocumentXml", () => {
  it("unwraps nested paragraphs and restores an orphan Transferability heading", () => {
    const broken =
      `<w:body><w:p><w:p><w:pPr/><w:r><w:t>What Is Covered</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>body</w:t></w:r></w:p>` +
      `<w:pPr/><w:r><w:t>Transferability</w:t></w:r></w:p></w:body>`;
    const fixed = repairWordDocumentXml(broken);
    expect(fixed).not.toContain("<w:p><w:p>");
    expect(fixed).toMatch(/<\/w:p><w:p><w:pPr/);
    expect(fixed).toContain("Transferability");
  });
});

describe("generateDocument", () => {
  it("merges fields, repairs nested paragraphs, and returns a valid zip", async () => {
    const xml =
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:p><w:r><w:t>{{client_name}}</w:t></w:r></w:p>` +
      `<w:pPr/><w:r><w:t>Transferability</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const out = await generateDocument(makeTemplate(xml), { client_name: "Nancee Roberson" });
    const unzipped = unzipSync(out);
    expect(unzipped["word/document.xml"]).toBeTruthy();
    const doc = strFromU8(unzipped["word/document.xml"]);
    expect(doc).toContain("Nancee Roberson");
    expect(doc).not.toContain("{{client_name}}");
    expect(doc).not.toContain("<w:p><w:p>");
    expect(doc).toMatch(/<\/w:p><w:p><w:pPr/);
  });

  it("escapes merge values so they cannot inject XML", async () => {
    const xml =
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>{{client_name}}</w:t></w:r></w:p></w:body></w:document>`;
    const out = await generateDocument(makeTemplate(xml), { client_name: "A & B <test>" });
    const doc = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(doc).toContain("A &amp; B &lt;test&gt;");
    expect(doc).not.toContain("<test>");
  });
});
