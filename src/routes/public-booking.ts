/**
 * Public, token-gated estimate booking.
 * GET/POST /api/public/book/:token
 *
 * Availability is a live Google free/busy read of the primary calendar plus
 * CHS schedule entries, warranty calls, and other estimate visits. Event
 * titles are never returned. If Google cannot be read, the page fails closed.
 */

import type { Env } from "../env.js";
import { getValidAccessToken, GcalNotConnectedError } from "../lib/google-calendar-auth.js";
import { loadSchedulingRules } from "../lib/booking-link.js";
import { setAppointmentFromBooking } from "./estimate-requests.js";
import {
  BOOKABLE_STATUSES,
  BOOKING_PHONE,
  BOOKING_SOURCE,
  type BusyInterval,
  type OpenSlot,
  type SchedulingRules,
  appointmentToBusy,
  centralDateKey,
  formatCentralWhen,
  formatSlotLabel,
  generateSlots,
  parseClock,
  rowToBusy,
} from "../lib/self-scheduling.js";

export interface BookingClock {
  now?: Date;
  /** Test seam. Production reads Google. "fail" is the fail-closed state. */
  freeBusy?: BusyInterval[] | "fail";
}

interface LeadRow {
  id: string;
  status: string;
  appointment_date: string | null;
  appointment_time: string | null;
  property_address: string | null;
  job_type: string;
  client_id: string | null;
  booking_token: string | null;
  booking_token_expires_at: string | null;
  first_name: string | null;
  last_name: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function loadLead(env: Env, token: string): Promise<LeadRow | null> {
  return env.DB.prepare(
    `SELECT er.id, er.status, er.appointment_date, er.appointment_time, er.property_address,
            er.job_type, er.client_id, er.booking_token, er.booking_token_expires_at,
            c.first_name, c.last_name
       FROM estimate_requests er
       LEFT JOIN clients c ON c.id = er.client_id
      WHERE er.booking_token = ?`,
  )
    .bind(token)
    .first<LeadRow>();
}

function expired(lead: LeadRow, now: Date): boolean {
  if (!lead.booking_token_expires_at) return true;
  const t = new Date(lead.booking_token_expires_at).getTime();
  return Number.isNaN(t) || t <= now.getTime();
}

function displayName(lead: LeadRow): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim();
  return name || "A customer";
}

function confirmed(lead: LeadRow) {
  const start = lead.appointment_date ? new Date(lead.appointment_date) : null;
  const label =
    lead.appointment_time?.trim() ||
    (start && !Number.isNaN(start.getTime()) && lead.appointment_date?.includes("T")
      ? formatSlotLabel(start)
      : "");
  return {
    state: "booked" as const,
    first_name: lead.first_name ?? "",
    job_type: lead.job_type,
    address: lead.property_address ?? "",
    appointment: {
      start: lead.appointment_date,
      label,
      when: start && !Number.isNaN(start.getTime()) ? formatCentralWhen(start) : label,
    },
    phone: BOOKING_PHONE,
    message: "Need a different time? Call or text " + BOOKING_PHONE + ".",
  };
}

async function readGoogleBusy(env: Env, timeMin: string, timeMax: string): Promise<BusyInterval[]> {
  let token: string;
  try {
    token = await getValidAccessToken(env);
  } catch (err) {
    if (err instanceof GcalNotConnectedError) throw new Error("gcal_unavailable");
    throw err;
  }
  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
  });
  if (!resp.ok) throw new Error("gcal_unavailable");
  const data = (await resp.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
  };
  const cal = data.calendars?.primary;
  if (!cal || (cal.errors && cal.errors.length > 0)) throw new Error("gcal_unavailable");
  return (cal.busy ?? []).flatMap((b) => {
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    return [{ start, end }];
  });
}

async function loadChsBusy(
  env: Env,
  rules: SchedulingRules,
  leadId: string,
  fromDate: string,
  toDate: string,
): Promise<{ busy: BusyInterval[]; selfBookedByDate: Record<string, number> }> {
  const busy: BusyInterval[] = [];
  const schedule = await env.DB.prepare(
    `SELECT scheduled_date, start_time, end_time, status
       FROM schedule_entries
      WHERE scheduled_date >= ? AND scheduled_date <= ?
        AND COALESCE(status, 'scheduled') NOT IN ('cancelled', 'canceled')`,
  )
    .bind(fromDate, toDate + "T23:59:59")
    .all<{ scheduled_date: string; start_time: string | null; end_time: string | null; status: string | null }>();
  for (const row of schedule.results ?? []) {
    const interval = rowToBusy(row.scheduled_date, row.start_time, row.end_time, rules);
    if (interval) busy.push(interval);
  }

  const warranty = await env.DB.prepare(
    `SELECT scheduled_date, scheduled_end, status
       FROM warranty_calls
      WHERE scheduled_date IS NOT NULL
        AND substr(scheduled_date, 1, 10) >= ?
        AND substr(scheduled_date, 1, 10) <= ?
        AND status IN ('open', 'scheduled')`,
  )
    .bind(fromDate, toDate)
    .all<{ scheduled_date: string; scheduled_end: string | null }>();
  for (const row of warranty.results ?? []) {
    const interval = rowToBusy(row.scheduled_date, null, row.scheduled_end, rules);
    if (interval) busy.push(interval);
  }

  const appointments = await env.DB.prepare(
    `SELECT id, appointment_date, appointment_time, booking_source
       FROM estimate_requests
      WHERE appointment_date IS NOT NULL
        AND status NOT IN ('lost', 'declined')
        AND substr(appointment_date, 1, 10) >= ?
        AND substr(appointment_date, 1, 10) <= ?`,
  )
    .bind(fromDate, toDate)
    .all<{ id: string; appointment_date: string; appointment_time: string | null; booking_source: string | null }>();

  const selfBookedByDate: Record<string, number> = {};
  for (const row of appointments.results ?? []) {
    if (row.id === leadId) continue;
    if (row.booking_source === BOOKING_SOURCE) {
      const key = row.appointment_date.includes("T")
        ? centralDateKey(new Date(row.appointment_date))
        : row.appointment_date.slice(0, 10);
      selfBookedByDate[key] = (selfBookedByDate[key] ?? 0) + 1;
    }
    if (row.appointment_date.includes("T")) {
      const interval = appointmentToBusy(row.appointment_date, rules.visitMinutes);
      if (interval) busy.push(interval);
    } else {
      const startMin = parseClock(row.appointment_time) ?? rules.startMin;
      const endMin = Math.min(rules.endMin, startMin + rules.visitMinutes);
      const interval = rowToBusy(row.appointment_date, minutesToHm(startMin), minutesToHm(endMin), rules);
      if (interval) busy.push(interval);
    }
  }
  return { busy, selfBookedByDate };
}

function minutesToHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function openSlots(
  env: Env,
  lead: LeadRow,
  rules: SchedulingRules,
  now: Date,
  clock?: BookingClock,
): Promise<OpenSlot[] | "unavailable"> {
  const today = centralDateKey(now);
  const horizon = new Date(now.getTime() + (rules.horizonDays + 1) * 86_400_000);
  const toDate = centralDateKey(horizon);
  let google: BusyInterval[];
  if (clock?.freeBusy === "fail") return "unavailable";
  if (clock?.freeBusy) {
    google = clock.freeBusy;
  } else {
    try {
      google = await readGoogleBusy(env, now.toISOString(), horizon.toISOString());
    } catch {
      return "unavailable";
    }
  }
  const chs = await loadChsBusy(env, rules, lead.id, today, toDate);
  return generateSlots({
    now,
    rules,
    busy: [...google, ...chs.busy],
    selfBookedByDate: chs.selfBookedByDate,
  });
}

function slotPayload(lead: LeadRow, slots: OpenSlot[], rules: SchedulingRules) {
  const address = (lead.property_address ?? "").trim();
  return {
    state: slots.length ? "open" : "none",
    first_name: lead.first_name ?? "",
    job_type: lead.job_type,
    address,
    needs_address: address.length === 0,
    slots,
    phone: BOOKING_PHONE,
    visit_minutes: rules.visitMinutes,
    timezone: "America/Chicago",
  };
}

export async function handlePublicBookingGet(
  _request: Request,
  env: Env,
  token: string,
  clock?: BookingClock,
): Promise<Response> {
  const now = clock?.now ?? new Date();
  const rules = await loadSchedulingRules(env);
  if (!rules.enabled) {
    return json({ state: "disabled", phone: BOOKING_PHONE, slots: [] });
  }
  const lead = await loadLead(env, token);
  if (!lead) return json({ state: "invalid", phone: BOOKING_PHONE, slots: [] }, 404);
  if (expired(lead, now)) return json({ state: "expired", phone: BOOKING_PHONE, slots: [] });
  if (lead.appointment_date) return json(confirmed(lead));
  if (!(BOOKABLE_STATUSES as readonly string[]).includes(lead.status)) {
    return json({ state: "closed", phone: BOOKING_PHONE, slots: [] });
  }
  const slots = await openSlots(env, lead, rules, now, clock);
  if (slots === "unavailable") {
    return json({
      state: "unavailable",
      phone: BOOKING_PHONE,
      slots: [],
      message: "Please call or text us to pick a time.",
    });
  }
  return json(slotPayload(lead, slots, rules));
}

export async function handlePublicBookingPost(
  request: Request,
  env: Env,
  token: string,
  clock?: BookingClock,
): Promise<Response> {
  const now = clock?.now ?? new Date();
  const rules = await loadSchedulingRules(env);
  if (!rules.enabled) return json({ state: "disabled", phone: BOOKING_PHONE, slots: [] }, 403);

  const lead = await loadLead(env, token);
  if (!lead) return json({ state: "invalid", phone: BOOKING_PHONE, slots: [] }, 404);
  if (expired(lead, now)) return json({ state: "expired", phone: BOOKING_PHONE, slots: [] });

  let body: { start?: string; address?: string } = {};
  try {
    body = (await request.json()) as { start?: string; address?: string };
  } catch {
    return json({ error: "bad_request", phone: BOOKING_PHONE }, 400);
  }
  const start = (body.start ?? "").trim();

  if (lead.appointment_date) {
    if (start && lead.appointment_date === start) return json(confirmed(lead));
    return json(confirmed(lead));
  }
  if (!(BOOKABLE_STATUSES as readonly string[]).includes(lead.status)) {
    return json({ state: "closed", phone: BOOKING_PHONE, slots: [] }, 409);
  }

  const slots = await openSlots(env, lead, rules, now, clock);
  if (slots === "unavailable") {
    return json({
      state: "unavailable",
      phone: BOOKING_PHONE,
      slots: [],
      message: "Please call or text us to pick a time.",
    }, 503);
  }

  const chosen = slots.find((s) => s.start === start);
  if (!chosen) {
    return json({ error: "slot_taken", state: "taken", slots, phone: BOOKING_PHONE }, 409);
  }

  const address = (body.address ?? "").trim();
  if (!(lead.property_address ?? "").trim() && !address) {
    return json({ error: "address_required", slots, phone: BOOKING_PHONE }, 400);
  }

  const outcome = await setAppointmentFromBooking(env, lead.id, {
    appointmentDate: chosen.start,
    appointmentTime: chosen.label,
    propertyAddress: address || null,
    visitMinutes: rules.visitMinutes,
    fromStatus: lead.status,
    clientId: lead.client_id,
    clientName: displayName(lead),
    jobType: lead.job_type,
    address: address || (lead.property_address ?? ""),
  });

  if (outcome === "conflict") {
    const fresh = await openSlots(env, lead, rules, now, clock);
    return json({
      error: "slot_taken",
      state: "taken",
      slots: fresh === "unavailable" ? [] : fresh,
      phone: BOOKING_PHONE,
    }, 409);
  }

  const saved = await loadLead(env, token);
  return json(confirmed(saved ?? { ...lead, appointment_date: chosen.start, appointment_time: chosen.label }));
}
