import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jobsApi = readFileSync(new URL("../src/routes/jobs-api.ts", import.meta.url), "utf8");
const invoices = readFileSync(new URL("../src/routes/invoices.ts", import.meta.url), "utf8");

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const next = source.indexOf("\nexport async function ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("imported jobs open by id", () => {
  it("looks up a job by id without the native source filter", () => {
    const detail = fnBody(jobsApi, "handleJobDetail");
    expect(detail).toContain('"WHERE j.id = ?"');
    expect(detail).not.toContain("AND ${NATIVE_JOB_WHERE}");
  });

  it("shows native jobs and live Jobber jobs on the list and pipeline", () => {
    expect(jobsApi).toContain("const JOB_LIST_WHERE = `${boardJobWhere(\"j\")} AND (${NON_TEST_CLIENT})`");
    expect(jobsApi).toContain("WHERE ${JOB_LIST_WHERE}");
    expect(fnBody(jobsApi, "handleJobList")).toContain("JOB_SELECT");
    expect(fnBody(jobsApi, "handleJobPipeline")).toContain("JOB_SELECT");
  });

  it("lets update, close-eligibility, and status find an imported job", () => {
    for (const name of ["handleJobUpdate", "handleJobCloseEligibility", "handleJobStatus"]) {
      const body = fnBody(jobsApi, name);
      expect(body, name).not.toContain("nativeJobSourceWhere()");
    }
  });

  it("keeps delete limited to native jobs", () => {
    expect(fnBody(jobsApi, "handleJobDelete")).toContain("nativeJobSourceWhere()");
  });

  it("creates an invoice on any existing job", () => {
    const create = fnBody(invoices, "handleInvoiceCreate");
    expect(create).toContain("WHERE id = ?");
    expect(create).not.toContain("nativeJobSourceWhere");
  });
});
