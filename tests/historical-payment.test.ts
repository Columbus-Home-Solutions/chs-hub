import { describe, expect, it } from "vitest";
import {
  HISTORICAL_NOTE_MARKER,
  additionalHistoricalAmount,
  appendHistoricalNote,
  isHistoricalInvoice,
  isHistoricalPaymentMethod,
} from "../src/lib/historical-payment.js";

describe("historical invoice payment helpers", () => {
  it("recognizes allowed external methods including Jobber", () => {
    expect(isHistoricalPaymentMethod("jobber")).toBe(true);
    expect(isHistoricalPaymentMethod("venmo")).toBe(true);
    expect(isHistoricalPaymentMethod("credit_card")).toBe(false);
    expect(isHistoricalPaymentMethod("ach")).toBe(false);
  });

  it("stamps a durable historical marker without duplicating it", () => {
    const first = appendHistoricalNote(null, "Paid via Jobber, migrated to CHS 2026-09-20");
    expect(first).toContain(HISTORICAL_NOTE_MARKER);
    expect(first).toContain("Paid via Jobber");
    expect(isHistoricalInvoice(first)).toBe(true);
    const second = appendHistoricalNote(first, "Paid via Jobber, migrated to CHS 2026-09-20");
    expect(second.split(HISTORICAL_NOTE_MARKER).length - 1).toBe(1);
  });

  it("applies unlinked job payments first and never overpays", () => {
    // JOB-101: $1,300 invoice, $650 already on the job, owner types $1,300
    expect(additionalHistoricalAmount(1300, 0, 650, 1300)).toBe(650);
    expect(additionalHistoricalAmount(1300, 650, 0, 1300)).toBe(650);
    expect(additionalHistoricalAmount(1300, 650, 650, 1300)).toBe(0);
    expect(additionalHistoricalAmount(1300, 0, 0, 0)).toBe(1300);
  });
});
