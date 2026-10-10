import { afterEach, describe, expect, it } from "vitest";
import { CHS_TIMEZONE } from "../src/lib/central-send-window.js";
import {
  GCAL_EVENTS_SCOPE,
  GCAL_READONLY_SCOPE,
} from "../src/lib/google-calendar-auth.js";
import {
  buildEstimateEvent,
  buildScheduleEvent,
  buildWarrantyEvent,
  calendarWriteStatus,
  mirrorSource,
  queueCalendarMirror,
  retryFailedCalendarWrites,
  scrubPrivate,
  setCalendarWriteEnabled,
} from "../src/lib/google-calendar-writeback.js";
import { chsBusyForEstimator, DEFAULT_RULES, generateSlots } from "../src/lib/self-scheduling.js";

const NOW = new Date("2026-10-10T15:00:00.000Z");

interface Link {
  id: string;
  source_type: string;
  source_id: string;
  google_event_id: string | null;
  last_synced_hash: string | null;
  last_synced_at: string | null;
  status: string;
  last_error: string | null;
}

function harness(opts: {
  enabled?: string;
  scopes?: string;
  connected?: boolean;
  expiry?: string;
  estimate?: Record<string, unknown> | null;
  schedule?: Record<string, unknown> | null;
  warranty?: Record<string, unknown> | null;
}) {
  const links: Link[] = [];
  const settings = new Map<string, string>([
    ["google_calendar_write_enabled", opts.enabled ?? "1"],
    ["scheduling_visit_minutes", "60"],
  ]);
  const bells: string[] = [];
  const conn = {
    status: opts.connected === false ? "disconnected" : "connected",
    access_token: "access-plain",
    refresh_token: "refresh-plain",
    token_expiry: opts.expiry ?? "2099-01-01T00:00:00.000Z",
    configuration: JSON.stringify({ scopes: opts.scopes ?? `${GCAL_READONLY_SCOPE} ${GCAL_EVENTS_SCOPE}` }),
    last_error: null as string | null,
  };
  const env = {
    DB: {
      prepare(sql: string) {
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
            if (sql.includes("FROM integration_connections WHERE service")) {
              return conn.status === "disconnected"
                ? null
                : { ...conn, id: "google_calendar", last_sync: null };
            }
            if (sql.includes("FROM google_calendar_event_links") && sql.includes("source_type = ?")) {
              return links.find((l) => l.source_type === args[0] && l.source_id === args[1]) ?? null;
            }
            if (sql.includes("COUNT(*) AS n FROM google_calendar_event_links")) {
              return { n: links.filter((l) => l.status === "failed").length };
            }
            if (sql.includes("FROM estimate_requests")) return opts.estimate ?? null;
            if (sql.includes("FROM schedule_entries")) return opts.schedule ?? null;
            if (sql.includes("FROM warranty_calls")) return opts.warranty ?? null;
            return null;
          },
          async all() {
            if (sql.includes("status IN ('failed', 'pending')")) {
              return {
                results: links
                  .filter((l) => l.status === "failed" || l.status === "pending")
                  .map((l) => ({ source_type: l.source_type, source_id: l.source_id })),
              };
            }
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("INSERT INTO google_calendar_event_links")) {
              links.push({
                id: String(args[0]),
                source_type: String(args[1]),
                source_id: String(args[2]),
                google_event_id: (args[3] as string | null) ?? null,
                last_synced_hash: (args[4] as string | null) ?? null,
                last_synced_at: (args[5] as string | null) ?? null,
                status: String(args[6]),
                last_error: (args[7] as string | null) ?? null,
              });
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE google_calendar_event_links")) {
              const link = links.find((l) => l.id === args[7]);
              if (link) {
                link.google_event_id = (args[0] as string | null) ?? null;
                link.last_synced_hash = (args[1] as string | null) ?? null;
                if (args[2] === "synced") link.last_synced_at = String(args[3]);
                link.status = String(args[4]);
                link.last_error = (args[5] as string | null) ?? null;
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE integration_connections SET status = 'error'")) {
              conn.status = "error";
              conn.last_error = String(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO system_settings")) {
              settings.set(String(args[0]), String(args[1]));
              return { meta: { changes: 1 } };
            }
            if (sql.includes("notification_logs")) {
              bells.push(String(args[7] ?? args[5] ?? ""));
              return { meta: { changes: 1 } };
            }
            if (sql.includes("FROM users WHERE role = 'owner'") || sql.includes("role = 'owner'")) {
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        };
        return bound;
      },
    },
  };
  return { env: env as never, links, bells, settings };
}

function googleFetch(handler: (url: string, method: string, body: string | undefined) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body: raw ? JSON.parse(raw) : null });
    return handler(url, method, raw);
  };
  return { fetchImpl, calls };
}

const estimate = {
  id: "lead-1",
  status: "appointment_set",
  appointment_date: "2026-10-12T13:00:00.000Z",
  job_type: "kitchen",
  property_address: "10 Oak St",
  property_city: "Conway",
  property_state: "AR",
  property_zip: "72032",
  first_name: "Ada",
  last_name: "Lane",
  client_name: null,
  notes: "call 501-555-0199 about the price $400",
};

afterEach(() => {
  /* fetch stubs are per test */
});

describe("event bodies", () => {
  it("makes an estimate visit busy, tagged, and in Central time, with no phone or notes", () => {
    const body = buildEstimateEvent({
      id: "lead-1",
      client: "Ada Lane",
      jobType: "kitchen",
      address: "10 Oak St",
      start: new Date("2026-10-12T13:00:00.000Z"),
      visitMinutes: 60,
    });
    expect(body.transparency).toBe("opaque");
    expect(body.extendedProperties.private).toEqual({
      chs: "1",
      chs_source_type: "estimate_request",
      chs_source_id: "lead-1",
    });
    expect(body.start).toEqual({ dateTime: "2026-10-12T08:00:00", timeZone: CHS_TIMEZONE });
    expect(body.end).toEqual({ dateTime: "2026-10-12T09:00:00", timeZone: CHS_TIMEZONE });
    expect(body.summary).toBe("Estimate: Ada Lane");
    const text = JSON.stringify(body);
    expect(text).not.toContain("555");
    expect(text).not.toContain("notes");
    expect(text).not.toContain("$400");
    expect(body.description).toContain("https://dashboard.homesolutionsar.com/app/estimating/lead-1");
  });

  it("makes a timed job day free and an untimed day all-day", () => {
    const timed = buildScheduleEvent({
      id: "e1",
      jobId: "j1",
      jobTitle: "Kitchen",
      client: "Ada Lane",
      address: "10 Oak St",
      work: "Cabinets",
      crew: "Ace Electric",
      date: "2026-10-13",
      startMin: 8 * 60,
      endMin: 12 * 60,
    });
    expect(timed.transparency).toBe("transparent");
    expect(timed.start).toEqual({ dateTime: "2026-10-13T08:00:00", timeZone: CHS_TIMEZONE });
    expect(timed.description).toContain("Crew: Ace Electric");
    expect(timed.description).not.toContain("501");

    const allDay = buildScheduleEvent({
      ...{
        id: "e2",
        jobId: "j1",
        jobTitle: "Kitchen",
        client: "Ada Lane",
        address: "10 Oak St",
        work: "Overview",
        crew: null,
        date: "2026-10-13",
        startMin: null,
        endMin: null,
      },
    });
    expect(allDay.transparency).toBe("transparent");
    expect(allDay.start).toEqual({ date: "2026-10-13" });
    expect(allDay.end).toEqual({ date: "2026-10-14" });
  });

  it("makes a warranty call free", () => {
    const body = buildWarrantyEvent({
      id: "w1",
      jobId: "j1",
      client: "Ada Lane",
      title: "Leak",
      address: "10 Oak St",
      crew: null,
      date: "2026-10-13",
      startMin: null,
      endMin: null,
    });
    expect(body.transparency).toBe("transparent");
    expect(body.summary).toBe("Warranty: Ada Lane");
    expect(JSON.stringify(body)).not.toContain("555");
  });

  it("strips a phone number that slipped into a title", () => {
    expect(scrubPrivate("Ada 501-555-0199 Lane")).toBe("Ada Lane");
  });
});

describe("mirror", () => {
  it("creates once and skips an unchanged item", async () => {
    const h = harness({ estimate });
    const g = googleFetch(() => new Response(JSON.stringify({ id: "evt-1" }), { status: 200 }));
    const first = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    const second = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(first).toBe("synced");
    expect(second).toBe("unchanged");
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].method).toBe("POST");
    expect(String(g.calls[0].url)).toContain("sendUpdates=none");
    expect(h.links[0].google_event_id).toBe("evt-1");
  });

  it("patches when the visit time changes", async () => {
    const row = { ...estimate };
    const h = harness({ estimate: row });
    const g = googleFetch((url, method) =>
      new Response(JSON.stringify({ id: method === "POST" ? "evt-1" : "evt-1" }), { status: 200 }),
    );
    await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    row.appointment_date = "2026-10-12T18:00:00.000Z";
    const again = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(again).toBe("synced");
    expect(g.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
  });

  it("does not create a past item, and deletes one that moves into the past", async () => {
    const row = { ...estimate, appointment_date: "2026-10-01T13:00:00.000Z" };
    const h = harness({ estimate: row });
    const g = googleFetch((_url, method) =>
      method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: "evt-1" }), { status: 200 }),
    );
    const skipped = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(skipped).toBe("unchanged");
    expect(g.calls).toHaveLength(0);

    row.appointment_date = "2026-10-12T13:00:00.000Z";
    await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    row.appointment_date = "2026-10-01T13:00:00.000Z";
    const removed = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(removed).toBe("deleted");
    expect(g.calls.at(-1)?.method).toBe("DELETE");
  });

  it("records a Google 500 and does not throw", async () => {
    const h = harness({ estimate });
    const g = googleFetch(() => new Response("nope", { status: 500 }));
    await expect(mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW })).resolves.toBe(
      "failed",
    );
    expect(h.links[0].status).toBe("failed");
  });

  it("marks a 410 on an unchanged item deleted and does not create another", async () => {
    const h = harness({ estimate });
    const g = googleFetch((_url, method) => {
      if (method === "PATCH") return new Response("gone", { status: 410 });
      return new Response(JSON.stringify({ id: "evt-1" }), { status: 200 });
    });
    await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    h.links[0].status = "failed";
    const gone = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(gone).toBe("deleted");
    const again = await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    expect(again).toBe("unchanged");
    expect(g.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
  });

  it("does not call Google when the switch is off or the connection is read-only", async () => {
    const off = harness({ enabled: "0", estimate });
    const readOnly = harness({ scopes: GCAL_READONLY_SCOPE, estimate });
    const g = googleFetch(() => {
      throw new Error("google was called");
    });
    await expect(mirrorSource(off.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW })).resolves.toBe(
      "skipped",
    );
    await expect(
      mirrorSource(readOnly.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW }),
    ).resolves.toBe("skipped");
    expect(g.calls).toHaveLength(0);
  });

  it("records invalid_grant without throwing", async () => {
    const h = harness({ estimate, expiry: "2000-01-01T00:00:00.000Z" });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), {
        status: 400,
      })) as typeof fetch;
    try {
      await expect(mirrorSource(h.env, "estimate_request", "lead-1", { now: NOW })).resolves.toBe("failed");
    } finally {
      globalThis.fetch = original;
    }
    expect(h.links[0]?.status).toBe("failed");
    expect(h.links[0]?.last_error ?? "").not.toMatch(/ya29\./);
  });

  it("retries a failed item and rings the owner once", async () => {
    const h = harness({ estimate });
    let fail = true;
    const g = googleFetch(() =>
      fail ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ id: "evt-9" }), { status: 200 }),
    );
    await mirrorSource(h.env, "estimate_request", "lead-1", { fetch: g.fetchImpl, now: NOW });
    const first = await retryFailedCalendarWrites(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(first.notified).toBe(false);
    const second = await retryFailedCalendarWrites(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(second.notified).toBe(true);
    const third = await retryFailedCalendarWrites(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(third.notified).toBe(false);
    fail = false;
    const fixed = await retryFailedCalendarWrites(h.env, { fetch: g.fetchImpl, now: NOW });
    expect(fixed.synced).toBe(1);
    expect(h.links[0].status).toBe("synced");
  });

  it("records a network failure and does not throw", async () => {
    const h = harness({ estimate });
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    await expect(mirrorSource(h.env, "estimate_request", "lead-1", { fetch: fetchImpl, now: NOW })).resolves.toBe(
      "failed",
    );
    expect(h.links[0]?.status).toBe("failed");
    expect(h.links[0]?.last_error ?? "").not.toContain("ya29.");
  });

  it("shows Needs reconnect for a read-only connection and refuses to turn the switch on", async () => {
    const h = harness({ scopes: GCAL_READONLY_SCOPE });
    const status = await calendarWriteStatus(h.env);
    expect(status.calendar_sync).toBe("needs_reconnect");
    expect(status.write_scope).toBe(false);
    await expect(setCalendarWriteEnabled(h.env, true)).resolves.toEqual({ ok: false, error: "needs_reconnect" });
  });

  it("swallows a database error so the CHS action still finishes", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              throw new Error("no such table");
            },
            async run() {
              throw new Error("no such table");
            },
          };
        },
      },
    };
    await expect(queueCalendarMirror(env as never, "schedule_entry", "e1")).resolves.toBeUndefined();
  });
});

describe("availability stays the CHS rules", () => {
  const rules = { ...DEFAULT_RULES, enabled: true };

  it("does not drop a slot for a crew day that was mirrored as free", () => {
    const crew = buildScheduleEvent({
      id: "crew",
      jobId: "j1",
      jobTitle: "Kitchen",
      client: "Ada",
      address: "10 Oak",
      work: "Cabinets",
      crew: "Ace",
      date: "2026-10-13",
      startMin: 13 * 60,
      endMin: 15 * 60,
    });
    expect(crew.transparency).toBe("transparent");
    const chs = chsBusyForEstimator({
      estimatorId: "owner",
      rules,
      schedule: [
        {
          jobId: "j1",
          jobStatus: "in_progress",
          date: "2026-10-12",
          startTime: null,
          endTime: null,
          subId: "sub",
          assignedTo: "owner",
        },
        {
          jobId: "j1",
          jobStatus: "in_progress",
          date: "2026-10-13",
          startTime: "13:00",
          endTime: "15:00",
          subId: "sub",
          assignedTo: "owner",
        },
      ],
      warranty: [],
      visits: [],
    });
    const slots = generateSlots({ now: NOW, rules, busy: chs.busy });
    expect(slots.some((s) => s.date === "2026-10-13" && s.label === "1:00 PM")).toBe(true);
  });

  it("blocks both the CHS visit and a time the visit was dragged to on Google", () => {
    const chs = chsBusyForEstimator({
      estimatorId: "owner",
      rules,
      schedule: [],
      warranty: [],
      visits: [
        {
          id: "lead-1",
          appointmentDate: "2026-10-12T13:00:00.000Z",
          appointmentTime: "8:00 AM",
          estimatorUserId: null,
          status: "appointment_set",
          bookingSource: null,
        },
      ],
    });
    const dragged = [{ start: new Date("2026-10-12T20:00:00.000Z"), end: new Date("2026-10-12T21:00:00.000Z") }];
    const slots = generateSlots({ now: NOW, rules, busy: [...chs.busy, ...dragged] });
    const monday = slots.filter((s) => s.date === "2026-10-12").map((s) => s.label);
    expect(monday).not.toContain("8:00 AM");
    expect(monday).not.toContain("3:00 PM");
    expect(monday).toContain("10:00 AM");
  });
});
