import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("job health matches the jobs list", () => {
  const health = read("src/routes/job-health.ts");
  const jobs = read("src/routes/jobs-api.ts");
  const dashboard = read("src/routes/dashboard.ts");
  const cascade = read("src/lib/cascade-delete.ts");

  it("starts from jobs and drops test clients and non-native sources", () => {
    expect(health).toContain("FROM jobs j");
    expect(health).toContain("nativeJobSourceWhereAliased(\"j\")");
    expect(health).toContain("NON_TEST_CLIENT");
    expect(health).not.toMatch(/FROM\s+(daily_logs|smart_notes|photos)\b/);
  });

  it("clears the 5-minute dashboard caches when a job is deleted", () => {
    expect(dashboard).toContain("export function invalidateDashboardCache");
    expect(jobs).toContain("invalidateDashboardCache()");
    const del = jobs.slice(jobs.indexOf("DELETE /api/jobs/:id"), jobs.indexOf("POST /api/jobs/quick"));
    expect(del.indexOf("cascadeDeleteJob")).toBeLessThan(del.indexOf("DELETE FROM jobs"));
    expect(del.indexOf("DELETE FROM jobs")).toBeLessThan(del.indexOf("invalidateDashboardCache()"));
  });

  it("cascade already removes the non-enforced child tables", () => {
    for (const table of ["daily_logs", "smart_notes", "photos", "notes", "job_files", "invoices", "payments", "expenses"]) {
      expect(cascade).toContain(`DELETE FROM ${table} WHERE job_id = ?`);
    }
  });
});
