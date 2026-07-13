import { describe, it, expect } from "vitest";
import { nativeJobSourceWhere, nativeJobSourceWhereAliased, NATIVE_JOB_SOURCES_SQL } from "../src/lib/native-jobs.js";

describe("native-jobs", () => {
  it("includes estimate and quick_job sources", () => {
    expect(NATIVE_JOB_SOURCES_SQL).toBe("('estimate', 'quick_job')");
    expect(nativeJobSourceWhere()).toBe("source IN ('estimate', 'quick_job')");
    expect(nativeJobSourceWhereAliased("j")).toBe("j.source IN ('estimate', 'quick_job')");
  });
});
