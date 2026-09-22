import { describe, expect, it } from "vitest";
import { renderTemplate, renderTemplateText } from "../src/lib/merge-render.js";

const OUTREACH_DAY1 =
  "Hey {{client_first_name}}, this is Tony with Columbus Home Solutions! Thanks for reaching out — we just received your request about your {{job_type}} project and would love to connect. Do you have a few minutes to chat today?";
const OUTREACH_DAY2 =
  "Hey {{client_first_name}}, it's Tony again with Columbus Home Solutions. Just following up on your {{job_type}} project — is there a better time to reach you, or would texting work better?";
const OUTREACH_DAY3 =
  "Hey {{client_first_name}}, don't mean to bug you — just wanted to reach out one more time about the {{job_type}} project you were interested in. Let me know if you'd still like to chat and we'll make it happen!";
const POST_VISIT_SMS =
  "Hey {{client_first_name}}, it was great meeting with you today! We're working on your estimate for the {{job_type}} project and will have it over to you within the next couple of days. Let us know if you have any questions in the meantime!";
const POST_VISIT_SUBJECT = "Great Meeting With You Today — {{job_type}} Estimate Coming Soon";
const FOLLOW_UP_DAY5 =
  "Hi {{client_first_name}}, wanted to follow up on your estimate for {{job_type}}. Any questions I can answer? {{estimate_link}}";
const MISSED_CALL =
  "Hi {{client_first_name}}, sorry we missed your call! This is Columbus Home Solutions — what can we help you with? Call or text us back anytime at 501-263-2050.";

describe("renderTemplate client_first_name fallback", () => {
  const outreach = "Hey {{client_first_name}}, this is Tony with Columbus Home Solutions! Thanks for reaching out.";

  it("renders missing/empty/whitespace first names as 'there' (not blank, not the tag)", () => {
    for (const ctx of [{}, { client_first_name: "" }, { client_first_name: "   " }]) {
      const outreachText = renderTemplateText(outreach, ctx);
      expect(outreachText).toBe(
        "Hey there, this is Tony with Columbus Home Solutions! Thanks for reaching out.",
      );
      expect(outreachText).not.toContain("{{");
      expect(outreachText).not.toMatch(/Hey ,/);

      const missedText = renderTemplateText(MISSED_CALL, ctx);
      expect(missedText.startsWith("Hi there,")).toBe(true);
      expect(missedText).not.toContain("{{client_first_name}}");
    }
  });

  it("still renders a real first name", () => {
    expect(renderTemplateText(outreach, { client_first_name: "Betty" })).toBe(
      "Hey Betty, this is Tony with Columbus Home Solutions! Thanks for reaching out.",
    );
    expect(renderTemplateText(MISSED_CALL, { client_first_name: "Betty" }).startsWith("Hi Betty,")).toBe(
      true,
    );
  });

  it("does not invent fallbacks for unrelated missing tokens", () => {
    const { text, missing } = renderTemplate("Hi {{client_first_name}}, at {{property_address}}.", {});
    expect(text).toBe("Hi there, at .");
    expect(missing).toEqual(["property_address"]);
  });
});

describe("renderTemplate job_type generic/missing fallback", () => {
  const genericCtxs: Record<string, string>[] = [
    {},
    { job_type: "" },
    { job_type: "   " },
    { job_type: "other" },
    { job_type: "Other" },
    { job_type: "OTHER" },
  ];

  it("Day 1 outreach with null/empty/other reads 'your project' (no double space, no Other)", () => {
    for (const extra of genericCtxs) {
      const text = renderTemplateText(OUTREACH_DAY1, { client_first_name: "Betty", ...extra });
      expect(text).toContain("your project");
      expect(text).not.toContain("your  project");
      expect(text).not.toMatch(/Other/i);
      expect(text).not.toContain("{{");
    }
  });

  it("Day 2 and Day 3 outreach drop generic job_type the same way", () => {
    const day2 = renderTemplateText(OUTREACH_DAY2, { client_first_name: "Betty", job_type: "other" });
    expect(day2).toContain("your project");
    expect(day2).not.toMatch(/Other/i);

    const day3 = renderTemplateText(OUTREACH_DAY3, { client_first_name: "Betty", job_type: "Other" });
    expect(day3).toContain("the project you were interested in");
    expect(day3).not.toMatch(/Other/i);
  });

  it("still renders a real job type like Deck", () => {
    const text = renderTemplateText(OUTREACH_DAY1, {
      client_first_name: "Betty",
      job_type: "Deck",
    });
    expect(text).toContain("your Deck project");
    expect(text).not.toContain("your project and");
  });

  it("applies the same fallback on post-visit (shared tag, not Lead Outreach)", () => {
    const sms = renderTemplateText(POST_VISIT_SMS, {
      client_first_name: "Betty",
      job_type: "other",
    });
    expect(sms).toContain("the project and will have it over");
    expect(sms).not.toMatch(/Other/i);
    expect(sms).not.toContain("the  project");

    const subject = renderTemplateText(POST_VISIT_SUBJECT, { job_type: "other" });
    expect(subject).toBe("Great Meeting With You Today — Estimate Coming Soon");
    expect(subject).not.toMatch(/Other/i);
    expect(subject).not.toMatch(/project Estimate/i);

    const realSubject = renderTemplateText(POST_VISIT_SUBJECT, { job_type: "Deck" });
    expect(realSubject).toBe("Great Meeting With You Today — Deck Estimate Coming Soon");
  });

  it("quote follow-up templates without 'project' after the tag still avoid Other", () => {
    const text = renderTemplateText(FOLLOW_UP_DAY5, {
      client_first_name: "Betty",
      job_type: "other",
      estimate_link: "https://example.com/q",
    });
    expect(text).toBe(
      "Hi Betty, wanted to follow up on your estimate for project. Any questions I can answer? https://example.com/q",
    );
    expect(text).not.toMatch(/Other/i);

    const real = renderTemplateText(FOLLOW_UP_DAY5, {
      client_first_name: "Betty",
      job_type: "Deck",
      estimate_link: "https://example.com/q",
    });
    expect(real).toContain("your estimate for Deck.");
  });

  it("does not treat remodel_other as the generic catch-all", () => {
    const text = renderTemplateText(OUTREACH_DAY1, {
      client_first_name: "Betty",
      job_type: "Remodel Other",
    });
    expect(text).toContain("your Remodel Other project");
  });
});
