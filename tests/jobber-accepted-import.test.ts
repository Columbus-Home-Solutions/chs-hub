import { describe, expect, it } from "vitest";
import {
  IMPORTED_SIGNED_BADGE,
  JOBBER_ACCEPTED_IMPORT,
  importedEstimateStatusLabel,
  isJobberAcceptedImport,
  shouldSkipBoldSignForEstimate,
} from "../shared/jobber-accepted-import.js";
import { isEstimateSent } from "../src/lib/quote-to-job.js";
import { resolveImportProperty } from "../src/lib/jobber-accepted-import.js";

describe("jobber-accepted-import discriminator", () => {
  it("treats only jobber_accepted_import as the live recreation marker", () => {
    expect(isJobberAcceptedImport("jobber_accepted_import")).toBe(true);
    expect(isJobberAcceptedImport(JOBBER_ACCEPTED_IMPORT)).toBe(true);
    expect(isJobberAcceptedImport("jobber_import")).toBe(false);
    expect(isJobberAcceptedImport(null)).toBe(false);
    expect(isJobberAcceptedImport(undefined)).toBe(false);
    expect(isJobberAcceptedImport("chs_native")).toBe(false);
  });

  it("skips BoldSign for imported recreations only", () => {
    expect(shouldSkipBoldSignForEstimate("jobber_accepted_import")).toBe(true);
    expect(shouldSkipBoldSignForEstimate("jobber_import")).toBe(false);
    expect(shouldSkipBoldSignForEstimate(null)).toBe(false);
  });

  it("uses a distinct badge until the estimate is approved/converted", () => {
    expect(importedEstimateStatusLabel("jobber_accepted_import", "signed")).toBe(IMPORTED_SIGNED_BADGE);
    expect(importedEstimateStatusLabel("jobber_accepted_import", "draft")).toBe(IMPORTED_SIGNED_BADGE);
    expect(importedEstimateStatusLabel("jobber_accepted_import", "approved")).toBeNull();
    expect(importedEstimateStatusLabel("jobber_import", "approved")).toBeNull();
    expect(importedEstimateStatusLabel(null, "signed")).toBeNull();
  });
});

describe("quote-to-job sent gate (imported signed status)", () => {
  it("treats status=signed as sent even without sent_at (no CHS send required)", () => {
    expect(isEstimateSent("signed", null)).toBe(true);
    expect(isEstimateSent("draft", null)).toBe(false);
    expect(isEstimateSent("sent", null)).toBe(true);
  });
});

describe("resolveImportProperty", () => {
  it("prefers the explicit body address", () => {
    const got = resolveImportProperty({
      bodyAddress: "12 Oak St",
      bodyCity: "Conway",
      bodyZip: "72032",
      clientProperty: { id: "p1", address: "Other", city: "LR", state: "AR", zip: "72201" },
    });
    expect("error" in got).toBe(false);
    if ("error" in got) return;
    expect(got.address).toBe("12 Oak St");
    expect(got.city).toBe("Conway");
    expect(got.zip).toBe("72032");
  });

  it("falls back to the client's property then mailing address", () => {
    const fromProperty = resolveImportProperty({
      clientProperty: { id: "p1", address: "9 Pine", city: "Cabot", state: "AR", zip: "72023" },
    });
    expect("error" in fromProperty).toBe(false);
    if (!("error" in fromProperty)) {
      expect(fromProperty.address).toBe("9 Pine");
      expect(fromProperty.propertyId).toBe("p1");
    }

    const fromMailing = resolveImportProperty({
      clientMailing: {
        mailing_address: "1 Main",
        mailing_city: "Austin",
        mailing_state: "Arkansas",
        mailing_zip: "72007",
      },
    });
    expect("error" in fromMailing).toBe(false);
    if (!("error" in fromMailing)) expect(fromMailing.zip).toBe("72007");
  });

  it("errors when no address can be resolved", () => {
    const got = resolveImportProperty({});
    expect("error" in got).toBe(true);
  });
});
