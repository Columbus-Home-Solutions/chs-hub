/**
 * Day-rate Labor Tracker.
 *
 *   GET    /api/labor/workers
 *   GET    /api/labor/jobs
 *   GET    /api/labor/jobs/:id/entries
 *   GET    /api/labor/week?start=YYYY-MM-DD
 *   GET    /api/labor/week/:start/statements
 *   POST   /api/labor/entries
 *   PUT    /api/labor/entries/:id
 *   DELETE /api/labor/entries/:id          soft delete
 *   GET    /api/labor/weeks
 *   GET    /api/labor/payable
 *   GET    /api/labor/statements
 *   GET    /api/labor/workers/:id/ledger
 *   POST   /api/labor/batches/pay          chosen days, any closed weeks
 *   POST   /api/labor/batches/:week_start/pay
 *
 * Paying a week inserts real expenses through the same columns as a hand-entered
 * labor expense (insertFullExpense): expense_type=labor, pushed_to_qbo=0,
 * tax_category=labor, no estimate alignment (unallocated), no lien waiver.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { notTestClientExists } from "../lib/non-test-client.js";
import {
  POST_DEPOSIT_JOB_STATUSES,
  addDays,
  centralDate,
  daysLabel,
  isIsoDate,
  isWeekClosed,
  lineTotal,
  nextPayFriday,
  payDateForWeek,
  round2,
  weekBounds,
  weekPayState,
} from "../../shared/labor-week.js";

const ROLES = ["owner", "project_manager"] as const;

const RATE_MESSAGE = "Set a day rate for this worker or enter one";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function err(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function workerName(row: {
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
}): string {
  return (
    row.company_name?.trim() ||
    row.company?.trim() ||
    row.contact_name?.trim() ||
    row.primary_contact?.trim() ||
    "Labor"
  );
}

function jobLabel(row: {
  job_number: number | null;
  title: string | null;
  property_address: string | null;
}): string {
  const num = row.job_number != null ? String(row.job_number) : "";
  const title = row.title?.trim() || "Job";
  const addr = row.property_address?.trim();
  const head = num ? `${num} ${title}` : title;
  return addr ? `${head} — ${addr}` : head;
}

interface WorkerRow {
  id: string;
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  day_rate: number | null;
  is_active: number | null;
  worker_type: string | null;
}

async function loadWorker(env: Env, id: string): Promise<WorkerRow | null> {
  return env.DB.prepare(
    `SELECT id, company_name, company, contact_name, primary_contact, day_rate, is_active, worker_type
       FROM subcontractors WHERE id = ?`,
  )
    .bind(id)
    .first<WorkerRow>();
}

function activeDayRate(worker: WorkerRow | null): boolean {
  if (!worker) return false;
  if (worker.worker_type !== "day_rate_labor") return false;
  return worker.is_active == null || worker.is_active === 1;
}

async function jobEligible(env: Env, jobId: string): Promise<boolean> {
  const placeholders = POST_DEPOSIT_JOB_STATUSES.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT id FROM jobs
      WHERE id = ?
        AND status IN (${placeholders})
        AND ${notTestClientExists("client_id")}`,
  )
    .bind(jobId, ...POST_DEPOSIT_JOB_STATUSES)
    .first<{ id: string }>();
  return Boolean(row);
}

interface EntryInput {
  job_id: string;
  work_date: string;
  days: number;
  notes: string | null;
}

function parseEntries(body: Record<string, unknown>): EntryInput[] | string {
  const rawList = Array.isArray(body.entries) ? body.entries : null;
  const sources = rawList ?? [body];
  const out: EntryInput[] = [];
  for (const raw of sources) {
    if (typeof raw !== "object" || raw == null) return "Each entry needs a job, date, and days";
    const rec = raw as Record<string, unknown>;
    const jobId = str(rec.job_id);
    const workDate = str(rec.work_date);
    const days = Number(rec.days);
    if (!jobId || !workDate || !isIsoDate(workDate)) return "Each entry needs a job and a YYYY-MM-DD date";
    if (days !== 0.5 && days !== 1) return "Days must be 1 or 0.5";
    out.push({ job_id: jobId, work_date: workDate, days, notes: str(rec.notes) });
  }
  if (out.length === 0) return "Add at least one day";
  return out;
}

async function audit(
  env: Env,
  email: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, 'labor_entry', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), email, action, entityId, JSON.stringify(details))
    .run();
}

export async function handleLaborWorkers(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const rows = (
    await env.DB.prepare(
      `SELECT id, company_name, company, contact_name, primary_contact, day_rate
         FROM subcontractors
        WHERE worker_type = 'day_rate_labor'
          AND COALESCE(is_active, 1) = 1
        ORDER BY COALESCE(company_name, company, contact_name, primary_contact)`,
    ).all<WorkerRow>()
  ).results ?? [];
  return json({
    workers: rows.map((row) => ({
      id: row.id,
      name: workerName(row),
      day_rate: row.day_rate,
    })),
  });
}

export async function handleLaborJobs(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const placeholders = POST_DEPOSIT_JOB_STATUSES.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(
      `SELECT id, job_number, title, property_address, status
         FROM jobs
        WHERE status IN (${placeholders})
          AND ${notTestClientExists("client_id")}
        ORDER BY job_number DESC`,
    )
      .bind(...POST_DEPOSIT_JOB_STATUSES)
      .all<{
        id: string;
        job_number: number | null;
        title: string | null;
        property_address: string | null;
        status: string;
      }>()
  ).results ?? [];
  return json({
    jobs: rows.map((row) => ({
      id: row.id,
      job_number: row.job_number,
      title: row.title,
      address: row.property_address,
      label: jobLabel(row),
      status: row.status,
    })),
  });
}

interface StoredEntry {
  id: string;
  sub_id: string;
  job_id: string;
  work_date: string;
  days: number;
  day_rate: number;
  notes: string | null;
  batch_id: string | null;
  expense_id: string | null;
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  worker_day_rate: number | null;
  job_number: number | null;
  title: string | null;
  property_address: string | null;
}

/** Non-removed days. Soft-deleted rows stay for the dispute ledger and are left out of totals. */
const ACTIVE_ENTRY = "le.deleted_at IS NULL";

const ENTRY_SELECT = `le.id, le.sub_id, le.job_id, le.work_date, le.days, le.day_rate, le.notes,
  le.batch_id, le.expense_id,
  s.company_name, s.company, s.contact_name, s.primary_contact, s.day_rate AS worker_day_rate,
  j.job_number, j.title, j.property_address`;

interface ExpenseMatch {
  id: string;
  sub_id: string;
  job_id: string;
  amount: number;
  expense_type: string | null;
  incurred_date: string | null;
  vendor: string | null;
  description: string | null;
}

/** Any non-void expense for that worker and job in the window, whatever expense_type. Newest first. */
export const OVERLAP_EXPENSE_SQL = `SELECT id, sub_id, job_id, amount, expense_type,
            vendor, description,
            COALESCE(incurred_date, substr(incurred_at, 1, 10)) AS incurred_date
       FROM expenses
      WHERE COALESCE(is_active, 1) = 1
        AND sub_id IS NOT NULL
        AND job_id IS NOT NULL
        AND COALESCE(incurred_date, substr(incurred_at, 1, 10)) >= ?
        AND COALESCE(incurred_date, substr(incurred_at, 1, 10)) <= ?
      ORDER BY created_at DESC`;

function shapeEntry(row: StoredEntry) {
  const paid = Boolean(row.batch_id || row.expense_id);
  return {
    id: row.id,
    sub_id: row.sub_id,
    job_id: row.job_id,
    work_date: row.work_date,
    days: row.days,
    day_rate: row.day_rate,
    line_total: lineTotal(row.days, row.day_rate),
    notes: row.notes,
    paid,
    batch_id: row.batch_id,
    expense_id: row.expense_id,
    worker_name: workerName(row),
    job_number: row.job_number,
    job_title: row.title,
    address: row.property_address,
    job_label: jobLabel({
      job_number: row.job_number,
      title: row.title,
      property_address: row.property_address,
    }),
  };
}

async function entriesBetween(env: Env, start: string, end: string): Promise<StoredEntry[]> {
  return (
    (
      await env.DB.prepare(
        `SELECT ${ENTRY_SELECT}
           FROM labor_entries le
           JOIN subcontractors s ON s.id = le.sub_id
           JOIN jobs j ON j.id = le.job_id
          WHERE le.work_date >= ? AND le.work_date <= ?
            AND ${ACTIVE_ENTRY}
          ORDER BY COALESCE(s.company_name, s.company, s.contact_name, s.primary_contact),
                   le.work_date, j.job_number`,
      )
        .bind(start, end)
        .all<StoredEntry>()
    ).results ?? []
  );
}

async function overlapMatches(
  env: Env,
  start: string,
  payDate: string,
): Promise<Map<string, ExpenseMatch[]>> {
  const rows = (
    await env.DB.prepare(OVERLAP_EXPENSE_SQL)
      .bind(start, payDate)
      .all<ExpenseMatch>()
  ).results ?? [];
  const map = new Map<string, ExpenseMatch[]>();
  for (const row of rows) {
    const key = groupKey(row.sub_id, row.job_id);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

/** Pay-dialog matches. Material, permit, equipment, vehicle, office, and insurance stay off the list. */
const PAYABLE_MATCH_TYPES = new Set(["labor", "subcontractor", "other"]);

function isPayableMatchType(expenseType: string | null | undefined): boolean {
  return expenseType != null && PAYABLE_MATCH_TYPES.has(expenseType);
}

/** Every expense whose date falls inside this group's days through payday, newest first. */
function matchesInWindow(rows: ExpenseMatch[] | undefined, minDate: string, payDate: string): ExpenseMatch[] {
  if (!rows) return [];
  return rows.filter((row) => row.incurred_date != null && row.incurred_date >= minDate && row.incurred_date <= payDate);
}

/** Payable matches only: labor, subcontractor, or other, still newest first. */
function payableMatchesInWindow(rows: ExpenseMatch[] | undefined, minDate: string, payDate: string): ExpenseMatch[] {
  return matchesInWindow(rows, minDate, payDate).filter((row) => isPayableMatchType(row.expense_type));
}

/** Newest expense whose date falls inside this group's unpaid days through payday. */
function matchInWindow(rows: ExpenseMatch[] | undefined, minDate: string, payDate: string): ExpenseMatch | null {
  return matchesInWindow(rows, minDate, payDate)[0] ?? null;
}

function groupKey(subId: string, jobId: string): string {
  return `${subId}|${jobId}`;
}

export async function handleLaborWeek(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const url = new URL(request.url);
  const startParam = url.searchParams.get("start")?.trim() || centralDate();
  if (!isIsoDate(startParam)) return err(400, "invalid_date", "start must be YYYY-MM-DD");
  return json(await buildWeek(env, startParam));
}

async function buildWeek(env: Env, anyDate: string) {
  const { start, end } = weekBounds(anyDate);
  const today = centralDate();
  const payDate = payDateForWeek(end);
  const closed = isWeekClosed(end, today);
  const rows = await entriesBetween(env, start, end);
  const dupes = await overlapMatches(env, start, payDate);
  const batch = await env.DB.prepare(
    `SELECT id, week_start, week_end, pay_date, total, paid_at, paid_by
       FROM labor_pay_batches WHERE week_start = ?`,
  )
    .bind(start)
    .first<{
      id: string;
      week_start: string;
      week_end: string;
      pay_date: string;
      total: number;
      paid_at: string | null;
      paid_by: string | null;
    }>();

  const byWorker = new Map<string, ReturnType<typeof shapeEntry>[]>();
  for (const row of rows) {
    const shaped = shapeEntry(row);
    const list = byWorker.get(row.sub_id) ?? [];
    list.push(shaped);
    byWorker.set(row.sub_id, list);
  }

  const workers = [...byWorker.entries()].map(([subId, entries]) => {
    const days = round2(entries.reduce((sum, entry) => sum + entry.days, 0));
    const total = round2(entries.reduce((sum, entry) => sum + entry.line_total, 0));
    const accrued = round2(
      entries.filter((entry) => !entry.expense_id).reduce((sum, entry) => sum + entry.line_total, 0),
    );
    return {
      sub_id: subId,
      name: entries[0]?.worker_name ?? "Labor",
      day_rate: rows.find((row) => row.sub_id === subId)?.worker_day_rate ?? entries[0]?.day_rate ?? null,
      days,
      total,
      accrued,
      entries,
    };
  });

  const groups = new Map<
    string,
    { sub_id: string; job_id: string; name: string; job_label: string; days: number; total: number }
  >();
  for (const row of rows) {
    if (row.expense_id) continue;
    const key = groupKey(row.sub_id, row.job_id);
    const current = groups.get(key) ?? {
      sub_id: row.sub_id,
      job_id: row.job_id,
      name: workerName(row),
      job_label: jobLabel(row),
      days: 0,
      total: 0,
    };
    current.days = round2(current.days + row.days);
    current.total = round2(current.total + lineTotal(row.days, row.day_rate));
    groups.set(key, current);
  }

  const groupList = [...groups.values()].map((group) => {
    const match = matchInWindow(dupes.get(groupKey(group.sub_id, group.job_id)), start, payDate);
    return {
      ...group,
      possible_duplicate: Boolean(match),
      match: match
        ? {
            expense_id: match.id,
            amount: match.amount,
            expense_type: match.expense_type,
            incurred_date: match.incurred_date,
          }
        : null,
    };
  });

  const weekDays = round2(workers.reduce((sum, worker) => sum + worker.days, 0));
  const accruedUnpaid = round2(workers.reduce((sum, worker) => sum + worker.accrued, 0));

  return {
    week_start: start,
    week_end: end,
    today,
    closed,
    pay_date: payDate,
    batch: batch ?? null,
    totals: { days: weekDays, accrued_unpaid: accruedUnpaid, workers: workers.length },
    workers,
    groups: groupList,
  };
}

export async function handleLaborStatements(
  request: Request,
  env: Env,
  start: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  if (!isIsoDate(start)) return err(400, "invalid_date", "Week start must be YYYY-MM-DD");
  const week = await buildWeek(env, start);
  const url = new URL(request.url);
  const only = url.searchParams.get("sub_id")?.trim();
  const workers = only ? week.workers.filter((worker) => worker.sub_id === only) : week.workers;
  return json({
    company_name: "Columbus Home Solutions",
    week_start: week.week_start,
    week_end: week.week_end,
    pay_date: week.batch?.pay_date ?? week.pay_date,
    paid: Boolean(week.batch?.paid_at),
    statements: workers.map((worker) => ({
      sub_id: worker.sub_id,
      name: worker.name,
      day_rate: worker.day_rate,
      days: worker.days,
      total: worker.total,
      lines: worker.entries.map((entry) => ({
        work_date: entry.work_date,
        job_label: entry.job_label,
        days: entry.days,
        day_rate: entry.day_rate,
        amount: entry.line_total,
      })),
    })),
  });
}

export async function handleLaborJobEntries(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const rows = (
    (
      await env.DB.prepare(
        `SELECT ${ENTRY_SELECT}
           FROM labor_entries le
           JOIN subcontractors s ON s.id = le.sub_id
           JOIN jobs j ON j.id = le.job_id
          WHERE le.job_id = ?
            AND ${ACTIVE_ENTRY}
          ORDER BY le.work_date, COALESCE(s.company_name, s.company, s.contact_name, s.primary_contact)`,
      )
        .bind(jobId)
        .all<StoredEntry>()
    ).results ?? []
  ).map(shapeEntry);

  const byWorker = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWorker.get(row.sub_id) ?? [];
    list.push(row);
    byWorker.set(row.sub_id, list);
  }
  const workers = [...byWorker.entries()].map(([, entries]) => {
    const accrued = round2(
      entries.filter((entry) => !entry.expense_id).reduce((sum, entry) => sum + entry.line_total, 0),
    );
    return {
      sub_id: entries[0].sub_id,
      name: entries[0].worker_name,
      days: round2(entries.reduce((sum, entry) => sum + entry.days, 0)),
      cost: round2(entries.reduce((sum, entry) => sum + entry.line_total, 0)),
      accrued,
      entries,
    };
  });
  return json({
    job_id: jobId,
    accrued_total: round2(workers.reduce((sum, worker) => sum + worker.accrued, 0)),
    workers,
    entries: rows,
  });
}

export async function handleLaborEntryCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  const body = await readJson(request);
  if (!body) return err(400, "invalid_json", "Expected JSON");
  const subId = str(body.sub_id);
  if (!subId) return err(400, "sub_required", "Choose a worker");
  const worker = await loadWorker(env, subId);
  if (!activeDayRate(worker)) {
    return err(422, "not_day_rate", "Choose an active day-rate worker");
  }
  const parsed = parseEntries(body);
  if (typeof parsed === "string") return err(422, "validation_error", parsed);

  const override = body.day_rate == null || body.day_rate === "" ? null : Number(body.day_rate);
  if (override != null && (!Number.isFinite(override) || override <= 0)) {
    return err(422, "validation_error", "Day rate must be a positive number");
  }
  const rate = override ?? worker!.day_rate;
  if (rate == null || !Number.isFinite(Number(rate)) || Number(rate) <= 0) {
    return err(422, "day_rate_required", RATE_MESSAGE);
  }
  const dayRate = Number(rate);

  for (const entry of parsed) {
    if (!(await jobEligible(env, entry.job_id))) {
      return err(422, "job_not_eligible", "That job is not open for labor logging");
    }
  }

  const created: string[] = [];
  for (const entry of parsed) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO labor_entries
         (id, sub_id, job_id, work_date, days, day_rate, notes, entered_via, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?)`,
    )
      .bind(id, subId, entry.job_id, entry.work_date, entry.days, dayRate, entry.notes, user.email)
      .run();
    created.push(id);
  }

  const warnings: string[] = [];
  const dates = [...new Set(parsed.map((entry) => entry.work_date))];
  for (const date of dates) {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(days), 0) AS days FROM labor_entries
        WHERE sub_id = ? AND work_date = ? AND deleted_at IS NULL`,
    )
      .bind(subId, date)
      .first<{ days: number }>();
    if ((row?.days ?? 0) > 1) {
      warnings.push(
        `${workerName(worker!)} is logged for more than 1 day on ${date}. The days were saved.`,
      );
    }
  }

  return json({ ids: created, warnings }, 201);
}

export async function handleLaborEntryUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  const existing = await env.DB.prepare(
    `SELECT id, batch_id, expense_id, sub_id, job_id, work_date, days, day_rate, notes, deleted_at
       FROM labor_entries WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      batch_id: string | null;
      expense_id: string | null;
      sub_id: string;
      job_id: string;
      work_date: string;
      days: number;
      day_rate: number;
      notes: string | null;
      deleted_at: string | null;
    }>();
  if (!existing) return err(404, "not_found", "Labor entry not found");
  if (existing.deleted_at) return err(409, "entry_removed", "This day was removed and can't be edited.");
  if (existing.batch_id || existing.expense_id) {
    return err(409, "entry_paid", "This day is in a paid batch and can't be edited.");
  }
  const body = await readJson(request);
  if (!body) return err(400, "invalid_json", "Expected JSON");

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("job_id" in body) {
    const jobId = str(body.job_id);
    if (!jobId || !(await jobEligible(env, jobId))) {
      return err(422, "job_not_eligible", "That job is not open for labor logging");
    }
    sets.push("job_id = ?");
    binds.push(jobId);
  }
  if ("work_date" in body) {
    const workDate = str(body.work_date);
    if (!workDate || !isIsoDate(workDate)) return err(422, "validation_error", "Date must be YYYY-MM-DD");
    sets.push("work_date = ?");
    binds.push(workDate);
  }
  if ("days" in body) {
    const days = Number(body.days);
    if (days !== 0.5 && days !== 1) return err(422, "validation_error", "Days must be 1 or 0.5");
    sets.push("days = ?");
    binds.push(days);
  }
  if ("day_rate" in body) {
    const rate = Number(body.day_rate);
    if (!Number.isFinite(rate) || rate <= 0) return err(422, "validation_error", RATE_MESSAGE);
    sets.push("day_rate = ?");
    binds.push(rate);
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(str(body.notes));
  }
  if (sets.length === 0) return err(400, "no_changes", "Nothing to update");
  sets.push("updated_at = datetime('now')");
  sets.push("updated_by = ?");
  binds.push(user.email);
  binds.push(id);
  await env.DB.prepare(`UPDATE labor_entries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await audit(env, user.email, "labor_entry_updated", id, {
    before: {
      job_id: existing.job_id,
      work_date: existing.work_date,
      days: existing.days,
      day_rate: existing.day_rate,
      notes: existing.notes,
    },
    after: body,
  });

  const warnings: string[] = [];
  const dateRow = await env.DB.prepare(
    `SELECT work_date, sub_id FROM labor_entries WHERE id = ?`,
  )
    .bind(id)
    .first<{ work_date: string; sub_id: string }>();
  if (dateRow) {
    const sum = await env.DB.prepare(
      `SELECT COALESCE(SUM(days), 0) AS days FROM labor_entries
        WHERE sub_id = ? AND work_date = ? AND deleted_at IS NULL`,
    )
      .bind(dateRow.sub_id, dateRow.work_date)
      .first<{ days: number }>();
    if ((sum?.days ?? 0) > 1) {
      warnings.push(`This worker is logged for more than 1 day on ${dateRow.work_date}. The change was saved.`);
    }
  }
  return json({ ok: true, warnings });
}

export async function handleLaborEntryDelete(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  const existing = await env.DB.prepare(
    `SELECT id, batch_id, expense_id, sub_id, job_id, work_date, days, day_rate, deleted_at
       FROM labor_entries WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      batch_id: string | null;
      expense_id: string | null;
      sub_id: string;
      job_id: string;
      work_date: string;
      days: number;
      day_rate: number;
      deleted_at: string | null;
    }>();
  if (!existing) return err(404, "not_found", "Labor entry not found");
  if (existing.deleted_at) return json({ ok: true, deleted: true, id });
  if (existing.batch_id || existing.expense_id) {
    return err(409, "entry_paid", "This day is in a paid batch and can't be removed.");
  }
  const body = await readJson(request);
  const reason = body ? str(body.delete_reason) : null;
  await env.DB.prepare(
    `UPDATE labor_entries
        SET deleted_at = datetime('now'), deleted_by = ?, delete_reason = ?
      WHERE id = ? AND batch_id IS NULL AND expense_id IS NULL AND deleted_at IS NULL`,
  )
    .bind(user.email, reason, id)
    .run();
  await audit(env, user.email, "labor_entry_removed", id, { ...existing, delete_reason: reason });
  return json({ ok: true, deleted: true, id });
}

interface PayEntry {
  id: string;
  sub_id: string;
  job_id: string;
  days: number;
  day_rate: number;
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  job_number: number | null;
  title: string | null;
}

export async function handleLaborBatchPay(
  request: Request,
  env: Env,
  weekStart: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  if (!isIsoDate(weekStart)) return err(400, "invalid_date", "Week start must be YYYY-MM-DD");
  const { start, end } = weekBounds(weekStart);
  if (start !== weekStart) return err(400, "invalid_date", "week_start must be the Monday");
  const today = centralDate();
  if (!isWeekClosed(end, today)) {
    return err(409, "week_open", "This week is still open. It can be paid after Sunday.");
  }

  const existing = await env.DB.prepare(
    `SELECT id, week_start, week_end, pay_date, total, paid_at, paid_by
       FROM labor_pay_batches WHERE week_start = ?`,
  )
    .bind(start)
    .first();
  if (existing) return json({ batch: existing, created: false, expenses: [] });

  const body = (await readJson(request)) ?? {};
  const payDateRaw = str(body.pay_date) ?? payDateForWeek(end);
  if (!isIsoDate(payDateRaw)) return err(422, "validation_error", "Pay date must be YYYY-MM-DD");
  const skip = new Set<string>();
  if (Array.isArray(body.skip)) {
    for (const item of body.skip) {
      if (typeof item !== "object" || item == null) continue;
      const rec = item as Record<string, unknown>;
      const subId = str(rec.sub_id);
      const jobId = str(rec.job_id);
      if (subId && jobId) skip.add(groupKey(subId, jobId));
    }
  }

  const unpaid = (
    (
      await env.DB.prepare(
        `SELECT le.id, le.sub_id, le.job_id, le.days, le.day_rate,
                s.company_name, s.company, s.contact_name, s.primary_contact,
                j.job_number, j.title
           FROM labor_entries le
           JOIN subcontractors s ON s.id = le.sub_id
           JOIN jobs j ON j.id = le.job_id
          WHERE le.work_date >= ? AND le.work_date <= ?
            AND le.batch_id IS NULL AND le.expense_id IS NULL
            AND le.deleted_at IS NULL`,
      )
        .bind(start, end)
        .all<PayEntry>()
    ).results ?? []
  );
  if (unpaid.length === 0) return err(400, "nothing_to_pay", "This week has no unpaid labor days.");

  const existingExpense = new Map<string, string>();
  if (skip.size > 0) {
    const matches = (
      await env.DB.prepare(OVERLAP_EXPENSE_SQL)
        .bind(start, payDateRaw)
        .all<{ id: string; sub_id: string; job_id: string }>()
    ).results ?? [];
    for (const match of matches) {
      const key = groupKey(match.sub_id, match.job_id);
      if (!existingExpense.has(key)) existingExpense.set(key, match.id);
    }
  }

  const included = new Map<string, PayEntry[]>();
  const skipped = new Map<string, PayEntry[]>();
  for (const entry of unpaid) {
    const key = groupKey(entry.sub_id, entry.job_id);
    const bucket = skip.has(key) ? skipped : included;
    const list = bucket.get(key) ?? [];
    list.push(entry);
    bucket.set(key, list);
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expenseStatements: D1PreparedStatement[] = [];
  const entryStatements: D1PreparedStatement[] = [];
  const expenseIds: { sub_id: string; job_id: string; expense_id: string; amount: number }[] = [];
  let batchTotal = 0;

  for (const entries of included.values()) {
    const sample = entries[0];
    const name = workerName(sample);
    const days = round2(entries.reduce((sum, entry) => sum + entry.days, 0));
    const amount = round2(entries.reduce((sum, entry) => sum + lineTotal(entry.days, entry.day_rate), 0));
    batchTotal = round2(batchTotal + amount);
    const expenseId = crypto.randomUUID();
    const description = `Day labor — ${name} — ${daysLabel(days)} days, wk ${start}–${end}`;
    expenseStatements.push(
      env.DB.prepare(
        `INSERT INTO expenses
           (id, job_id, amount, description, incurred_at, incurred_date, synced_at, vendor,
            expense_type, estimate_line_item_id, tax_category, is_1099_reportable, sub_id,
            receipt_photo_id, receipt_r2_key, entered_via, is_active, pushed_to_qbo, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'labor', NULL, 'labor', 1, ?, NULL, NULL, 'auto', 1, 0, ?, ?)`,
      ).bind(
        expenseId,
        sample.job_id,
        amount,
        description,
        payDateRaw,
        payDateRaw,
        now,
        name,
        sample.sub_id,
        now,
        user.email,
      ),
    );
    for (const entry of entries) {
      entryStatements.push(
        env.DB.prepare(
          `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL`,
        ).bind(batchId, expenseId, entry.id),
      );
    }
    expenseIds.push({ sub_id: sample.sub_id, job_id: sample.job_id, expense_id: expenseId, amount });
  }

  for (const [key, entries] of skipped) {
    const linked = existingExpense.get(key) ?? null;
    for (const entry of entries) {
      entryStatements.push(
        env.DB.prepare(
          `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL`,
        ).bind(batchId, linked, entry.id),
      );
    }
  }

  const statements: D1PreparedStatement[] = [
    ...expenseStatements,
    env.DB.prepare(
      `INSERT INTO labor_pay_batches (id, week_start, week_end, pay_date, total, paid_at, paid_by)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
    ).bind(batchId, start, end, payDateRaw, batchTotal, user.email),
    ...entryStatements,
    env.DB.prepare(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       VALUES (?, ?, 'labor_batch_paid', 'labor_pay_batch', ?, ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(),
      user.email,
      batchId,
      JSON.stringify({
        week_start: start,
        week_end: end,
        pay_date: payDateRaw,
        total: batchTotal,
        expenses: expenseIds,
        skipped: [...skipped.keys()],
      }),
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(message)) {
      const raced = await env.DB.prepare(
        `SELECT id, week_start, week_end, pay_date, total, paid_at, paid_by
           FROM labor_pay_batches WHERE week_start = ?`,
      )
        .bind(start)
        .first();
      if (raced) return json({ batch: raced, created: false, expenses: [] });
    }
    return err(500, "pay_failed", "The pay batch did not save. Nothing was marked paid.");
  }

  return json({
    created: true,
    batch: {
      id: batchId,
      week_start: start,
      week_end: end,
      pay_date: payDateRaw,
      total: batchTotal,
      paid_by: user.email,
    },
    expenses: expenseIds,
  });
}

function shortMd(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function rangeLabel(start: string, end: string): string {
  return start === end ? shortMd(start) : `${shortMd(start)}–${shortMd(end)}`;
}

function parseSkip(body: Record<string, unknown>): Set<string> {
  const skip = new Set<string>();
  if (!Array.isArray(body.skip)) return skip;
  for (const item of body.skip) {
    if (typeof item !== "object" || item == null) continue;
    const rec = item as Record<string, unknown>;
    const subId = str(rec.sub_id);
    const jobId = str(rec.job_id);
    if (subId && jobId) skip.add(groupKey(subId, jobId));
  }
  return skip;
}

interface GroupChoice {
  action: "create" | "link";
  expense_id: string | null;
  difference_decision: "add_difference" | "accept_as_paid" | null;
}

/** Null when the client omitted `groups`, so the older skip path stays in place. */
function parseGroupChoices(body: Record<string, unknown>): Map<string, GroupChoice> | null {
  if (!Array.isArray(body.groups)) return null;
  const map = new Map<string, GroupChoice>();
  for (const item of body.groups) {
    if (typeof item !== "object" || item == null) continue;
    const rec = item as Record<string, unknown>;
    const subId = str(rec.sub_id);
    const jobId = str(rec.job_id);
    if (!subId || !jobId) continue;
    const decision =
      rec.difference_decision === "add_difference" || rec.difference_decision === "accept_as_paid"
        ? rec.difference_decision
        : null;
    map.set(groupKey(subId, jobId), {
      action: rec.action === "link" ? "link" : "create",
      expense_id: str(rec.expense_id),
      difference_decision: decision,
    });
  }
  return map;
}

interface LinkedExpense {
  id: string;
  sub_id: string | null;
  job_id: string | null;
  amount: number;
  expense_type: string | null;
  incurred_date: string | null;
  vendor: string | null;
  description: string | null;
  is_active: number;
}

async function loadLinkedExpense(env: Env, id: string): Promise<LinkedExpense | null> {
  return env.DB.prepare(
    `SELECT id, sub_id, job_id, amount, expense_type, vendor, description,
            COALESCE(is_active, 1) AS is_active,
            COALESCE(incurred_date, substr(incurred_at, 1, 10)) AS incurred_date
       FROM expenses WHERE id = ?`,
  )
    .bind(id)
    .first<LinkedExpense>();
}

function laborExpenseStatement(
  env: Env,
  expenseId: string,
  jobId: string,
  amount: number,
  description: string,
  payDate: string,
  vendor: string,
  subId: string,
  now: string,
  email: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO expenses
       (id, job_id, amount, description, incurred_at, incurred_date, synced_at, vendor,
        expense_type, estimate_line_item_id, tax_category, is_1099_reportable, sub_id,
        receipt_photo_id, receipt_r2_key, entered_via, is_active, pushed_to_qbo, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'labor', NULL, 'labor', 1, ?, NULL, NULL, 'auto', 1, 0, ?, ?)`,
  ).bind(expenseId, jobId, amount, description, payDate, payDate, now, vendor, subId, now, email);
}

interface SelectedEntry extends PayEntry {
  work_date: string;
  batch_id: string | null;
  expense_id: string | null;
  deleted_at: string | null;
}

interface PaySettlement {
  sub_id: string;
  job_id: string;
  action: "create" | "link";
  expense_id: string | null;
  expense_amount: number | null;
  expense_date: string | null;
  expense_type: string | null;
  earned: number;
  linked: number | null;
  difference: number | null;
  decision: "add_difference" | "accept_as_paid" | "exact" | "over" | null;
  difference_expense_id: string | null;
}

/**
 * Pay with an explicit create-or-link choice per worker and job.
 * A shortfall link is rejected until Tony picks add_difference or accept_as_paid.
 */
async function payWithChoices(
  env: Env,
  email: string,
  rows: SelectedEntry[],
  entryIds: string[],
  payDateRaw: string,
  method: string | null,
  note: string | null,
  choices: Map<string, GroupChoice>,
): Promise<Response> {
  const dates = rows.map((row) => row.work_date).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];
  const weekStart = weekBounds(periodStart).start;
  const weekEnd = weekBounds(periodEnd).end;
  const grouped = new Map<string, SelectedEntry[]>();
  for (const entry of rows) {
    const key = groupKey(entry.sub_id, entry.job_id);
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expenseStatements: D1PreparedStatement[] = [];
  const entryStatements: D1PreparedStatement[] = [];
  const expenseIds: { sub_id: string; job_id: string; expense_id: string; amount: number }[] = [];
  const settlements: PaySettlement[] = [];
  let batchTotal = 0;

  for (const [key, entries] of grouped) {
    const choice = choices.get(key) ?? { action: "create" as const, expense_id: null, difference_decision: null };
    const sample = entries[0];
    const name = workerName(sample);
    const days = round2(entries.reduce((sum, entry) => sum + entry.days, 0));
    const earned = round2(entries.reduce((sum, entry) => sum + lineTotal(entry.days, entry.day_rate), 0));
    const span = entries.map((entry) => entry.work_date).sort();
    const minDate = span[0];
    const maxDate = span[span.length - 1];

    if (choice.action === "link") {
      if (!choice.expense_id) {
        return err(400, "expense_required", "Choose which expense to link, or create a new one.");
      }
      const expense = await loadLinkedExpense(env, choice.expense_id);
      if (!expense || Number(expense.is_active) === 0) {
        return err(400, "expense_not_found", "That expense is no longer on the books.");
      }
      if (expense.sub_id !== sample.sub_id || expense.job_id !== sample.job_id) {
        return err(400, "expense_mismatch", "That expense isn't for this worker on this job.");
      }
      if (!isPayableMatchType(expense.expense_type)) {
        return err(400, "expense_type", "Only a labor, subcontractor, or other expense can be linked to these days.");
      }
      const incurred = expense.incurred_date;
      if (!incurred || incurred < minDate || incurred > payDateRaw) {
        return err(400, "expense_outside_window", "That expense is outside these days.");
      }
      const linked = round2(Number(expense.amount));
      const difference = round2(earned - linked);
      let decision: PaySettlement["decision"];
      if (difference > 0) {
        if (choice.difference_decision !== "add_difference" && choice.difference_decision !== "accept_as_paid") {
          return err(
            400,
            "difference_required",
            `Choose how to handle the $${difference.toFixed(2)} that this expense doesn't cover.`,
          );
        }
        decision = choice.difference_decision;
      } else if (difference < 0) {
        decision = "over";
      } else {
        decision = "exact";
      }

      let differenceExpenseId: string | null = null;
      if (decision === "add_difference") {
        differenceExpenseId = crypto.randomUUID();
        const description = `Day labor — ${name} — difference for ${daysLabel(days)} days, ${rangeLabel(minDate, maxDate)}`;
        expenseStatements.push(
          laborExpenseStatement(env, differenceExpenseId, sample.job_id, difference, description, payDateRaw, name, sample.sub_id, now, email),
        );
        batchTotal = round2(batchTotal + difference);
        expenseIds.push({ sub_id: sample.sub_id, job_id: sample.job_id, expense_id: differenceExpenseId, amount: difference });
      }

      for (const entry of entries) {
        entryStatements.push(
          env.DB.prepare(
            `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL AND deleted_at IS NULL`,
          ).bind(batchId, choice.expense_id, entry.id),
        );
      }
      settlements.push({
        sub_id: sample.sub_id,
        job_id: sample.job_id,
        action: "link",
        expense_id: choice.expense_id,
        expense_amount: linked,
        expense_date: incurred,
        expense_type: expense.expense_type,
        earned,
        linked,
        difference,
        decision,
        difference_expense_id: differenceExpenseId,
      });
      continue;
    }

    const description = `Day labor — ${name} — ${daysLabel(days)} days, ${rangeLabel(minDate, maxDate)}`;
    const expenseId = crypto.randomUUID();
    expenseStatements.push(
      laborExpenseStatement(env, expenseId, sample.job_id, earned, description, payDateRaw, name, sample.sub_id, now, email),
    );
    batchTotal = round2(batchTotal + earned);
    for (const entry of entries) {
      entryStatements.push(
        env.DB.prepare(
          `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL AND deleted_at IS NULL`,
        ).bind(batchId, expenseId, entry.id),
      );
    }
    expenseIds.push({ sub_id: sample.sub_id, job_id: sample.job_id, expense_id: expenseId, amount: earned });
    settlements.push({
      sub_id: sample.sub_id,
      job_id: sample.job_id,
      action: "create",
      expense_id: expenseId,
      expense_amount: earned,
      expense_date: payDateRaw,
      expense_type: "labor",
      earned,
      linked: null,
      difference: null,
      decision: null,
      difference_expense_id: null,
    });
  }

  const statements: D1PreparedStatement[] = [
    ...expenseStatements,
    env.DB.prepare(
      `INSERT INTO labor_pay_batches
         (id, week_start, week_end, pay_date, total, paid_at, paid_by, period_start, period_end, method, note)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
    ).bind(batchId, weekStart, weekEnd, payDateRaw, batchTotal, email, periodStart, periodEnd, method, note),
    ...entryStatements,
    env.DB.prepare(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       VALUES (?, ?, 'labor_batch_paid', 'labor_pay_batch', ?, ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(),
      email,
      batchId,
      JSON.stringify({
        pay_date: payDateRaw,
        period_start: periodStart,
        period_end: periodEnd,
        method,
        note,
        total: batchTotal,
        entry_ids: entryIds,
        expenses: expenseIds,
        settlements,
      }),
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(500, "pay_failed", message || "The payment did not save. Nothing was marked paid.");
  }

  return json({
    created: true,
    batch: {
      id: batchId,
      week_start: weekStart,
      week_end: weekEnd,
      period_start: periodStart,
      period_end: periodEnd,
      pay_date: payDateRaw,
      method,
      note,
      total: batchTotal,
      paid_by: email,
    },
    expenses: expenseIds,
    settlements,
  });
}

/**
 * One pay event for a chosen set of unpaid days. Weeks may be mixed.
 * Re-submitting ids that are already paid creates nothing.
 */
export async function handleLaborPay(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  const body = await readJson(request);
  if (!body) return err(400, "invalid_json", "Expected JSON");
  const entryIds = Array.isArray(body.entry_ids)
    ? [...new Set(body.entry_ids.map((id) => str(id)).filter((id): id is string => Boolean(id)))]
    : [];
  if (entryIds.length === 0) return err(400, "nothing_selected", "Select at least one day to pay.");
  if (entryIds.length > 500) return err(422, "validation_error", "Too many days in one payment.");

  const today = centralDate();
  const payDateRaw = str(body.pay_date) ?? nextPayFriday(today);
  if (!isIsoDate(payDateRaw)) return err(422, "validation_error", "Pay date must be YYYY-MM-DD");
  const method = str(body.method);
  const note = str(body.note);
  const skip = parseSkip(body);

  const placeholders = entryIds.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(
      `SELECT le.id, le.sub_id, le.job_id, le.work_date, le.days, le.day_rate,
              le.batch_id, le.expense_id, le.deleted_at,
              s.company_name, s.company, s.contact_name, s.primary_contact,
              j.job_number, j.title
         FROM labor_entries le
         JOIN subcontractors s ON s.id = le.sub_id
         JOIN jobs j ON j.id = le.job_id
        WHERE le.id IN (${placeholders})`,
    )
      .bind(...entryIds)
      .all<SelectedEntry>()
  ).results ?? [];
  if (rows.length !== entryIds.length) return err(404, "not_found", "One of those days is no longer on the books.");
  if (rows.some((row) => row.deleted_at)) {
    return err(409, "entry_removed", "A removed day can't be paid.");
  }
  if (rows.some((row) => !isWeekClosed(weekBounds(row.work_date).end, today))) {
    return err(409, "week_open", "Days in the current week can't be paid until Sunday has passed.");
  }
  const already = rows.filter((row) => row.batch_id || row.expense_id);
  if (already.length === rows.length) return json({ created: false, expenses: [], batch: null });
  if (already.length > 0) {
    return err(409, "already_paid", "Some of these days are already paid. Refresh and choose the unpaid ones.");
  }

  const choices = parseGroupChoices(body);
  if (choices) {
    return payWithChoices(env, user.email, rows, entryIds, payDateRaw, method, note, choices);
  }

  const dates = rows.map((row) => row.work_date).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];
  const weekStart = weekBounds(periodStart).start;
  const weekEnd = weekBounds(periodEnd).end;

  const matches = skip.size
    ? await overlapMatches(env, periodStart, payDateRaw)
    : new Map<string, ExpenseMatch[]>();

  const included = new Map<string, SelectedEntry[]>();
  const skipped = new Map<string, SelectedEntry[]>();
  for (const entry of rows) {
    const key = groupKey(entry.sub_id, entry.job_id);
    const bucket = skip.has(key) ? skipped : included;
    const list = bucket.get(key) ?? [];
    list.push(entry);
    bucket.set(key, list);
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expenseStatements: D1PreparedStatement[] = [];
  const entryStatements: D1PreparedStatement[] = [];
  const expenseIds: { sub_id: string; job_id: string; expense_id: string; amount: number }[] = [];
  let batchTotal = 0;

  for (const entries of included.values()) {
    const sample = entries[0];
    const name = workerName(sample);
    const days = round2(entries.reduce((sum, entry) => sum + entry.days, 0));
    const amount = round2(entries.reduce((sum, entry) => sum + lineTotal(entry.days, entry.day_rate), 0));
    batchTotal = round2(batchTotal + amount);
    const span = entries.map((entry) => entry.work_date).sort();
    const description = `Day labor — ${name} — ${daysLabel(days)} days, ${rangeLabel(span[0], span[span.length - 1])}`;
    const expenseId = crypto.randomUUID();
    expenseStatements.push(
      env.DB.prepare(
        `INSERT INTO expenses
           (id, job_id, amount, description, incurred_at, incurred_date, synced_at, vendor,
            expense_type, estimate_line_item_id, tax_category, is_1099_reportable, sub_id,
            receipt_photo_id, receipt_r2_key, entered_via, is_active, pushed_to_qbo, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'labor', NULL, 'labor', 1, ?, NULL, NULL, 'auto', 1, 0, ?, ?)`,
      ).bind(
        expenseId,
        sample.job_id,
        amount,
        description,
        payDateRaw,
        payDateRaw,
        now,
        name,
        sample.sub_id,
        now,
        user.email,
      ),
    );
    for (const entry of entries) {
      entryStatements.push(
        env.DB.prepare(
          `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL AND deleted_at IS NULL`,
        ).bind(batchId, expenseId, entry.id),
      );
    }
    expenseIds.push({ sub_id: sample.sub_id, job_id: sample.job_id, expense_id: expenseId, amount });
  }

  for (const [key, entries] of skipped) {
    const linked = matchInWindow(matches.get(key), periodStart, payDateRaw)?.id ?? null;
    for (const entry of entries) {
      entryStatements.push(
        env.DB.prepare(
          `UPDATE labor_entries SET batch_id = ?, expense_id = ? WHERE id = ? AND batch_id IS NULL AND deleted_at IS NULL`,
        ).bind(batchId, linked, entry.id),
      );
    }
  }

  const statements: D1PreparedStatement[] = [
    ...expenseStatements,
    env.DB.prepare(
      `INSERT INTO labor_pay_batches
         (id, week_start, week_end, pay_date, total, paid_at, paid_by, period_start, period_end, method, note)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
    ).bind(batchId, weekStart, weekEnd, payDateRaw, batchTotal, user.email, periodStart, periodEnd, method, note),
    ...entryStatements,
    env.DB.prepare(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       VALUES (?, ?, 'labor_batch_paid', 'labor_pay_batch', ?, ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(),
      user.email,
      batchId,
      JSON.stringify({
        pay_date: payDateRaw,
        period_start: periodStart,
        period_end: periodEnd,
        method,
        note,
        total: batchTotal,
        entry_ids: entryIds,
        expenses: expenseIds,
        skipped: [...skipped.keys()],
      }),
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(500, "pay_failed", message || "The payment did not save. Nothing was marked paid.");
  }

  return json({
    created: true,
    batch: {
      id: batchId,
      week_start: weekStart,
      week_end: weekEnd,
      period_start: periodStart,
      period_end: periodEnd,
      pay_date: payDateRaw,
      method,
      note,
      total: batchTotal,
      paid_by: user.email,
    },
    expenses: expenseIds,
  });
}

interface WeekEntryRow {
  sub_id: string;
  work_date: string;
  days: number;
  day_rate: number;
  paid: number;
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
}

function summarizeWeeks(rows: WeekEntryRow[], today: string) {
  const buckets = new Map<
    string,
    { week_start: string; week_end: string; days: number; earned: number; paid: number; workers: Set<string> }
  >();
  for (const row of rows) {
    const bounds = weekBounds(row.work_date);
    const bucket = buckets.get(bounds.start) ?? {
      week_start: bounds.start,
      week_end: bounds.end,
      days: 0,
      earned: 0,
      paid: 0,
      workers: new Set<string>(),
    };
    const amount = lineTotal(row.days, row.day_rate);
    bucket.days = round2(bucket.days + row.days);
    bucket.earned = round2(bucket.earned + amount);
    if (row.paid) bucket.paid = round2(bucket.paid + amount);
    bucket.workers.add(row.sub_id);
    buckets.set(bounds.start, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const unpaid = round2(bucket.earned - bucket.paid);
      return {
        week_start: bucket.week_start,
        week_end: bucket.week_end,
        state: weekPayState(today, bucket.week_end, bucket.paid, unpaid),
        days: bucket.days,
        earned: bucket.earned,
        paid: bucket.paid,
        unpaid,
        workers: bucket.workers.size,
      };
    })
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}

function weekEntrySql(extra: string[]): string {
  return `SELECT le.sub_id, le.work_date, le.days, le.day_rate,
            CASE WHEN le.expense_id IS NOT NULL OR le.batch_id IS NOT NULL THEN 1 ELSE 0 END AS paid,
            s.company_name, s.company, s.contact_name, s.primary_contact
       FROM labor_entries le
       JOIN subcontractors s ON s.id = le.sub_id
       JOIN jobs j ON j.id = le.job_id
      WHERE ${[ACTIVE_ENTRY, notTestClientExists("j.client_id"), ...extra].join(" AND ")}`;
}

export async function handleLaborWeeks(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const url = new URL(request.url);
  const worker = url.searchParams.get("worker")?.trim() || "";
  const from = url.searchParams.get("from")?.trim() || "";
  const to = url.searchParams.get("to")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  if (from && !isIsoDate(from)) return err(400, "invalid_date", "from must be YYYY-MM-DD");
  if (to && !isIsoDate(to)) return err(400, "invalid_date", "to must be YYYY-MM-DD");

  const allRows = (await env.DB.prepare(weekEntrySql([])).all<WeekEntryRow>()).results ?? [];
  const today = centralDate();
  const allWeeks = summarizeWeeks(allRows, today);
  const unpaidWeeks = allWeeks.filter((week) => week.unpaid > 0 && week.state !== "open");
  const oldest = unpaidWeeks.length
    ? unpaidWeeks.reduce((min, week) => (week.week_start < min ? week.week_start : min), unpaidWeeks[0].week_start)
    : null;

  const extra: string[] = [];
  const binds: unknown[] = [];
  if (worker) {
    extra.push("le.sub_id = ?");
    binds.push(worker);
  }
  if (from) {
    extra.push("le.work_date >= ?");
    binds.push(from);
  }
  if (to) {
    extra.push("le.work_date <= ?");
    binds.push(to);
  }
  const weekStmt = env.DB.prepare(weekEntrySql(extra));
  const filtered = (
    await (binds.length ? weekStmt.bind(...binds) : weekStmt).all<WeekEntryRow>()
  ).results ?? [];
  let weeks = summarizeWeeks(filtered, today);
  if (status === "unpaid") {
    weeks = weeks.filter((week) => week.unpaid > 0 && week.state !== "open");
  } else if (status) {
    weeks = weeks.filter((week) => week.state === status);
  }

  return json({
    weeks,
    unpaid_summary: {
      weeks: unpaidWeeks.length,
      total: round2(unpaidWeeks.reduce((sum, week) => sum + week.unpaid, 0)),
      oldest,
    },
  });
}

export async function handleLaborPayable(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const url = new URL(request.url);
  const today = centralDate();
  const payDate = url.searchParams.get("pay_date")?.trim() || nextPayFriday(today);
  if (!isIsoDate(payDate)) return err(400, "invalid_date", "pay_date must be YYYY-MM-DD");

  const rows = (
    await env.DB.prepare(
      `SELECT le.id, le.sub_id, le.job_id, le.work_date, le.days, le.day_rate,
              s.company_name, s.company, s.contact_name, s.primary_contact,
              j.job_number, j.title, j.property_address
         FROM labor_entries le
         JOIN subcontractors s ON s.id = le.sub_id
         JOIN jobs j ON j.id = le.job_id
        WHERE ${ACTIVE_ENTRY}
          AND le.batch_id IS NULL AND le.expense_id IS NULL
          AND ${notTestClientExists("j.client_id")}
        ORDER BY le.work_date, j.job_number`,
    ).all<PayEntry & { work_date: string; property_address: string | null }>()
  ).results ?? [];

  const closed = rows.filter((row) => isWeekClosed(weekBounds(row.work_date).end, today));
  const start = closed.length ? closed.map((row) => row.work_date).sort()[0] : today;
  const matches = closed.length ? await overlapMatches(env, start, payDate) : new Map<string, ExpenseMatch[]>();

  const entries = closed.map((row) => {
    const bounds = weekBounds(row.work_date);
    return {
      id: row.id,
      sub_id: row.sub_id,
      worker_name: workerName(row),
      job_id: row.job_id,
      job_label: jobLabel(row),
      job_number: row.job_number,
      work_date: row.work_date,
      days: row.days,
      day_rate: row.day_rate,
      line_total: lineTotal(row.days, row.day_rate),
      week_start: bounds.start,
      week_end: bounds.end,
    };
  });

  const groups = new Map<string, { sub_id: string; job_id: string; dates: string[] }>();
  for (const entry of entries) {
    const key = groupKey(entry.sub_id, entry.job_id);
    const group = groups.get(key) ?? { sub_id: entry.sub_id, job_id: entry.job_id, dates: [] };
    group.dates.push(entry.work_date);
    groups.set(key, group);
  }
  const overlaps = [...groups.values()].map((group) => {
    const minDate = [...group.dates].sort()[0];
    const key = groupKey(group.sub_id, group.job_id);
    const groupEntries = entries.filter((entry) => entry.sub_id === group.sub_id && entry.job_id === group.job_id);
    const earned = round2(groupEntries.reduce((sum, entry) => sum + entry.line_total, 0));
    const days = round2(groupEntries.reduce((sum, entry) => sum + entry.days, 0));
    const shaped = payableMatchesInWindow(matches.get(key), minDate, payDate).map((match) => ({
      expense_id: match.id,
      amount: Number(match.amount),
      expense_type: match.expense_type,
      incurred_date: match.incurred_date,
      vendor: match.vendor ?? null,
      description: match.description ?? null,
      difference: round2(earned - Number(match.amount)),
    }));
    const newest = shaped[0] ?? null;
    return {
      sub_id: group.sub_id,
      job_id: group.job_id,
      earned,
      days,
      matches: shaped,
      match: newest
        ? {
            expense_id: newest.expense_id,
            amount: newest.amount,
            expense_type: newest.expense_type,
            incurred_date: newest.incurred_date,
          }
        : null,
    };
  });

  return json({
    pay_date: payDate,
    owed_total: round2(entries.reduce((sum, entry) => sum + entry.line_total, 0)),
    entries,
    overlaps,
  });
}

interface SettlementView {
  expense_date: string | null;
  expense_amount: number;
  expense_type: string | null;
  decision: string | null;
  difference: number | null;
}

async function settlementsForEntries(
  env: Env,
  rows: { id: string; sub_id: string; job_id: string; batch_id: string | null; expense_id: string | null }[],
): Promise<Map<string, SettlementView>> {
  const result = new Map<string, SettlementView>();
  const batchIds = [...new Set(rows.map((row) => row.batch_id).filter((id): id is string => Boolean(id)))];
  if (!batchIds.length) return result;
  const expenseIds = [...new Set(rows.map((row) => row.expense_id).filter((id): id is string => Boolean(id)))];

  const audits = (
    await env.DB.prepare(
      `SELECT entity_id, details FROM audit_logs
        WHERE entity_type = 'labor_pay_batch' AND action = 'labor_batch_paid'
          AND entity_id IN (${batchIds.map(() => "?").join(",")})`,
    )
      .bind(...batchIds)
      .all<{ entity_id: string; details: string }>()
  ).results ?? [];

  const meta = new Map<string, { settlements: PaySettlement[]; created: Set<string> }>();
  for (const audit of audits) {
    let parsed: { settlements?: PaySettlement[]; expenses?: { expense_id?: string }[] } = {};
    try {
      parsed = JSON.parse(audit.details || "{}");
    } catch {
      parsed = {};
    }
    meta.set(audit.entity_id, {
      settlements: parsed.settlements ?? [],
      created: new Set((parsed.expenses ?? []).map((row) => row.expense_id).filter((id): id is string => Boolean(id))),
    });
  }

  const expenseBriefs = new Map<string, { amount: number; expense_type: string | null; incurred_date: string | null }>();
  if (expenseIds.length) {
    const expenses = (
      await env.DB.prepare(
        `SELECT id, amount, expense_type,
                COALESCE(incurred_date, substr(incurred_at, 1, 10)) AS incurred_date
           FROM expenses WHERE id IN (${expenseIds.map(() => "?").join(",")})`,
      )
        .bind(...expenseIds)
        .all<{ id: string; amount: number; expense_type: string | null; incurred_date: string | null }>()
    ).results ?? [];
    for (const expense of expenses) expenseBriefs.set(expense.id, expense);
  }

  for (const row of rows) {
    if (!row.batch_id || !row.expense_id) continue;
    const batch = meta.get(row.batch_id);
    const recorded = batch?.settlements.find(
      (item) => item.action === "link" && item.sub_id === row.sub_id && item.job_id === row.job_id,
    );
    if (recorded) {
      result.set(row.id, {
        expense_date: recorded.expense_date,
        expense_amount: Number(recorded.expense_amount ?? 0),
        expense_type: recorded.expense_type,
        decision: recorded.decision,
        difference: recorded.difference == null ? null : Number(recorded.difference),
      });
      continue;
    }
    if (!batch || batch.created.has(row.expense_id)) continue;
    const expense = expenseBriefs.get(row.expense_id);
    if (!expense) continue;
    result.set(row.id, {
      expense_date: expense.incurred_date,
      expense_amount: Number(expense.amount),
      expense_type: expense.expense_type,
      decision: null,
      difference: null,
    });
  }
  return result;
}

export async function handleLaborLedger(
  request: Request,
  env: Env,
  subId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const url = new URL(request.url);
  const from = url.searchParams.get("from")?.trim() || "";
  const to = url.searchParams.get("to")?.trim() || "";
  const includeRemoved = url.searchParams.get("include_removed") === "1";
  if (from && !isIsoDate(from)) return err(400, "invalid_date", "from must be YYYY-MM-DD");
  if (to && !isIsoDate(to)) return err(400, "invalid_date", "to must be YYYY-MM-DD");

  const worker = await loadWorker(env, subId);
  if (!worker) return err(404, "not_found", "Worker not found");

  const where = ["le.sub_id = ?"];
  const binds: unknown[] = [subId];
  if (!includeRemoved) where.push("le.deleted_at IS NULL");
  if (from) {
    where.push("le.work_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("le.work_date <= ?");
    binds.push(to);
  }

  const rows = (
    await env.DB.prepare(
      `SELECT le.id, le.sub_id, le.job_id, le.work_date, le.days, le.day_rate, le.notes,
              le.batch_id, le.expense_id, le.entered_via, le.created_at, le.created_by,
              le.updated_at, le.updated_by, le.deleted_at, le.deleted_by, le.delete_reason,
              b.pay_date, b.method, b.note AS batch_note, b.paid_at,
              j.job_number, j.title, j.property_address
         FROM labor_entries le
         JOIN jobs j ON j.id = le.job_id
         LEFT JOIN labor_pay_batches b ON b.id = le.batch_id
        WHERE ${where.join(" AND ")}
        ORDER BY le.work_date, j.job_number`,
    )
      .bind(...binds)
      .all<{
        id: string;
        sub_id: string;
        job_id: string;
        work_date: string;
        days: number;
        day_rate: number;
        notes: string | null;
        batch_id: string | null;
        expense_id: string | null;
        entered_via: string;
        created_at: string;
        created_by: string | null;
        updated_at: string | null;
        updated_by: string | null;
        deleted_at: string | null;
        deleted_by: string | null;
        delete_reason: string | null;
        pay_date: string | null;
        method: string | null;
        batch_note: string | null;
        paid_at: string | null;
        job_number: number | null;
        title: string | null;
        property_address: string | null;
      }>()
  ).results ?? [];

  const ids = rows.map((row) => row.id);
  let history: { id: string; entity_id: string; action: string; user_email: string; details: string; created_at: string }[] = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    history = (
      await env.DB.prepare(
        `SELECT id, entity_id, action, user_email, details, created_at
           FROM audit_logs
          WHERE entity_type = 'labor_entry' AND entity_id IN (${placeholders})
          ORDER BY created_at`,
      )
        .bind(...ids)
        .all<{ id: string; entity_id: string; action: string; user_email: string; details: string; created_at: string }>()
    ).results ?? [];
  }
  const historyById = new Map<string, typeof history>();
  for (const event of history) {
    const list = historyById.get(event.entity_id) ?? [];
    list.push(event);
    historyById.set(event.entity_id, list);
  }

  const settlements = await settlementsForEntries(env, rows);

  let earned = 0;
  let paid = 0;
  const entries = rows.map((row) => {
    const amount = lineTotal(row.days, row.day_rate);
    const removed = Boolean(row.deleted_at);
    const isPaid = Boolean(row.batch_id || row.expense_id);
    if (!removed) {
      earned = round2(earned + amount);
      if (isPaid) paid = round2(paid + amount);
    }
    return {
      id: row.id,
      work_date: row.work_date,
      job_id: row.job_id,
      job_number: row.job_number,
      job_title: row.title,
      address: row.property_address,
      job_label: jobLabel({ job_number: row.job_number, title: row.title, property_address: row.property_address }),
      days: row.days,
      day_rate: row.day_rate,
      amount,
      status: removed ? "removed" : isPaid ? "paid" : "unpaid",
      pay_date: row.pay_date,
      method: row.method,
      note: row.batch_note,
      batch_id: row.batch_id,
      expense_id: row.expense_id,
      entered_via: row.entered_via,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
      deleted_at: row.deleted_at,
      deleted_by: row.deleted_by,
      delete_reason: row.delete_reason,
      history: (historyById.get(row.id) ?? []).map((event) => ({
        id: event.id,
        action: event.action,
        user_email: event.user_email,
        details: event.details,
        created_at: event.created_at,
      })),
      settlement: settlements.get(row.id) ?? null,
    };
  });

  return json({
    worker: { id: worker.id, name: workerName(worker), day_rate: worker.day_rate },
    totals: { earned, paid, unpaid: round2(earned - paid) },
    entries,
  });
}

export async function handleLaborRangeStatements(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ROLES]);
  if (guarded instanceof Response) return guarded;
  const url = new URL(request.url);
  const subId = url.searchParams.get("sub_id")?.trim() || "";
  const from = url.searchParams.get("from")?.trim() || "";
  const to = url.searchParams.get("to")?.trim() || "";
  if (from && !isIsoDate(from)) return err(400, "invalid_date", "from must be YYYY-MM-DD");
  if (to && !isIsoDate(to)) return err(400, "invalid_date", "to must be YYYY-MM-DD");

  const where = [ACTIVE_ENTRY];
  const binds: unknown[] = [];
  if (subId) {
    where.push("le.sub_id = ?");
    binds.push(subId);
  }
  if (from) {
    where.push("le.work_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("le.work_date <= ?");
    binds.push(to);
  }

  const statementSql = `SELECT ${ENTRY_SELECT}, b.pay_date, b.method
         FROM labor_entries le
         JOIN subcontractors s ON s.id = le.sub_id
         JOIN jobs j ON j.id = le.job_id
         LEFT JOIN labor_pay_batches b ON b.id = le.batch_id
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(s.company_name, s.company, s.contact_name, s.primary_contact),
                 le.work_date, j.job_number`;
  const statementStmt = env.DB.prepare(statementSql);
  const rows = (
    await (binds.length ? statementStmt.bind(...binds) : statementStmt)
      .all<StoredEntry & { pay_date: string | null; method: string | null }>()
  ).results ?? [];

  const byWorker = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWorker.get(row.sub_id) ?? [];
    list.push(row);
    byWorker.set(row.sub_id, list);
  }

  const settlements = await settlementsForEntries(env, rows);
  const statements = [...byWorker.values()].map((workerRows) => {
    const lines = workerRows.map((row) => ({
      work_date: row.work_date,
      job_label: jobLabel(row),
      days: row.days,
      day_rate: row.day_rate,
      amount: lineTotal(row.days, row.day_rate),
      status: row.batch_id || row.expense_id ? "paid" : "unpaid",
      pay_date: row.pay_date,
      method: row.method,
      settlement: settlements.get(row.id) ?? null,
    }));
    const earned = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    const paid = round2(lines.filter((line) => line.status === "paid").reduce((sum, line) => sum + line.amount, 0));
    return {
      sub_id: workerRows[0].sub_id,
      name: workerName(workerRows[0]),
      days: round2(lines.reduce((sum, line) => sum + line.days, 0)),
      earned,
      paid,
      owed: round2(earned - paid),
      total: earned,
      lines,
    };
  });

  return json({
    company_name: "Columbus Home Solutions",
    from: from || null,
    to: to || null,
    statements,
  });
}
