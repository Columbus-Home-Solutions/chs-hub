import { describe, it, expect } from "vitest";
import { parseQuantitiesNotes } from "../src/lib/bid-award-sub-item.js";

describe("parseQuantitiesNotes", () => {
  it("parses a clean number + unit string", () => {
    expect(parseQuantitiesNotes("1000 sqft")).toEqual({ quantity: 1000, unit: "sqft" });
    expect(parseQuantitiesNotes("14 fixtures")).toEqual({ quantity: 14, unit: "fixtures" });
    expect(parseQuantitiesNotes("2.5 tons")).toEqual({ quantity: 2.5, unit: "tons" });
  });

  it("returns null for messy or partial strings", () => {
    expect(parseQuantitiesNotes(null)).toBeNull();
    expect(parseQuantitiesNotes("")).toBeNull();
    expect(parseQuantitiesNotes("about 1000 sqft")).toBeNull();
    expect(parseQuantitiesNotes("1000")).toBeNull();
    expect(parseQuantitiesNotes("sqft")).toBeNull();
    expect(parseQuantitiesNotes("1000 sq ft plus closet")).toBeNull();
  });
});
