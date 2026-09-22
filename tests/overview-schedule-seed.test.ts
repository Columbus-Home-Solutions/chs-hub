import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env.js";
import {
  OVERVIEW_SEED_NOTE,
  hasDetailedSchedule,
  isOverviewSeedEntry,
  jobScheduleTitle,
  normalizeScheduleDate,
  overviewScheduleAction,
  syncOverviewStartDate,
  type OverviewSeedEntry,
} from "../src/lib/overview-schedule-seed.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface EntryRow extends OverviewSeedEntry {
  job_id: string;
  scheduled_date: string | null;
  trade_or_work: string | null;
}

function seed(p: Partial<OverviewSeedEntry> = {}): OverviewSeedEntry {
  return {
    id: p.id ?? "seed-1",
    start_time: p.start_time ?? null,
    end_time: p.end_time ?? null,
    sub_id: p.sub_id ?? null,
    notes: p.notes ?? OVERVIEW_SEED_NOTE,
  };
}

function makeEnv(entries: EntryRow[]) {
  const rows = [...entries];
  const db = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, " ").trim();
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async all<T>() {
          if (norm.includes("FROM schedule_entries WHERE job_id = ?")) {
            const jobId = this._args[0] as string;
            return {
              results: rows
                .filter((r) => r.job_id === jobId)
                .map((r) => ({
                  id: r.id,
                  start_time: r.start_time,
                  end_time: r.end_time,
                  sub_id: r.sub_id,
                  notes: r.notes,
                })) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (norm.startsWith("INSERT INTO schedule_entries")) {
            rows.push({
              id: this._args[0] as string,
              job_id: this._args[1] as string,
              scheduled_date: this._args[2] as string,
              trade_or_work: this._args[3] as string,
              start_time: null,
              end_time: null,
              sub_id: null,
              notes: this._args[4] as string,
            });
            return { success: true };
          }
          if (norm.startsWith("UPDATE schedule_entries SET scheduled_date")) {
            const date = this._args[0] as string;
            const id = this._args[1] as string;
            const hit = rows.find((r) => r.id === id);
            if (hit) hit.scheduled_date = date;
            return { success: true };
          }
          if (norm.startsWith("DELETE FROM schedule_entries")) {
            const id = this._args[0] as string;
            const i = rows.findIndex((r) => r.id === id);
            if (i >= 0) rows.splice(i, 1);
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          return null;
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, rows };
}

describe("overview schedule seed helpers", () => {
  it("treats only the unmarked all-day Overview seed as updatable", () => {
    expect(isOverviewSeedEntry(seed())).toBe(true);
    expect(isOverviewSeedEntry(seed({ start_time: "08:00" }))).toBe(false);
    expect(isOverviewSeedEntry(seed({ sub_id: "sub-1" }))).toBe(false);
    expect(isOverviewSeedEntry(seed({ notes: "Bring extra lumber" }))).toBe(false);
  });

  it("creates when empty, updates the single seed, leaves detailed entries alone", () => {
    expect(overviewScheduleAction([])).toBe("create");
    expect(overviewScheduleAction([seed()])).toBe("update");
    expect(
      overviewScheduleAction([
        seed(),
        seed({ id: "two", notes: "Framing" }),
      ]),
    ).toBe("leave");
    expect(
      overviewScheduleAction([seed({ id: "manual", notes: null, start_time: "09:00" })]),
    ).toBe("leave");
  });

  it("flags a detailed Schedule-tab plan for the Overview note", () => {
    expect(hasDetailedSchedule([])).toBe(false);
    expect(hasDetailedSchedule([seed()])).toBe(false);
    expect(hasDetailedSchedule([seed({ notes: "Plumbing", start_time: "08:00" })])).toBe(true);
  });

  it("titles the seed from job number + title", () => {
    expect(jobScheduleTitle("Pergola Repair", 279)).toBe("JOB-279 Pergola Repair");
    expect(jobScheduleTitle("Pergola Repair", null)).toBe("Pergola Repair");
    expect(jobScheduleTitle("", 12)).toBe("JOB-012");
    expect(jobScheduleTitle(null, null)).toBe("Job");
  });

  it("normalizes dates to YYYY-MM-DD", () => {
    expect(normalizeScheduleDate("2026-09-22")).toBe("2026-09-22");
    expect(normalizeScheduleDate("2026-09-22T15:00:00Z")).toBe("2026-09-22");
    expect(normalizeScheduleDate("")).toBe(null);
    expect(normalizeScheduleDate(null)).toBe(null);
  });
});

describe("syncOverviewStartDate", () => {
  it("creates one seed when the job has no schedule entries", async () => {
    const { env, rows } = makeEnv([]);
    const result = await syncOverviewStartDate(env, "job-1", "2026-09-22", "Deck", 4);
    expect(result).toBe("created");
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_date).toBe("2026-09-22");
    expect(rows[0].trade_or_work).toBe("JOB-004 Deck");
    expect(rows[0].notes).toBe(OVERVIEW_SEED_NOTE);
    expect(rows[0].start_time).toBeNull();
  });

  it("updates the seed date instead of inserting a second row", async () => {
    const { env, rows } = makeEnv([
      {
        id: "seed-1",
        job_id: "job-1",
        scheduled_date: "2026-09-22",
        trade_or_work: "JOB-004 Deck",
        start_time: null,
        end_time: null,
        sub_id: null,
        notes: OVERVIEW_SEED_NOTE,
      },
    ]);
    const result = await syncOverviewStartDate(env, "job-1", "2026-09-28", "Deck", 4);
    expect(result).toBe("updated");
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_date).toBe("2026-09-28");
  });

  it("does not create, duplicate, or shift entries once a Schedule-tab row exists", async () => {
    const { env, rows } = makeEnv([
      {
        id: "manual-1",
        job_id: "job-1",
        scheduled_date: "2026-09-20",
        trade_or_work: "Framing",
        start_time: "08:00",
        end_time: "16:00",
        sub_id: "sub-1",
        notes: null,
      },
    ]);
    const result = await syncOverviewStartDate(env, "job-1", "2026-10-01", "Deck", 4);
    expect(result).toBe("left");
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_date).toBe("2026-09-20");
  });
});

describe("Overview date sync wiring", () => {
  const jobsApi = readFileSync(join(repoRoot, "src/routes/jobs-api.ts"), "utf8");
  const detail = readFileSync(join(repoRoot, "frontend/src/views/jobs/JobDetail.tsx"), "utf8");

  it("seeds from PUT /api/jobs/:id when start_date changes", () => {
    expect(jobsApi).toContain("syncOverviewStartDate");
    expect(jobsApi).toContain('if ("start_date" in body)');
    expect(jobsApi).toContain("has_detailed_schedule");
  });

  it("shows the Schedule-tab note on Overview when a detailed plan exists", () => {
    expect(detail).toContain("has_detailed_schedule");
    expect(detail).toContain("Detailed schedule set on the Schedule tab");
  });
});
