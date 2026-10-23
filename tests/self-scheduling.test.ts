import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { bookingLinkForLead } from "../src/lib/booking-link.js";
import { renderTemplateText } from "../src/lib/merge-render.js";
import { LEAD_OUTREACH_CANDIDATE_SQL } from "../src/lib/new-lead-outreach.js";
import { resolveRequiredRoles } from "../src/lib/rbac.js";
import {
  DEFAULT_RULES,
  chsBusyForEstimator,
  generateSlots,
  TOKEN_TTL_MS,
  type BusyInterval,
  type ChsEstimateVisit,
  type ChsScheduleEntry,
  type ChsWarrantyCall,
} from "../src/lib/self-scheduling.js";
import { handleEstimateRequestBookingLink } from "../src/routes/estimate-requests.js";
import { handlePublicBookingGet, handlePublicBookingPost } from "../src/routes/public-booking.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rules = { ...DEFAULT_RULES, enabled: true };

function at(iso: string): Date {
  return new Date(iso);
}

describe("open slots in Central time", () => {
  const now = at("2026-10-10T15:00:00.000Z"); // Sat 10:00 AM CDT

  it("keeps Sunday off and offers Monday at 8:00 AM CDT", () => {
    const slots = generateSlots({ now, rules, busy: [] });
    expect(slots.some((s) => s.date === "2026-10-11")).toBe(false);
    const monday = slots.find((s) => s.date === "2026-10-12" && s.label === "8:00 AM");
    expect(monday?.start).toBe("2026-10-12T13:00:00.000Z");
  });

  it("blocks the travel buffer around a busy event, including an all-day event", () => {
    const busy: BusyInterval[] = [
      { start: at("2026-10-12T15:00:00.000Z"), end: at("2026-10-12T16:00:00.000Z") },
      { start: at("2026-10-13T05:00:00.000Z"), end: at("2026-10-14T05:00:00.000Z") },
    ];
    const slots = generateSlots({ now, rules, busy });
    const monday = slots.filter((s) => s.date === "2026-10-12").map((s) => s.label);
    expect(monday).toContain("8:00 AM");
    expect(monday).not.toContain("9:00 AM");
    expect(monday).not.toContain("10:00 AM");
    expect(monday).not.toContain("11:00 AM");
    expect(monday).toContain("11:30 AM");
    expect(slots.some((s) => s.date === "2026-10-13")).toBe(false);
    expect(slots.some((s) => s.date === "2026-10-14" && s.label === "8:00 AM")).toBe(true);
  });

  it("honors minimum notice, the booking horizon, a blocked date, and the daily cap", () => {
    const morning = at("2026-10-12T12:00:00.000Z"); // 7:00 AM CDT
    const slots = generateSlots({
      now: morning,
      rules,
      busy: [],
      selfBookedByDate: { "2026-10-14": 2 },
    });
    const today = slots.filter((s) => s.date === "2026-10-12").map((s) => s.label);
    expect(today).not.toContain("8:00 AM");
    expect(today).not.toContain("10:30 AM");
    expect(today).toContain("11:00 AM");
    expect(slots.some((s) => s.date === "2026-10-26")).toBe(true);
    expect(slots.some((s) => s.date === "2026-10-27")).toBe(false);

    const blocked = generateSlots({
      now,
      rules: { ...rules, blockedDates: ["2026-10-12"] },
      busy: [],
    });
    expect(blocked.some((s) => s.date === "2026-10-12")).toBe(false);
    expect(slots.some((s) => s.date === "2026-10-14")).toBe(false);
  });

  it("uses the winter offset after daylight saving ends", () => {
    const slots = generateSlots({
      now: at("2026-11-01T16:00:00.000Z"), // Sun 10:00 AM CST
      rules,
      busy: [],
    });
    const monday = slots.find((s) => s.date === "2026-11-02" && s.label === "8:00 AM");
    expect(monday?.start).toBe("2026-11-02T14:00:00.000Z");
  });
});

interface Lead {
  id: string;
  status: string;
  appointment_date: string | null;
  appointment_time: string | null;
  property_address: string | null;
  job_type: string;
  client_id: string | null;
  booking_token: string;
  booking_token_expires_at: string;
  first_name: string | null;
  last_name: string | null;
  booking_source: string | null;
  estimator_user_id: string | null;
}

function harness(opts: {
  enabled?: string;
  leads: Lead[];
  google?: "fail";
  schedule?: Record<string, unknown>[];
  warranty?: Record<string, unknown>[];
}) {
  const leads = opts.leads.map((l) => ({ ...l }));
  const taken = new Set<string>();
  const sqlLog: string[] = [];
  const bell: string[] = [];
  let confirms = 0;
  const env = {
    APP_PUBLIC_ORIGIN: "https://client.homesolutionsar.com",
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const run = () => {
          sqlLog.push(sql);
          if (sql.includes("booking_token = ?") && sql.includes("UPDATE estimate_requests")) {
            const lead = leads.find((l) => l.id === args[3]);
            if (lead && !lead.appointment_date) {
              lead.booking_token = String(args[0]);
              lead.booking_token_expires_at = String(args[1]);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("booking_source = ?") && sql.includes("appointment_date IS NULL")) {
            const id = args.map(String).find((a) => leads.some((l) => l.id === a));
            const start = String(args[0]);
            const lead = leads.find((l) => l.id === id);
            if (!lead || lead.appointment_date || taken.has(start)) return { meta: { changes: 0 } };
            taken.add(start);
            lead.appointment_date = start;
            lead.appointment_time = String(args[1]);
            lead.status = "appointment_set";
            lead.booking_source = "customer_self_scheduled";
            lead.estimator_user_id = args[3] == null ? null : String(args[3]);
            if (args[4]) lead.property_address = String(args[4]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("lead_outreach_sequence_active = 0")) {
            return { meta: { changes: 1 } };
          }
          if (sql.includes("notification_logs")) {
            bell.push(String(args[5] ?? ""));
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        };
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          async first() {
            sqlLog.push(sql);
            if (sql.includes("FROM users WHERE email")) {
              if (args[0] === "owner@example.com") {
                return {
                  id: "owner",
                  email: "owner@example.com",
                  first_name: "Tony",
                  last_name: "C",
                  role: "owner",
                  is_active: 1,
                };
              }
              if (args[0] === "pm@example.com") {
                return {
                  id: "pm",
                  email: "pm@example.com",
                  first_name: "Pat",
                  last_name: "M",
                  role: "project_manager",
                  is_active: 1,
                };
              }
              return null;
            }
            if (sql.includes("role = 'owner'")) {
              return { id: "owner", email: "owner@example.com", first_name: "Tony", last_name: "C", phone: null };
            }
            if (sql.includes("booking_token = ?") && sql.includes("FROM estimate_requests")) {
              return leads.find((l) => l.booking_token === args[0]) ?? null;
            }
            if (sql.includes("FROM estimate_requests WHERE id = ?")) {
              return leads.find((l) => l.id === args[0]) ?? null;
            }
            if (sql.includes("SELECT appointment_date, status")) {
              const lead = leads.find((l) => l.id === args[0]);
              return lead ? { appointment_date: lead.appointment_date, status: lead.status } : null;
            }
            if (sql.includes("SELECT appointment_date FROM estimate_requests")) {
              const lead = leads.find((l) => l.id === args[0]);
              return lead ? { appointment_date: lead.appointment_date } : null;
            }
            return null;
          },
          async all() {
            sqlLog.push(sql);
            if (sql.includes("category = 'scheduling'")) {
              return { results: [{ key: "scheduling_enabled", value: opts.enabled ?? "1" }] };
            }
            if (sql.includes("notification_templates")) {
              confirms += 1;
              return { results: [] };
            }
            if (sql.includes("FROM schedule_entries")) {
              return { results: opts.schedule ?? [] };
            }
            if (sql.includes("FROM warranty_calls")) return { results: opts.warranty ?? [] };
            if (sql.includes("booking_source")) {
              return {
                results: leads
                  .filter((l) => l.appointment_date)
                  .map((l) => ({
                    id: l.id,
                    appointment_date: l.appointment_date,
                    appointment_time: l.appointment_time,
                    booking_source: l.booking_source,
                    estimator_user_id: l.estimator_user_id,
                    status: l.status,
                  })),
              };
            }
            return { results: [] };
          },
          async run() {
            return run();
          },
        };
      },
    },
  } as unknown as Env;
  return { env, leads, sqlLog, bell, confirms: () => confirms };
}

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    status: "contacted",
    appointment_date: null,
    appointment_time: null,
    property_address: "1 Oak St",
    job_type: "kitchen",
    client_id: "client-1",
    booking_token: "tok-one",
    booking_token_expires_at: "2026-11-01T00:00:00.000Z",
    first_name: "Sam",
    last_name: "Lee",
    booking_source: null,
    estimator_user_id: null,
    ...over,
  };
}

const clock = { now: at("2026-10-10T15:00:00.000Z"), freeBusy: [] as BusyInterval[] };

describe("public booking", () => {
  it("refuses requests while the master switch is off and adds no link", async () => {
    const h = harness({ enabled: "0", leads: [lead()] });
    const res = await handlePublicBookingGet(new Request("https://client.homesolutionsar.com/book/tok-one"), h.env, "tok-one", clock);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("disabled");
    expect(await bookingLinkForLead(h.env, "lead-1", clock.now)).toBe("");
    const post = await handlePublicBookingPost(
      new Request("https://client.homesolutionsar.com/api/public/book/tok-one", { method: "POST", body: "{}" }),
      h.env,
      "tok-one",
      clock,
    );
    expect(post.status).toBe(403);
  });

  it("rejects an invalid, expired, already-booked, or wrong-status link", async () => {
    const h = harness({
      leads: [
        lead(),
        lead({ id: "old", booking_token: "tok-old", booking_token_expires_at: "2026-10-01T00:00:00.000Z" }),
        lead({
          id: "set",
          booking_token: "tok-set",
          appointment_date: "2026-10-12T13:00:00.000Z",
          appointment_time: "8:00 AM",
          status: "appointment_set",
        }),
        lead({ id: "lost", booking_token: "tok-lost", status: "lost" }),
      ],
    });
    expect((await (await handlePublicBookingGet(new Request("http://x"), h.env, "missing", clock)).json()) as { state: string }).toMatchObject({ state: "invalid" });
    expect(((await (await handlePublicBookingGet(new Request("http://x"), h.env, "tok-old", clock)).json()) as { state: string }).state).toBe("expired");
    const booked = (await (await handlePublicBookingGet(new Request("http://x"), h.env, "tok-set", clock)).json()) as { state: string; message: string };
    expect(booked.state).toBe("booked");
    expect(booked.message).toContain("501-263-2050");
    expect(((await (await handlePublicBookingGet(new Request("http://x"), h.env, "tok-lost", clock)).json()) as { state: string }).state).toBe("closed");
  });

  it("books once, tells Tony in Central time, and a second submit does not book again", async () => {
    const h = harness({ leads: [lead()] });
    const get = (await (await handlePublicBookingGet(new Request("http://x"), h.env, "tok-one", clock)).json()) as {
      slots: { start: string; label: string }[];
    };
    const start = get.slots.find((s) => s.label === "8:00 AM" && s.start.startsWith("2026-10-12"))!;
    const post = () =>
      handlePublicBookingPost(
        new Request("http://x", { method: "POST", body: JSON.stringify({ start: start.start }) }),
        h.env,
        "tok-one",
        clock,
      );
    const first = await post();
    const second = await post();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.leads[0].appointment_date).toBe("2026-10-12T13:00:00.000Z");
    expect(h.leads[0].status).toBe("appointment_set");
    expect(h.leads[0].estimator_user_id).toBe("owner");
    expect(h.confirms()).toBe(1);
    expect(h.bell).toHaveLength(1);
    expect(h.bell[0]).toContain("8:00 AM");
    expect(h.bell[0]).toContain("Central");
    expect(h.bell[0]).not.toContain("1:00 PM");
    expect(h.sqlLog.some((s) => s.includes("lead_outreach_sequence_active = 0"))).toBe(true);
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/appointment_date IS NULL/);
  });

  it("rejects a second lead for the same slot and returns fresh slots", async () => {
    const h = harness({
      leads: [lead(), lead({ id: "lead-2", booking_token: "tok-two", first_name: "Pat" })],
    });
    const start = "2026-10-12T13:00:00.000Z";
    const body = JSON.stringify({ start });
    const first = await handlePublicBookingPost(new Request("http://x", { method: "POST", body }), h.env, "tok-one", clock);
    const second = await handlePublicBookingPost(new Request("http://x", { method: "POST", body }), h.env, "tok-two", clock);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    const payload = (await second.json()) as { error: string; slots: { start: string }[] };
    expect(payload.error).toBe("slot_taken");
    expect(payload.slots.some((s) => s.start === start)).toBe(false);
    expect(h.leads.filter((l) => l.appointment_date === start)).toHaveLength(1);
  });

  it("fails closed when Google cannot be read", async () => {
    const h = harness({ leads: [lead()], google: "fail" });
    const res = await handlePublicBookingGet(new Request("http://x"), h.env, "tok-one", { now: clock.now, freeBusy: "fail" });
    const body = (await res.json()) as { state: string; slots: unknown[] };
    expect(body.state).toBe("unavailable");
    expect(body.slots).toEqual([]);
  });

  it("blocks a CHS schedule entry that is not on Google", async () => {
    const h = harness({
      leads: [lead()],
      schedule: [{
        job_id: "job-1",
        job_status: "in_progress",
        scheduled_date: "2026-10-12",
        start_time: "08:00",
        end_time: "09:00",
        sub_id: null,
        assigned_to: null,
        status: "scheduled",
      }],
    });
    const body = (await (await handlePublicBookingGet(new Request("http://x"), h.env, "tok-one", clock)).json()) as {
      slots: { date: string; label: string }[];
    };
    const monday = body.slots.filter((s) => s.date === "2026-10-12").map((s) => s.label);
    expect(monday).not.toContain("8:00 AM");
    expect(monday).toContain("10:00 AM");
  });

  it("puts a booking link in the merge field only while scheduling is on", async () => {
    const off = harness({ enabled: "0", leads: [lead()] });
    expect(await bookingLinkForLead(off.env, "lead-1", clock.now)).toBe("");
    const on = harness({ enabled: "1", leads: [lead()] });
    const link = await bookingLinkForLead(on.env, "lead-1", clock.now);
    expect(link.startsWith("https://client.homesolutionsar.com/book/")).toBe(true);
    const text = renderTemplateText("Book a time: {{booking_link}}", { booking_link: "" });
    expect(text).not.toContain("http");
    expect(text).not.toContain("{{booking_link}}");
    const migration = readFileSync(join(root, "migrations/0134_customer_self_scheduling.sql"), "utf8");
    expect(migration).not.toMatch(/outreach_day1_sms/);
    const detail = readFileSync(join(root, "frontend/src/views/estimating/EstimateRequestDetail.tsx"), "utf8");
    expect(detail).toContain("Copy booking link");
    expect(detail).toContain("Self-scheduling is off.");
    expect(detail).toContain("This lead can't book a visit from a link.");
    const index = readFileSync(join(root, "src/index.ts"), "utf8");
    const allow = index.slice(index.indexOf('url.hostname === "client.homesolutionsar.com"'), index.indexOf("if (!allowed)"));
    expect(allow).toContain('p.startsWith("/book/")');
    expect(allow).toContain('p.startsWith("/api/public/book/")');
  });
});

function quiet(sqlLog: string[]) {
  expect(sqlLog.some((s) => /notification_logs|communications/i.test(s))).toBe(false);
}

function copyRequest(email: string, id = "lead-1") {
  return new Request(`https://dashboard.homesolutionsar.com/api/estimate-requests/${id}/booking-link`, {
    method: "POST",
    headers: { "Cf-Access-Authenticated-User-Email": email },
  });
}

describe("copy booking link", () => {
  it("refuses while the switch is off and writes no token", async () => {
    const h = harness({
      enabled: "0",
      leads: [lead({ booking_token: "", booking_token_expires_at: "" })],
    });
    const res = await handleEstimateRequestBookingLink(copyRequest("owner@example.com"), h.env, "lead-1", clock.now);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe("Self-scheduling is off.");
    expect(h.leads[0].booking_token).toBe("");
    expect(h.sqlLog.some((s) => s.includes("UPDATE"))).toBe(false);
    quiet(h.sqlLog);
    expect(resolveRequiredRoles("POST", "/api/estimate-requests/lead-1/booking-link")).toEqual(["owner"]);
  });

  it("returns a URL for an eligible lead and reuses the same token", async () => {
    const h = harness({
      enabled: "1",
      leads: [lead({ status: "contacted", booking_token: "", booking_token_expires_at: "" })],
    });
    const first = await handleEstimateRequestBookingLink(copyRequest("owner@example.com"), h.env, "lead-1", clock.now);
    const second = await handleEstimateRequestBookingLink(copyRequest("owner@example.com"), h.env, "lead-1", clock.now);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const url = ((await first.json()) as { url: string }).url;
    expect(((await second.json()) as { url: string }).url).toBe(url);
    expect(url).toBe(`https://client.homesolutionsar.com/book/${h.leads[0].booking_token}`);
    expect(new Date(h.leads[0].booking_token_expires_at).getTime() - clock.now.getTime()).toBe(TOKEN_TTL_MS);
    const updates = h.sqlLog.filter((s) => s.includes("UPDATE estimate_requests") && s.includes("booking_token"));
    expect(updates).toHaveLength(1);
    quiet(h.sqlLog);

    const fresh = harness({
      enabled: "1",
      leads: [lead({ id: "new-1", status: "new_request", booking_token: "", booking_token_expires_at: "" })],
    });
    const created = await handleEstimateRequestBookingLink(copyRequest("owner@example.com", "new-1"), fresh.env, "new-1", clock.now);
    expect(created.status).toBe(200);
    expect(((await created.json()) as { url: string }).url).toContain("/book/");
    quiet(fresh.sqlLog);
  });

  it("refuses an appointment-set or Lost lead and writes nothing", async () => {
    const h = harness({
      enabled: "1",
      leads: [
        lead({
          id: "set",
          status: "appointment_set",
          appointment_date: "2026-10-12T13:00:00.000Z",
          booking_token: "tok-set",
        }),
        lead({ id: "lost", status: "lost", booking_token: "tok-lost" }),
      ],
    });
    const set = await handleEstimateRequestBookingLink(copyRequest("owner@example.com", "set"), h.env, "set", clock.now);
    const lost = await handleEstimateRequestBookingLink(copyRequest("owner@example.com", "lost"), h.env, "lost", clock.now);
    expect(set.status).toBe(409);
    expect(lost.status).toBe(409);
    expect(((await set.json()) as { message: string }).message).toBe("This lead can't book a visit from a link.");
    expect(h.leads.find((l) => l.id === "set")?.booking_token).toBe("tok-set");
    expect(h.leads.find((l) => l.id === "lost")?.booking_token).toBe("tok-lost");
    expect(h.sqlLog.some((s) => s.includes("UPDATE"))).toBe(false);
    quiet(h.sqlLog);

    const pm = harness({ enabled: "1", leads: [lead({ booking_token: "", booking_token_expires_at: "" })] });
    const denied = await handleEstimateRequestBookingLink(copyRequest("pm@example.com"), pm.env, "lead-1", clock.now);
    expect(denied.status).toBe(403);
    expect(pm.leads[0].booking_token).toBe("");
    quiet(pm.sqlLog);
  });
});

const availNow = at("2026-10-10T15:00:00.000Z");
const availRules = { ...DEFAULT_RULES, enabled: true };

function dayLabels(date: string, busy: BusyInterval[]): string[] {
  return generateSlots({ now: availNow, rules: availRules, busy })
    .filter((s) => s.date === date)
    .map((s) => s.label);
}

function scheduleRow(over: Partial<ChsScheduleEntry> = {}): ChsScheduleEntry {
  return {
    jobId: "job-1",
    jobStatus: "in_progress",
    date: "2026-10-14",
    startTime: "08:00",
    endTime: "09:00",
    subId: null,
    assignedTo: null,
    entryStatus: "scheduled",
    ...over,
  };
}

function busyFor(schedule: ChsScheduleEntry[], extra?: { warranty?: ChsWarrantyCall[]; visits?: ChsEstimateVisit[] }) {
  return chsBusyForEstimator({
    estimatorId: "owner",
    rules: availRules,
    schedule,
    warranty: extra?.warranty ?? [],
    visits: extra?.visits ?? [],
  }).busy;
}

describe("estimator availability", () => {
  const firstDay = scheduleRow({ date: "2026-10-12", startTime: "13:00", endTime: "14:00", subId: null, assignedTo: "owner" });

  it("does not block a crew entry on an owner-assigned job", () => {
    const crew = scheduleRow({ date: "2026-10-14", subId: "sub-1", assignedTo: "owner" });
    const labels = dayLabels("2026-10-14", busyFor([firstDay, crew]));
    expect(labels).toContain("8:00 AM");
    expect(labels).toContain("10:00 AM");
  });

  it("blocks an entry with no sub when the job is assigned to the owner, including the buffer", () => {
    const own = scheduleRow({ date: "2026-10-14", subId: null, assignedTo: "owner" });
    const labels = dayLabels("2026-10-14", busyFor([firstDay, own]));
    expect(labels).not.toContain("8:00 AM");
    expect(labels).not.toContain("9:00 AM");
    expect(labels).toContain("10:00 AM");
  });

  it("does not block an entry with no sub when the job is assigned to someone else", () => {
    const other = scheduleRow({ date: "2026-10-14", subId: null, assignedTo: "pm" });
    expect(dayLabels("2026-10-14", busyFor([firstDay, other]))).toContain("8:00 AM");
  });

  it("blocks an unassigned entry", () => {
    const open = scheduleRow({ date: "2026-10-14", subId: null, assignedTo: null });
    expect(dayLabels("2026-10-14", busyFor([firstDay, open]))).not.toContain("8:00 AM");
  });

  it("blocks the first day even for a crew entry, with times and without", () => {
    const timed = scheduleRow({
      date: "2026-10-12",
      startTime: "08:00",
      endTime: "09:00",
      subId: "sub-1",
      assignedTo: "owner",
    });
    const timedLabels = dayLabels("2026-10-12", busyFor([timed]));
    expect(timedLabels).not.toContain("8:00 AM");
    expect(timedLabels).toContain("10:00 AM");

    const allDay = scheduleRow({
      jobId: "job-2",
      date: "2026-10-13",
      startTime: null,
      endTime: null,
      subId: "sub-1",
      assignedTo: "pm",
    });
    expect(dayLabels("2026-10-13", busyFor([allDay]))).toEqual([]);
    expect(dayLabels("2026-10-14", busyFor([allDay]))).toContain("8:00 AM");

    const afternoon = scheduleRow({
      date: "2026-10-12",
      startTime: "15:00",
      endTime: "16:00",
      subId: "sub-2",
      assignedTo: "pm",
    });
    const both = dayLabels("2026-10-12", busyFor([timed, afternoon]));
    expect(both).not.toContain("8:00 AM");
    expect(both).not.toContain("3:00 PM");
    expect(both).toContain("10:00 AM");
  });

  it("does not block a complete or closed job", () => {
    for (const status of ["complete", "closed", "cancelled", "archived"]) {
      const row = scheduleRow({ jobStatus: status, date: "2026-10-12", subId: null, assignedTo: null });
      expect(dayLabels("2026-10-12", busyFor([row]))).toContain("8:00 AM");
    }
    const late = scheduleRow({ jobStatus: "late", date: "2026-10-12", subId: null, assignedTo: null });
    expect(dayLabels("2026-10-12", busyFor([late]))).not.toContain("8:00 AM");
  });

  it("does not block a warranty call assigned to a sub", () => {
    const call: ChsWarrantyCall = {
      jobStatus: "in_progress",
      date: "2026-10-12",
      endTime: "09:00",
      assignedTo: "owner",
      assignedSubId: "sub-1",
      status: "scheduled",
    };
    expect(dayLabels("2026-10-12", busyFor([], { warranty: [call] }))).toContain("8:00 AM");
  });

  it("blocks an estimate visit whose estimator is null", () => {
    const visit: ChsEstimateVisit = {
      id: "other",
      appointmentDate: "2026-10-12T13:00:00.000Z",
      appointmentTime: "8:00 AM",
      estimatorUserId: null,
      status: "appointment_set",
      bookingSource: null,
    };
    const labels = dayLabels("2026-10-12", busyFor([], { visits: [visit] }));
    expect(labels).not.toContain("8:00 AM");
    expect(labels).toContain("10:00 AM");
  });

  it("still blocks Google busy time", () => {
    const labels = dayLabels("2026-10-12", [
      { start: at("2026-10-12T13:00:00.000Z"), end: at("2026-10-12T14:00:00.000Z") },
    ]);
    expect(labels).not.toContain("8:00 AM");
    expect(labels).toContain("10:00 AM");
  });
});
