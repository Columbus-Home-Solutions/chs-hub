import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/env.js";
import {
  assignAwardedBidToJobIfExists,
  ensureBidAwardScheduleEntry,
  resolveJobIdForBidRequest,
  syncBidRequestsOnJobConversion,
  type BidRequestAssignmentContext,
} from "../src/lib/bid-job-assignment.js";

type Row = Record<string, unknown>;

function mockEnv(state: {
  jobs?: Row[];
  scheduleEntries?: Row[];
  bidRequests?: BidRequestAssignmentContext[];
  inserts?: Row[];
  updates?: { sql: string; args: unknown[] }[];
}): Env {
  const jobs = state.jobs ?? [];
  const scheduleEntries = state.scheduleEntries ?? [];
  const bidRequests = state.bidRequests ?? [];
  const inserts = state.inserts ?? [];
  const updates = state.updates ?? [];

  const db = {
    prepare(sql: string) {
      return {
        _sql: sql,
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          const s = this._sql;
          const a = this._args;
          if (s.includes("FROM jobs") && s.includes("estimate_id")) {
            const estId = a[0];
            const hit = jobs.find((j) => j.estimate_id === estId);
            return (hit as T) ?? null;
          }
          if (s.includes("SELECT start_date FROM jobs")) {
            const hit = jobs.find((j) => j.id === a[0]);
            return (hit ? { start_date: hit.start_date } : null) as T;
          }
          if (s.includes("FROM schedule_entries WHERE bid_request_id")) {
            const hit = scheduleEntries.find((e) => e.bid_request_id === a[0]);
            return (hit ? { id: hit.id } : null) as T;
          }
          return null;
        },
        async all<T>() {
          const s = this._sql;
          const a = this._args;
          if (s.includes("FROM bid_requests br")) {
            const estId = a[0];
            const results = bidRequests.filter(
              (br) =>
                br.estimate_id === estId ||
                (br.estimate_sub_item_id != null && estId === "est-1"),
            );
            return { results } as { results: T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          const s = this._sql;
          const a = this._args;
          if (s.startsWith("INSERT INTO schedule_entries")) {
            const row = {
              id: a[0],
              job_id: a[1],
              scheduled_date: a[2],
              trade_or_work: a[3],
              sub_id: a[4],
              notes: a[5],
              bid_request_id: a[6],
            };
            scheduleEntries.push(row);
            inserts.push(row);
          }
          if (s.startsWith("UPDATE bid_requests SET job_id")) {
            updates.push({ sql: s, args: a });
            const br = bidRequests.find((b) => b.id === a[1]);
            if (br) br.job_id = a[0] as string;
          }
          return { success: true };
        },
      };
    },
  };

  return { DB: db } as unknown as Env;
}

const baseBid: BidRequestAssignmentContext = {
  id: "br-1",
  title: "Electrical rough-in",
  scope_description: "Rough-in panel and circuits for unit 4.",
  quantities_notes: "14 fixtures",
  needed_by_date: "2026-08-01",
  job_id: null,
  estimate_id: "est-1",
  estimate_sub_item_id: "esi-1",
  awarded_sub_id: "sub-1",
  status: "awarded",
};

describe("bid-job-assignment", () => {
  let scheduleEntries: Row[];
  let bidRequests: BidRequestAssignmentContext[];
  let inserts: Row[];
  let updates: { sql: string; args: unknown[] }[];

  beforeEach(() => {
    scheduleEntries = [];
    bidRequests = [{ ...baseBid }];
    inserts = [];
    updates = [];
  });

  it("resolveJobIdForBidRequest returns direct job_id when set", async () => {
    const env = mockEnv({ jobs: [] });
    const id = await resolveJobIdForBidRequest(env, { job_id: "job-9", estimate_id: "est-1" });
    expect(id).toBe("job-9");
  });

  it("resolveJobIdForBidRequest falls back to jobs.estimate_id lookup", async () => {
    const env = mockEnv({
      jobs: [{ id: "job-1", estimate_id: "est-1", start_date: "2026-07-15" }],
    });
    const id = await resolveJobIdForBidRequest(env, { job_id: null, estimate_id: "est-1" });
    expect(id).toBe("job-1");
  });

  it("ensureBidAwardScheduleEntry is idempotent per bid_request_id", async () => {
    scheduleEntries.push({ id: "se-existing", bid_request_id: "br-1" });
    const env = mockEnv({
      jobs: [{ id: "job-1", start_date: "2026-07-01" }],
      scheduleEntries,
      inserts,
    });

    const first = await ensureBidAwardScheduleEntry(env, baseBid, "sub-1", "job-1");
    expect(first.created).toBe(false);
    expect(first.entryId).toBe("se-existing");
    expect(inserts).toHaveLength(0);
  });

  it("assignAwardedBidToJobIfExists does nothing when no job exists yet", async () => {
    const env = mockEnv({ jobs: [], scheduleEntries, inserts });
    const result = await assignAwardedBidToJobIfExists(env, baseBid, "sub-1");
    expect(result.assigned).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("assignAwardedBidToJobIfExists creates schedule entry when job exists (award-after-conversion)", async () => {
    const env = mockEnv({
      jobs: [{ id: "job-1", estimate_id: "est-1", start_date: "2026-07-10" }],
      scheduleEntries,
      inserts,
    });

    const result = await assignAwardedBidToJobIfExists(env, { ...baseBid, job_id: "job-1" }, "sub-1");
    expect(result.assigned).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      job_id: "job-1",
      sub_id: "sub-1",
      trade_or_work: "Electrical rough-in",
      scheduled_date: "2026-08-01",
      bid_request_id: "br-1",
    });
  });

  it("syncBidRequestsOnJobConversion backfills open bids and assigns pre-awarded bids", async () => {
    bidRequests = [
      { ...baseBid, id: "br-awarded", status: "awarded", awarded_sub_id: "sub-1" },
      {
        ...baseBid,
        id: "br-open",
        status: "open",
        awarded_sub_id: null,
        title: "Plumbing",
      },
      {
        ...baseBid,
        id: "br-cancelled",
        status: "cancelled",
        awarded_sub_id: null,
        title: "HVAC",
      },
    ];

    const env = mockEnv({
      jobs: [{ id: "job-1", estimate_id: "est-1", start_date: "2026-07-01" }],
      bidRequests,
      scheduleEntries,
      inserts,
      updates,
    });

    const summary = await syncBidRequestsOnJobConversion(env, "job-1", "est-1");
    expect(summary.backfilled).toBe(3);
    expect(summary.assigned).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].bid_request_id).toBe("br-awarded");
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(bidRequests.find((b) => b.id === "br-open")?.job_id).toBe("job-1");
  });
});
