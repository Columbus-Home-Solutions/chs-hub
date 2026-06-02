import { describe, it, expect } from "vitest";
import { renderMergeContent, sampleMergeFields } from "../src/lib/merge-fields";
import {
  renderCompletionPackageHtml,
  type CompletionPackageData,
} from "../src/lib/completion-package";

describe("merge-field rendering (Sprint 15)", () => {
  it("substitutes known {{fields}} and leaves unknown tokens intact + reported", () => {
    const fields = { client_name: "Jane Maxwell", contract_total: "$48,500.00" };
    const { text, missing } = renderMergeContent(
      "Client: {{client_name}} owes {{contract_total}} for {{mystery_field}}.",
      fields,
    );
    expect(text).toBe("Client: Jane Maxwell owes $48,500.00 for {{mystery_field}}.");
    expect(missing).toEqual(["mystery_field"]);
  });

  it("is whitespace + case tolerant inside the braces", () => {
    const { text } = renderMergeContent("{{ Client_Name }}", { client_name: "Acme" });
    expect(text).toBe("Acme");
  });

  it("renders a full template against sample data with no missing fields", () => {
    const sample = sampleMergeFields();
    const tpl =
      "{{company_name}} — {{client_name}} — {{property_address}} — {{contract_total}} — {{today_date}}";
    const { text, missing } = renderMergeContent(tpl, sample);
    expect(missing).toEqual([]);
    expect(text).toContain("Columbus Home Solutions, LLC");
    expect(text).toContain("Jane & John Maxwell");
  });

  it("does not mutate when there are no placeholders", () => {
    const { text, missing } = renderMergeContent("Plain text, no merge fields.", {});
    expect(text).toBe("Plain text, no merge fields.");
    expect(missing).toEqual([]);
  });
});

describe("completion package HTML assembly (Sprint 15)", () => {
  const data: CompletionPackageData = {
    company_name: "Columbus Home Solutions, LLC",
    job_display: "JOB-107",
    job_title: "Reed Garage Conversion",
    client_name: "Sam Reed",
    property_address: "12 Reed Ln, Rogers, AR",
    generated_at: "June 1, 2026",
    financial: {
      contract_total: 50000,
      change_order_total: 2500,
      adjusted_total: 52500,
      total_invoiced: 52500,
      total_paid: 40000,
      balance: 12500,
    },
    documents: [{ category: "contract", items: [{ title: "Service Agreement (signed)" }] }],
    before_photos: [{ id: "p1", caption: "Before", url: "/api/portal/tok/photos/p1/image" }],
    after_photos: [{ id: "p2", caption: "After", url: "/api/portal/tok/photos/p2/image" }],
    warranty_text: "One-year workmanship warranty.",
  };

  it("produces a branded, printable HTML artifact with the financial summary", () => {
    const html = renderCompletionPackageHtml(data);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Project Completion Package");
    expect(html).toContain("JOB-107");
    expect(html).toContain("Reed Garage Conversion");
    // Financial rows (adjusted total + balance).
    expect(html).toContain("$52,500.00");
    expect(html).toContain("$12,500.00");
    // Photos rendered via the portal proxy (read-only in portal).
    expect(html).toContain("/api/portal/tok/photos/p1/image");
    expect(html).toContain("@media print"); // printable
  });

  it("escapes HTML in titles/captions to avoid injection in the artifact", () => {
    const evil: CompletionPackageData = {
      ...data,
      documents: [{ category: "contract", items: [{ title: "<script>alert(1)</script>" }] }],
    };
    const html = renderCompletionPackageHtml(evil);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles empty photo sets gracefully", () => {
    const empty: CompletionPackageData = { ...data, before_photos: [], after_photos: [] };
    const html = renderCompletionPackageHtml(empty);
    expect(html).toContain("No photos on file.");
  });
});
