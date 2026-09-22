import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILDING_STALE_MS,
  buildingClientName,
  buildingIsStale,
  buildingPlace,
  daysInBuilding,
} from "../src/lib/building-widget.js";
import {
  advanceLeadToBuildingIfEligible,
  applyLeadStageChange,
} from "../src/lib/lead-stage.js";
import type { Env } from "../src/env.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

type Call = { sql: string; binds: unknown[] };

function fakeEnv(changesFor: (sql: string) => number): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async run() {
                calls.push({ sql, binds });
                return { meta: { changes: changesFor(sql) } };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("building widget copy", () => {
  it("drops placeholder addresses and falls back to a phone", () => {
    expect(buildingPlace({
      property_address: "Unknown",
      property_city: "Unknown",
      property_zip: "00000",
      contact_phone: "+15015550100",
    })).toBe("+15015550100");
    expect(buildingPlace({
      property_address: "12 Oak St",
      property_city: "Unknown",
      property_state: "Arkansas",
      property_zip: "72007",
    })).toBe("12 Oak St, Arkansas 72007");
    expect(buildingClientName({ first_name: "Unknown", last_name: "", contact_name: "Megan Lewis" })).toBe("Megan Lewis");
  });

  it("flags only after more than 5 days", () => {
    const start = "2026-09-01 12:00:00";
    const t = Date.parse("2026-09-01T12:00:00Z");
    expect(buildingIsStale(start, t + BUILDING_STALE_MS)).toBe(false);
    expect(buildingIsStale(start, t + BUILDING_STALE_MS + 1)).toBe(true);
    expect(daysInBuilding(start, t + 6 * 24 * 60 * 60 * 1000)).toBe(6);
  });
});

describe("applyLeadStageChange building clock", () => {
  it("stamps building_at and stops an active Contacted sequence", async () => {
    const { env, calls } = fakeEnv(() => 1);
    await applyLeadStageChange(env, "req-1", "contacted", "building");
    expect(calls.map((c) => c.sql)).toEqual([
      expect.stringContaining("building_at = datetime('now')"),
      expect.stringContaining("lead_outreach_sequence_active = 0"),
    ]);
    expect(calls[1]?.sql).toContain("COALESCE(lead_outreach_sequence_active, 0) = 1");
    expect(calls.some((c) => c.sql.includes("lead_outreach_sequence_active = 1"))).toBe(false);
  });

  it("does not clear building_at when the lead leaves building", async () => {
    const { env, calls } = fakeEnv(() => 1);
    await applyLeadStageChange(env, "req-1", "building", "sent");
    expect(calls.some((c) => c.sql.includes("building_at"))).toBe(false);
  });

  it("resets building_at on re-entry", async () => {
    const { env, calls } = fakeEnv(() => 1);
    await applyLeadStageChange(env, "req-1", "sent", "building");
    expect(calls[0]?.sql).toContain("building_at = datetime('now')");
  });

  it("does not advance Contacted, Sent, or an already-Building lead", async () => {
    for (const status of ["contacted", "sent", "building", "won"]) {
      const { env, calls } = fakeEnv(() => 1);
      const moved = await advanceLeadToBuildingIfEligible(env, "req-1", status);
      expect(moved).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("advances appointment_set through the hook", async () => {
    const { env, calls } = fakeEnv((sql) => (sql.includes("SET status = 'building'") ? 1 : 1));
    const moved = await advanceLeadToBuildingIfEligible(env, "req-1", "appointment_set");
    expect(moved).toBe(true);
    expect(calls[0]?.sql).toContain("status = 'building'");
    expect(calls[0]?.binds).toEqual(["req-1", "appointment_set"]);
    expect(calls[1]?.sql).toContain("building_at = datetime('now')");
  });
});

describe("estimates in progress wiring", () => {
  const dashboard = read("src/routes/dashboard.ts");
  const estimates = read("src/routes/estimates.ts");
  const scope = read("src/routes/scope-draft.ts");
  const widget = read("frontend/src/views/dashboard/EstimateRequestsWidget.tsx");
  const home = read("frontend/src/views/Dashboard.tsx");

  it("lists building leads only, oldest first, with the draft total", () => {
    expect(dashboard).toContain("er.status = 'building'");
    expect(dashboard).not.toContain("er.estimate_id IS NULL");
    expect(dashboard).toContain("ORDER BY er.building_at ASC");
    expect(dashboard).toContain("e.total AS estimate_total");
    expect(dashboard).toContain("NON_TEST_OR_ORPHAN_CLIENT");
  });

  it("routes both auto-advances through the shared hook", () => {
    const create = estimates.slice(
      estimates.indexOf("Normal (request-linked) path"),
      estimates.indexOf("PUT /api/estimates/:id"),
    );
    expect(create).toContain("advanceLeadToBuildingIfEligible");
    expect(create).not.toContain("THEN 'building'");
    expect(scope).toContain("advanceLeadToBuildingIfEligible");
    expect(scope).not.toContain("status IN ('appointment_set', 'visit_done')");
  });

  it("keeps the widget on every device and opens the builder or the pre-fill form", () => {
    expect(home).toContain("const showEstimateRequests = true");
    expect(home).toContain("isPhone && showEstimateRequests");
    expect(widget).toContain("Estimates in Progress");
    expect(widget).toContain("No estimates in progress.");
    expect(widget).toContain("/estimating?tab=chs&stage=building");
    expect(widget).toContain("/estimating/${item.id}/estimate");
    expect(widget).toContain("/estimating/new?request_id=${item.id}&autostart=1");
    expect(widget).toContain("VISIBLE = 5");
    expect(widget).toContain("job-health-widget__row--stale");
    expect(widget).not.toContain("Unknown");
  });
});
