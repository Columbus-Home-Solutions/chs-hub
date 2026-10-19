import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { generateDocument } from "../src/lib/document-generator.js";

const SIGN = "{{sign|1|*| |client_sig}}";
const DATE = "{{date|1|*| |client_date}}";

function documentText(file: string): string {
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(file)))["word/document.xml"]);
  return xml.replace(/<[^>]+>/g, "");
}

function plain(file: string): string {
  return readFileSync(file, "utf8");
}

describe("agreement late-fee sentences", () => {
  it("puts the quote-page service late fee in the signed template and not the old fees", () => {
    for (const file of [
      "src/templates/CHS-Service-Agreement-Template.docx",
      "src/templates/prepped/service-agreement.docx",
    ]) {
      const text = documentText(file);
      expect(text).toContain("five percent (5%)");
      expect(text).toContain("seven (7) days of the date the invoice is sent to Client");
      expect(text).toContain("suspend work if payment is more than fourteen (14) days past due");
      expect(text).not.toContain("$50.00 per day");
      expect(text).not.toContain("1.5% monthly");
    }
  });

  it("puts the quote-page cost-plus due date, no-late-fee line, and carve-out in the signed template", () => {
    for (const file of [
      "src/templates/CHS-Cost-Plus-Agreement-Template.docx",
      "src/templates/prepped/cost-plus-agreement.docx",
    ]) {
      const text = documentText(file);
      expect(text).toContain("due within twenty-four (24) hours");
      expect(text).toContain("No late fee applies to Cost-Plus invoices.");
      expect(text).toContain(
        "The Late Payment Fee in the Service Agreement does not apply to this Cost-Plus Billing Agreement.",
      );
      expect(text).not.toContain("five percent (5%)");
      expect(text).not.toContain("$50.00 per day");
      expect(text).not.toContain("1.5% monthly");
      expect(text).not.toContain("due within 7 days of invoice date");
    }
  });

  it("matches the working-agreement prepped copy to the already-updated source sentence", () => {
    const source = documentText("src/templates/CHS-Working-Agreement-Template.docx");
    const prepped = documentText("src/templates/prepped/working-agreement.docx");
    const sentence =
      "All invoices are due within seven (7) days of the date the invoice is sent. If an invoice is not paid within seven (7) days after its due date, Columbus Home Solutions may, at its discretion, add a one-time late fee of five percent (5%) of the unpaid balance, and may waive or delay it.";
    expect(source).toContain(sentence);
    expect(prepped).toContain(sentence);
    expect(prepped).not.toContain("$50.00 per day");
    expect(prepped).not.toContain("1.5% monthly");
  });

  it("updates the downloadable plain-text copies and leaves their other sections", () => {
    const service = plain("public/docs/CHS-Service-Agreement-Template.docx");
    expect(service).toContain("five percent (5%)");
    expect(service).toContain("of the date the invoice is sent to Client");
    expect(service).not.toContain("$50.00 per day");
    expect(service).not.toContain("days of receipt");
    expect(service).toContain("## **6. Price Escalation**");

    const costPlus = plain("public/docs/CHS-Cost-Plus-Agreement-Template.docx");
    expect(costPlus).toContain("No late fee applies to Cost-Plus invoices.");
    expect(costPlus).toContain(
      "The Late Payment Fee in the Service Agreement does not apply to this Cost-Plus Billing Agreement.",
    );
    expect(costPlus).not.toContain("five percent (5%)");
    expect(costPlus).not.toContain("hours of receipt");
    expect(costPlus).toContain("## **6. Payment Methods**");
  });
});

describe("merge fill keeps BoldSign tags", () => {
  it("fills the service agreement the way generateDocument does and keeps the sign and date tags", async () => {
    const before = documentText("src/templates/prepped/service-agreement.docx");
    expect(before).toContain(SIGN);
    expect(before).toContain(DATE);
    const bytes = readFileSync("src/templates/prepped/service-agreement.docx");
    const out = await generateDocument(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      client_name: "ZZTEST Client",
      client_address: "1 Test St",
      client_phone: "501-555-0100",
      client_email: "zz@example.com",
      job_address: "1 Test St",
      job_name: "Kitchen",
      contract_date: "October 20, 2026",
      contract_amount: "$1,000.00",
      start_date: "November 1, 2026",
      completion_date: "December 1, 2026",
      payment_1_amount: "$300.00",
      payment_1_due: "Before work",
      payment_2_amount: "$400.00",
      payment_2_due: "Midpoint",
      payment_3_amount: "$300.00",
      payment_3_due: "Completion",
    });
    const text = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(text).toContain("ZZTEST Client");
    expect(text).toContain("$1,000.00");
    expect(text).not.toContain("{{client_name}}");
    expect(text).not.toContain("{{contract_amount}}");
    expect(text).toContain(SIGN);
    expect(text).toContain(DATE);
    expect(text).toContain("five percent (5%)");
    expect(text).not.toContain("$50.00 per day");
    expect(text).not.toContain("1.5% monthly");
  });

  it("fills the cost-plus agreement and keeps the sign and date tags", async () => {
    const before = documentText("src/templates/prepped/cost-plus-agreement.docx");
    expect(before).toContain(SIGN);
    expect(before).toContain(DATE);
    const bytes = readFileSync("src/templates/prepped/cost-plus-agreement.docx");
    const out = await generateDocument(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      client_name: "ZZTEST Client",
      client_address: "1 Test St",
      client_phone: "501-555-0100",
      client_email: "zz@example.com",
      job_address: "1 Test St",
      job_name: "Kitchen",
      contract_date: "October 20, 2026",
      management_fee_rate: "10",
      estimated_budget: "$8,000.00",
      deposit_amount: "$1,000.00",
    });
    const text = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(text).toContain("ZZTEST Client");
    expect(text).toContain("$1,000.00");
    expect(text).not.toContain("{{client_name}}");
    expect(text).not.toContain("{{deposit_amount}}");
    expect(text).toContain(SIGN);
    expect(text).toContain(DATE);
    expect(text).toContain("No late fee applies to Cost-Plus invoices.");
    expect(text).not.toContain("$50.00 per day");
    expect(text).not.toContain("1.5% monthly");
  });

  it("fills the working agreement and keeps the five percent sentence", async () => {
    const bytes = readFileSync("src/templates/prepped/working-agreement.docx");
    const out = await generateDocument(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      client_name: "ZZTEST Client",
      property_address: "1 Test St",
      today_date: "October 20, 2026",
      pm_name: "Tony Columbus",
      pm_phone: "501-555-0100",
      pm_email: "tony@example.com",
    });
    const text = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(text).toContain("ZZTEST Client");
    expect(text).not.toContain("{{client_name}}");
    expect(text).toContain("five percent (5%)");
    expect(text).not.toContain("$50.00 per day");
  });
});
