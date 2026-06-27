/**
 * Document-template merge-field resolution (Sprint 15 — Document Management).
 *
 * The DB-backed `document_templates` manager renders `{{merge_field}}`
 * placeholders against a job / client / estimate context. The field SET here is
 * the same one the Sprint 5 quote-delivery path (src/lib/contracts.ts) already
 * proved — `{{client_name}}`, `{{property_address}}`, `{{contract_total}}`,
 * `{{deposit_amount}}`, `{{start_date}}`, `{{completion_date}}`, `{{today_date}}`,
 * `{{company_name}}`, `{{payment_schedule}}`, … — so the manager and the
 * deposit-flow contract don't drift in wording. This module does NOT touch the
 * contracts.ts path (carried-over decision: no quote-delivery rewire this
 * sprint); it is the general-purpose resolver for ad-hoc / lien-waiver /
 * proposal generation.
 */

import type { Env } from "../env.js";
import { applyPmFields, resolvePmFields } from "./pm-fields.js";

export interface MergeContext {
  job_id?: string | null;
  client_id?: string | null;
  estimate_id?: string | null;
}

const USD = (n: number | null | undefined): string =>
  n == null
    ? "$0.00"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function todayLong(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** The canonical merge-field catalog the manager UI offers for insertion. */
export const MERGE_FIELD_CATALOG: readonly string[] = [
  "client_name",
  "client_address",
  "property_address",
  "job_title",
  "job_number",
  "contract_total",
  "deposit_amount",
  "start_date",
  "completion_date",
  "today_date",
  "company_name",
  "payment_schedule",
  "contractor_name",
  "pm_name",
  "pm_phone",
  "pm_email",
] as const;

interface CompanySettings {
  company_name: string;
  company_phone: string;
  company_email: string;
}

async function loadCompany(env: Env): Promise<CompanySettings> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM system_settings
      WHERE key IN ('company_name','company_phone','company_email')`,
  ).all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of results ?? []) m[r.key] = r.value;
  return {
    company_name: m.company_name || "Columbus Home Solutions, LLC",
    company_phone: m.company_phone || "",
    company_email: m.company_email || "",
  };
}

/** Format an estimate's payment schedule (if present) into a bulleted block. */
async function paymentScheduleBlock(env: Env, estimateId: string | null): Promise<string> {
  if (!estimateId) return "";
  type Row = { description: string | null; amount: number | null; fixed_amount: number | null; percentage: number | null; trigger: string | null };
  const rows = (
    await env.DB.prepare(
      `SELECT description, amount, fixed_amount, percentage, trigger
         FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC, rowid ASC`,
    )
      .bind(estimateId)
      .all<Row>()
      .catch(() => ({ results: [] as Row[] }))
  ).results ?? [];
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const dollars = r.amount ?? r.fixed_amount;
      const amt = dollars != null ? USD(dollars) : r.percentage != null ? `${r.percentage}%` : "";
      const label = (r.description || r.trigger || "Payment").trim();
      return `  • ${label}${amt ? ` — ${amt}` : ""}`;
    })
    .join("\n");
}

/**
 * Resolve every supported merge field from the supplied context. Missing data
 * resolves to a sensible blank/default rather than throwing — a template should
 * always render. Returns a flat `{ field: value }` map (no `{{ }}`).
 */
export async function resolveMergeFields(
  env: Env,
  ctx: MergeContext,
): Promise<Record<string, string>> {
  const company = await loadCompany(env);
  const out: Record<string, string> = {
    today_date: todayLong(),
    company_name: company.company_name,
    company_phone: company.company_phone,
    company_email: company.company_email,
    client_name: "",
    client_address: "",
    property_address: "",
    job_title: "",
    job_number: "",
    contract_total: USD(0),
    deposit_amount: USD(0),
    start_date: "",
    completion_date: "",
    payment_schedule: "",
  };

  let resolvedClientId = ctx.client_id ?? null;
  let estimateId = ctx.estimate_id ?? null;

  if (ctx.job_id) {
    const job = await env.DB.prepare(
      `SELECT title, job_number, client_id, estimate_id, contract_total, deposit_amount,
              property_address, property_city, property_state, property_zip,
              start_date, start_at, target_end_date, completed_at, assigned_to
         FROM jobs WHERE id = ?`,
    )
      .bind(ctx.job_id)
      .first<{
        title: string | null;
        job_number: number | null;
        client_id: string | null;
        estimate_id: string | null;
        contract_total: number | null;
        deposit_amount: number | null;
        property_address: string | null;
        property_city: string | null;
        property_state: string | null;
        property_zip: string | null;
        start_date: string | null;
        start_at: string | null;
        target_end_date: string | null;
        completed_at: string | null;
        assigned_to: string | null;
      }>();
    if (job) {
      out.job_title = job.title ?? "";
      out.job_number = job.job_number != null ? `JOB-${String(job.job_number).padStart(3, "0")}` : "";
      out.contract_total = USD(job.contract_total ?? 0);
      out.deposit_amount = USD(job.deposit_amount ?? 0);
      out.property_address = [job.property_address, job.property_city, job.property_state, job.property_zip]
        .filter(Boolean)
        .join(", ");
      out.start_date = longDate(job.start_date ?? job.start_at);
      out.completion_date = longDate(job.target_end_date ?? job.completed_at);
      if (!resolvedClientId) resolvedClientId = job.client_id;
      if (!estimateId) estimateId = job.estimate_id;
      const pm = await resolvePmFields(env, job.assigned_to);
      Object.assign(out, applyPmFields({}, pm));
    }
  } else {
    Object.assign(out, applyPmFields({}, await resolvePmFields(env, null)));
  }

  if (estimateId) {
    const est = await env.DB.prepare(
      `SELECT title, total, deposit_amount, client_id FROM estimates WHERE id = ?`,
    )
      .bind(estimateId)
      .first<{ title: string | null; total: number | null; deposit_amount: number | null; client_id: string | null }>();
    if (est) {
      if (!out.job_title) out.job_title = est.title ?? "";
      if (out.contract_total === USD(0) && est.total != null) out.contract_total = USD(est.total);
      if (out.deposit_amount === USD(0) && est.deposit_amount != null) out.deposit_amount = USD(est.deposit_amount);
      if (!resolvedClientId) resolvedClientId = est.client_id;
    }
  }

  if (resolvedClientId) {
    const c = await env.DB.prepare(
      `SELECT name, first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip,
              address_street, address_city, address_state, address_postal
         FROM clients WHERE id = ?`,
    )
      .bind(resolvedClientId)
      .first<{
        name: string | null;
        first_name: string | null;
        last_name: string | null;
        mailing_address: string | null;
        mailing_city: string | null;
        mailing_state: string | null;
        mailing_zip: string | null;
        address_street: string | null;
        address_city: string | null;
        address_state: string | null;
        address_postal: string | null;
      }>();
    if (c) {
      out.client_name =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || (c.name ?? "").trim();
      out.client_address =
        [c.mailing_address, c.mailing_city, c.mailing_state, c.mailing_zip].filter(Boolean).join(", ") ||
        [c.address_street, c.address_city, c.address_state, c.address_postal].filter(Boolean).join(", ");
      if (!out.property_address) out.property_address = out.client_address;
    }
  }

  out.payment_schedule = await paymentScheduleBlock(env, estimateId);
  return out;
}

/**
 * Render `{{field}}` placeholders against the resolved map. Unknown tokens are
 * left intact (so a missing field is visible in preview, not silently blanked)
 * and reported in `missing`.
 */
export function renderMergeContent(
  content: string,
  fields: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = content.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, name: string) => {
    const key = name.toLowerCase();
    if (key in fields) return fields[key];
    if (!missing.includes(key)) missing.push(key);
    return `{{${name}}}`;
  });
  return { text, missing };
}

/** Sample data for template preview (no real job/client needed). */
export function sampleMergeFields(): Record<string, string> {
  return {
    today_date: todayLong(),
    company_name: "Columbus Home Solutions, LLC",
    company_phone: "(479) 555-0100",
    company_email: "office@homesolutionsar.com",
    client_name: "Jane & John Maxwell",
    client_address: "123 Oak Street, Fayetteville, AR 72701",
    property_address: "123 Oak Street, Fayetteville, AR 72701",
    job_title: "Garage Conversion",
    job_number: "JOB-042",
    contract_total: USD(48500),
    deposit_amount: USD(9700),
    start_date: longDate(new Date().toISOString()),
    completion_date: longDate(new Date(Date.now() + 60 * 864e5).toISOString()),
    payment_schedule: "  • Materials Deposit — $9,700.00\n  • 50% at Rough-In — $19,400.00\n  • Final on Completion — $19,400.00",
    contractor_name: "Tony Columbus, Owner",
    pm_name: "Tony Columbus",
    pm_phone: "501-263-2050",
    pm_email: "tony@homesolutionsar.com",
  };
}
