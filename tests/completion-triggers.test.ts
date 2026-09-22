import { describe, expect, it } from "vitest";
import {
  LIEN_WAIVER_FAILED_REVIEW,
  LIEN_WAIVER_READY_REVIEW,
  lienWaiverJobStatusAllowsGeneration,
} from "../src/lib/completion-triggers.js";

describe("lien waiver auto-generate gates", () => {
  it("allows complete and closed jobs (JOB-101 is complete)", () => {
    expect(lienWaiverJobStatusAllowsGeneration("complete")).toBe(true);
    expect(lienWaiverJobStatusAllowsGeneration("closed")).toBe(true);
    expect(lienWaiverJobStatusAllowsGeneration("in_progress")).toBe(false);
    expect(lienWaiverJobStatusAllowsGeneration("scheduled")).toBe(false);
  });

  it("treats failed generations as retryable, not as an existing waiver", () => {
    expect(LIEN_WAIVER_READY_REVIEW).not.toContain(LIEN_WAIVER_FAILED_REVIEW);
    expect(LIEN_WAIVER_FAILED_REVIEW).toBe("failed");
  });
});
