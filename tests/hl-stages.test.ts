import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HL_MIRROR_STAGE_TO_CHS,
  HL_STAGE_DEAD_LEAD,
  HL_STAGE_JOB_COLLECTED,
  HL_STAGE_NEW_LEAD,
  isFreshHlStageChange,
} from "../src/lib/hl-stages.js";
import { splitRealName } from "../src/lib/hl-lead-mirror.js";

describe("HL mirror stage map", () => {
  it("copies Contacted, Appointment Set, Create Estimate, and Estimate Sent only", () => {
    expect(HL_MIRROR_STAGE_TO_CHS).toEqual({
      "27df8419-2d30-453a-8b6a-64ac6aa4281c": "contacted",
      "a85d0a99-a3ad-4257-a842-416b0306437d": "appointment_set",
      "c19a86f7-e719-45a3-b098-5af180584173": "building",
      "f867aae0-2783-4ef2-9b5c-632276b54307": "sent",
    });
  });

  it("does not mirror New, Dead, or Job Completed", () => {
    expect(HL_MIRROR_STAGE_TO_CHS[HL_STAGE_NEW_LEAD]).toBeUndefined();
    expect(HL_MIRROR_STAGE_TO_CHS[HL_STAGE_DEAD_LEAD]).toBeUndefined();
    expect(HL_MIRROR_STAGE_TO_CHS[HL_STAGE_JOB_COLLECTED]).toBeUndefined();
  });

  it("treats a stage change older than 24h as stale", () => {
    const now = new Date("2026-09-22T18:00:00.000Z");
    expect(isFreshHlStageChange("2026-09-22T12:00:00.000Z", now)).toBe(true);
    expect(isFreshHlStageChange("2026-09-21T17:00:00.000Z", now)).toBe(false);
    expect(isFreshHlStageChange(null, now)).toBe(false);
  });
});

describe("HL client names", () => {
  it("keeps a real name and leaves a phone title blank", () => {
    expect(splitRealName("Pat Jones")).toEqual({ first: "Pat", last: "Jones" });
    expect(splitRealName("(501) 555-0100")).toEqual({ first: null, last: null });
    expect(splitRealName("")).toEqual({ first: null, last: null });
    expect(splitRealName("Unknown Lead")).toEqual({ first: null, last: null });
    expect(splitRealName("Google LSA")).toEqual({ first: null, last: null });
    expect(splitRealName("Google LSA +15012718769")).toEqual({ first: null, last: null });
    expect(splitRealName("tyelerbenson6@gmail.com")).toEqual({ first: null, last: null });
    expect(splitRealName("Tyelerbenson6@gmail.com Lead")).toEqual({ first: null, last: null });
  });
});

describe("HL mirror writes", () => {
  it("contains no HighLevel write calls", () => {
    const src = readFileSync(new URL("../src/lib/hl-lead-mirror.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/method:\s*["'](PUT|POST|PATCH|DELETE)["']/);
  });
});
