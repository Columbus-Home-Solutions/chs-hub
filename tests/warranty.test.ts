import { describe, expect, it } from "vitest";
import { isWithinWarrantyExpiration } from "../src/lib/warranty.js";

describe("isWithinWarrantyExpiration", () => {
  it("returns false when expiration is null", () => {
    expect(isWithinWarrantyExpiration(null)).toBe(false);
    expect(isWithinWarrantyExpiration(undefined)).toBe(false);
  });

  it("returns true when expiration is today or in the future", () => {
    expect(isWithinWarrantyExpiration("2031-07-16", "2026-07-17")).toBe(true);
    expect(isWithinWarrantyExpiration("2026-07-17", "2026-07-17")).toBe(true);
  });

  it("returns false when expiration is in the past", () => {
    expect(isWithinWarrantyExpiration("2020-01-01", "2026-07-17")).toBe(false);
    expect(isWithinWarrantyExpiration("2026-07-16", "2026-07-17")).toBe(false);
  });
});
