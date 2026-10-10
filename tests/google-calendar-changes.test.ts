import { describe, expect, it } from "vitest";
import { GCAL_EVENTS_SCOPE, GCAL_READONLY_SCOPE } from "../src/lib/google-calendar-auth.js";
import { applyCalendarChange, pollGoogleCalendarChanges } from "../src/lib/google-calendar-changes.js";

const NOW = new Date("2026-10-10T15:00:00.000Z");
const SCOPES = `${GCAL_READONLY_SCOPE} ${GCAL_EVENTS_SCOPE}`;

interface Pending {
  id: string;
  source_type: string;
  source_id: string;
  change_kind: string;
  google_start: string | null;
  google_end: string | null;
  google_all_day: number;
  summary_label: string | null;
  when_label: string | null;
  status: string;
  bell_sent: number;
}

function harness(opts: {
  changes?: string;
  write?: string;
  scopes?: string;
  estimateStatus?: string;
  schedule?: boolean;
}) {
  const settings = new Map<string, string>([
    ["google_calendar_changes_enabled", opts.changes ?? "1"],
    ["google_calendar_write_enabled", opts.write ?? "0"],
    ["scheduling_visit_minutes", "60"],
  ]);
  const pending: Pending[] = [];
  const bells: string[] = [];
  const sqlLog: string[] = [];
  const links = [
    {
      id: "link-1",
      source_type: "estimate_request",
      source_id: "lead-1",
      google_event_id: "evt-1",
      last_synced_hash: "old",
      status: "synced",
    },
  ];
  const owner = {
    id: "owner-1",
    email: "tony@homesolutionsar.com",
    first_name: "Tony",
    last_name: "Columbus",
    role: "owner",
    is_active: 1,
    phone: null,
  };
  const estimate = {
    id: "lead-1",
    status: opts.estimateStatus ?? "appointment_set",
    appointment_date: "2026-10-12T13:00:00.000Z",
    appointment_time: "8:00 AM",
    job_type: "kitchen",
    property_address: "10 Oak St",
    property_city: "Conway",
    property_state: "AR",
    property_zip: "72032",
    first_name: "Ada",
    last_name: "Lane",
    client_name: null,
    client_id: "client-1",
    c_first: "Ada",
    c_last: "Lane",
  };
  const entry = {
    id: "entry-1",
    job_id: "job-1",
    scheduled_date: "2026-10-13",
    trade_or_work: "Cabinets",
    sub_id: "sub-1",
    start_time: "08:00",
    end_time: "12:00",
    notes: null,
    notification_sent: 0,
    status: "scheduled",
    entry_type: "job_task",
    created_at: "2026-10-01T00:00:00.000Z",
    job_status: "in_progress",
    job_title: "Kitchen",
    property_address: "10 Oak St",
    property_city: "Conway",
    property_state: "AR",
    property_zip: "72032",
    first_name: "Ada",
    last_name: "Lane",
    client_name: null,
    crew: "Ace Electric",
  };
  const conn = {
    id: "google_calendar",
    status: "connected",
    access_token: "access-plain",
    refresh_token: "refresh-plain",
    token_expiry: "2099-01-01T00:00:00.000Z",
    configuration: JSON.stringify({ scopes: opts.scopes ?? SCOPES }),
    last_sync: null,
    last_error: null,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        sqlLog.push(sql);
        let args: unknown[] = [];
        const bound = {
          bind(...next: unknown[]) {
            args = next;
            return bound;
          },
          async first() {
            if (sql.includes("FROM system_settings WHERE key")) {
              const value = settings.get(String(args[0]));
              return value == null ? null : { value };
            }
            if (sql.includes("FROM integration_connections")) return conn;
            if (sql.includes("FROM users")) return owner;
            if (sql.includes("FROM google_calendar_pending_changes") && sql.includes("WHERE id = ?")) {
              return pending.find((row) => row.id === args[0] && row.status === "pending") ?? null;
            }
            if (sql.includes("FROM google_calendar_pending_changes") && sql.includes("source_type = ?")) {
              return (
                pending.find((row) => row.source_type === args[0] && row.source_id === args[1] && row.status === "pending") ??
                null
              );
            }
            if (sql.includes("FROM google_calendar_event_links") && sql.includes("source_type = ?")) {
              return links.find((row) => row.source_type === args[0] && row.source_id === args[1]) ?? null;
            }
            if (sql.includes("SELECT id, status FROM estimate_requests")) {
              return { id: estimate.id, status: estimate.status };
            }
            if (sql.includes("FROM estimate_requests")) return estimate;
            if (sql.includes("FROM schedule_entries") && !opts.schedule && sql.includes("worker_type")) return null;
            if (sql.includes("FROM schedule_entries")) return opts.schedule === false ? null : entry;
            return null;
          },
          async all() {
            if (sql.includes("FROM google_calendar_pending_changes")) {
              return { results: pending.filter((row) => row.status === "pending") };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO google_calendar_pending_changes")) {
              pending.push({
                id: String(args[0]),
                source_type: String(args[1]),
                source_id: String(args[2]),
                change_kind: String(args[3]),
                google_start: (args[4] as string | null) ?? null,
                google_end: (args[5] as string | null) ?? null,
                google_all_day: Number(args[6] ?? 0),
                summary_label: (args[7] as string | null) ?? null,
                when_label: (args[8] as string | null) ?? null,
                status: "pending",
                bell_sent: 0,
              });
            } else if (sql.includes("SET bell_sent = 1")) {
              const row = pending.find((item) => item.id === args[0]);
              if (row) row.bell_sent = 1;
            } else if (sql.includes("SET change_kind = ?")) {
              const row = pending.find((item) => item.id === args[6]);
              if (row) {
                row.change_kind = String(args[0]);
                row.google_start = (args[1] as string | null) ?? null;
                row.google_end = (args[2] as string | null) ?? null;
                row.when_label = (args[5] as string | null) ?? null;
              }
            } else if (sql.includes("SET status = 'ignored'") && sql.includes("source_type = ?")) {
              for (const row of pending) {
                if (row.source_type === args[0] && row.source_id === args[1] && row.status === "pending") {
                  row.status = "ignored";
                }
              }
            } else if (sql.includes("SET status = ?") && sql.includes("google_calendar_pending_changes")) {
              const row = pending.find((item) => item.id === args[1]);
              if (row) row.status = String(args[0]);
            } else if (sql.includes("notification_logs")) {
              bells.push(String(args[5] ?? ""));
            } else if (sql.includes("INSERT INTO system_settings")) {
              settings.set(String(args[0]), String(args[1]));
            } else if (sql.startsWith("UPDATE estimate_requests SET") && sql.includes("appointment_date")) {
              estimate.appointment_date = (args[0] as string | null) ?? null;
              estimate.status = args.includes("appointment_set") ? "appointment_set" : estimate.status;
            }
            return { meta: { changes: 1 } };
          },
        };
        return bound;
      },
    },
  };
  return { env: env as never, pending, bells, sqlLog, settings, estimate };
}

function listResponse(items: unknown[]) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const moved = {
  id: "evt-1",
  status: "confirmed",
  updated: "2026-10-10T15:05:00.000Z",
  start: { dateTime: "2026-10-12T15:00:00-05:00", timeZone: "America/Chicago" },
  end: { dateTime: "2026-10-12T16:00:00-05:00", timeZone: "America/Chicago" },
  extendedProperties: {
    private: { chs: "1", chs_source_type: "estimate_request", chs_source_id: "lead-1" },
  },
};

describe("google change poll", () => {
  it("opens one pending change and one bell, then does not bell again", async () => {
    const h = harness({});
    const g = listResponse([
      moved,
      { id: "other", status: "confirmed", start: { dateTime: "2026-10-12T18:00:00-05:00" }, end: { dateTime: "2026-10-12T19:00:00-05:00" } },
      {
        id: "old",
        status: "confirmed",
        updated: "2026-10-01T15:00:00.000Z",
        start: { date: "2026-10-01" },
        end: { date: "2026-10-02" },
        extendedProperties: { private: { chs: "1", chs_source_type: "estimate_request", chs_source_id: "lead-1" } },
      },
    ]);
    const first = await pollGoogleCalendarChanges(h.env, { fetch: g.fetchImpl, now: NOW });
    const second = await pollGoogleCalendarChanges(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(first.opened).toBe(1);
    expect(second.opened).toBe(0);
    expect(h.pending.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(h.pending[0].change_kind).toBe("moved");
    expect(h.pending[0].summary_label).toBe("Estimate for Ada Lane");
    expect(h.bells).toHaveLength(1);
    expect(h.bells[0]).toContain("Apply to CHS?");
    expect(h.bells[0]).not.toContain("555");
    expect(g.calls).toHaveLength(2);
    expect(g.calls[0]).toContain("privateExtendedProperty=chs");
    expect(g.calls[0]).toContain("showDeleted=true");
  });

  it("records a deleted Google event as cancel-or-restore", async () => {
    const h = harness({});
    const g = listResponse([{ ...moved, status: "cancelled" }]);
    await pollGoogleCalendarChanges(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(h.pending[0].change_kind).toBe("deleted");
    expect(h.bells[0]).toContain("removed on Google");
  });

  it("makes no Google call when change alerts are off or the scope is read-only", async () => {
    const off = harness({ changes: "0" });
    const readOnly = harness({ scopes: GCAL_READONLY_SCOPE });
    const g = listResponse([moved]);
    const fetchImpl: typeof fetch = async () => {
      throw new Error("google was called");
    };
    await expect(pollGoogleCalendarChanges(off.env, { fetch: fetchImpl, now: NOW })).resolves.toMatchObject({
      skipped: true,
    });
    await expect(pollGoogleCalendarChanges(readOnly.env, { fetch: fetchImpl, now: NOW })).resolves.toMatchObject({
      skipped: true,
    });
    expect(g.calls).toHaveLength(0);
  });
});

describe("review actions", () => {
  it("applies a move through the appointment save and can skip the customer text", async () => {
    const loud = harness({ estimateStatus: "new_request" });
    loud.pending.push(seedPending("moved"));
    const loudResult = await applyCalendarChange(loud.env, loud.pending[0].id, "apply", { now: NOW });
    expect(loudResult).toEqual({ ok: true });
    expect(loud.estimate.appointment_date).toBe("2026-10-12T20:00:00.000Z");
    expect(loud.estimate.status).toBe("appointment_set");
    expect(loud.sqlLog.some((sql) => sql.includes("notification_templates"))).toBe(true);
    expect(loud.pending[0].status).toBe("applied");

    const quiet = harness({ estimateStatus: "new_request" });
    quiet.pending.push(seedPending("moved"));
    const quietResult = await applyCalendarChange(quiet.env, quiet.pending[0].id, "apply_silent", { now: NOW });
    expect(quietResult).toEqual({ ok: true });
    expect(quiet.estimate.appointment_date).toBe("2026-10-12T20:00:00.000Z");
    expect(quiet.sqlLog.some((sql) => sql.includes("notification_templates"))).toBe(false);
  });

  it("cancels a removed visit by clearing the appointment", async () => {
    const h = harness({ estimateStatus: "appointment_set" });
    h.pending.push(seedPending("deleted"));
    const result = await applyCalendarChange(h.env, h.pending[0].id, "cancel", { now: NOW });
    expect(result).toEqual({ ok: true });
    expect(h.estimate.appointment_date).toBeNull();
    expect(h.pending[0].status).toBe("applied");
  });

  it("ignores a move by pushing the CHS time back to Google", async () => {
    const h = harness({ write: "1" });
    h.pending.push(seedPending("moved"));
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    };
    const result = await applyCalendarChange(h.env, h.pending[0].id, "ignore", { fetch: fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["PATCH"]);
    expect(h.pending[0].status).toBe("ignored");
    expect(h.estimate.appointment_date).toBe("2026-10-12T13:00:00.000Z");
  });

  it("recreates a deleted Google event when the owner ignores it", async () => {
    const h = harness({ write: "1" });
    h.pending.push(seedPending("deleted"));
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "PATCH") return new Response("gone", { status: 410 });
      return new Response(JSON.stringify({ id: "evt-2" }), { status: 200 });
    };
    const result = await applyCalendarChange(h.env, h.pending[0].id, "ignore", { fetch: fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["PATCH", "POST"]);
    expect(h.pending[0].status).toBe("ignored");
  });

  it("skips the crew text when a schedule move is applied without texting", async () => {
    const loud = harness({ schedule: true });
    loud.pending.push({ ...seedPending("moved"), id: "pend-sched", source_type: "schedule_entry", source_id: "entry-1" });
    await applyCalendarChange(loud.env, "pend-sched", "apply", { now: NOW });
    expect(loud.sqlLog.some((sql) => sql.includes("worker_type"))).toBe(true);

    const quiet = harness({ schedule: true });
    quiet.pending.push({
      ...seedPending("moved"),
      id: "pend-sched-2",
      source_type: "schedule_entry",
      source_id: "entry-1",
    });
    await applyCalendarChange(quiet.env, "pend-sched-2", "apply_silent", { now: NOW });
    expect(quiet.sqlLog.some((sql) => sql.includes("worker_type"))).toBe(false);
    expect(quiet.pending[0].status).toBe("applied");
  });
});

function seedPending(kind: "moved" | "deleted"): Pending {
  return {
    id: "pend-1",
    source_type: "estimate_request",
    source_id: "lead-1",
    change_kind: kind,
    google_start: "2026-10-12T20:00:00.000Z",
    google_end: "2026-10-12T21:00:00.000Z",
    google_all_day: 0,
    summary_label: "Estimate for Ada Lane",
    when_label: "Mon, Oct 12, 3:00 PM",
    status: "pending",
    bell_sent: 1,
  };
}
