/** Minimal fetch helpers for the public Client Portal (no auth, token in path). */

export function portalToken(): string {
  const m = window.location.pathname.match(/\/portal\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data?.details || data?.error || `Request failed: ${res.status}`) as string);
  return data as T;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data?.details || data?.error || `Request failed: ${res.status}`) as string);
  return data as T;
}

// ─── payload types ──────────────────────────────────────────────────────────

export interface PortalLanding {
  ok: boolean;
  company_name: string;
  portal_type: string;
  is_cost_plus: boolean;
  completion_package_available?: boolean;
  on_hold: boolean;
  header: {
    client_name: string;
    property_address: string;
    job_title: string | null;
    job_display: string | null;
    status: string | null;
  };
  quick_stats: {
    contract_total: number | null;
    total_paid: number;
    remaining_balance: number | null;
    next_payment: { invoice_id: string; amount: number; due_date: string | null } | null;
  };
}

export interface PortalPhoto {
  id: string;
  caption: string | null;
  category: string | null;
  taken_at: string | null;
  image_url: string;
  thumb_url: string;
}

export interface PortalInvoice {
  id: string;
  invoice_number: number | null;
  invoice_display: string;
  invoice_type: string | null;
  title: string | null;
  description: string | null;
  amount: number;
  tax_amount: number;
  late_fee_amount: number;
  credits_applied: number;
  total_due: number;
  collected: number;
  balance: number;
  status: string | null;
  due_date: string | null;
  sent_date: string | null;
  paid_date: string | null;
  payable: boolean;
  pay_path: string | null;
}

export interface PortalPayment {
  id: string;
  invoice_id: string | null;
  amount: number;
  convenience_fee: number;
  payment_method: string | null;
  paid_at: string | null;
}

export interface PortalScheduleRow {
  label: string;
  trigger_type: string;
  percentage: number | null;
  amount: number | null;
  status: string;
}

export interface PortalMessage {
  id: string;
  from: "client" | "contractor";
  body: string;
  created_at: string;
}

export interface PortalScheduleEntry {
  id: string;
  scheduled_date: string | null;
  trade_or_work: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
}

export interface PortalChangeOrder {
  id: string;
  change_order_number: number;
  display: string;
  title: string | null;
  description: string | null;
  amount: number;
  is_credit: boolean;
  status: string | null;
  requested_date: string | null;
  approved_date: string | null;
  end_date_extension_days: number;
  signed_name: string | null;
  can_sign: boolean;
}

export interface ReconCategory {
  category: string;
  label: string;
  projected: number;
  actual: number;
  variance: number;
}
export interface ReconReport {
  cycle_id: string;
  cycle_number: number;
  period_start: string;
  period_end: string;
  is_final_cycle: boolean;
  categories: ReconCategory[];
  expenses: { id: string; date: string | null; vendor: string | null; description: string | null; expense_type: string | null; amount: number }[];
  credit_from_prior: number;
  delta: number;
  credit_to_next: number;
  outcome: string;
  explanation: string;
}
export interface BudgetCycle {
  id: string;
  cycle_number: number;
  period_start: string;
  period_end: string;
  is_final_cycle: number | null;
  status: string;
  projected_materials: number | null;
  projected_labor: number | null;
  projected_subs: number | null;
  projected_subtotal: number | null;
  projected_pm_fee: number | null;
  projected_contractor_fee: number | null;
  projected_total: number | null;
  actual_total: number | null;
  credit_from_prior: number | null;
  live_actuals: { materials: number; labor: number; subs: number; subtotal: number; total: number } | null;
}
export interface PortalBudget {
  ok: boolean;
  portal_type: string;
  cycles: BudgetCycle[];
  reconciliations: ReconReport[];
  unattributed_actuals: { amount: number; has_unattributed: boolean };
  totals: { projected_to_date: number; actual_to_date: number; variance_to_date: number };
}
