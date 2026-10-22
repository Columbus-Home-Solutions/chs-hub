/**
 * In-memory D1 seeded from the Oct 7, 2026 production rows used by the
 * historical-payment replay. Amounts, ids, and statuses are the remote
 * values, not invented fixtures.
 */
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";

export const OWNER = "tony@homesolutionsar.com";

export const INV_133 = "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTUzMzk1OTcz";
export const INV_135 = "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTU2MjI0NDgw";
export const JOB_91 = "Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=";
export const JOB_99 = "Z2lkOi8vSm9iYmVyL0pvYi8xNDM4ODAxNjI=";
export const JOB_105 = "8fb106bc-321b-4342-bbd4-d31bc26318e2";
export const JOB_106 = "18c37ead-7a58-496d-b8f3-0a1ab7a51527";
export const JOB_112 = "e5e6c7ac-0568-400c-a0f2-40ad10a04c46";
export const UNLINKED_105 = "006e28a4-03d2-4376-9334-42d9a14936e9";
export const UNLINKED_106 = "9b1e7d20-7cc7-4620-85ac-4e51ab2d890d";
export const CLIENT_GUARDIAN = "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMjI4NjAxNjk=";

export interface Replay {
  env: Env;
  dispose: () => Promise<void>;
}

export async function openProductionReplay(): Promise<Replay> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: { DB: "production-replay" },
    d1Persist: false,
  });
  const bindings = await mf.getBindings<{ DB: Env["DB"] }>();
  const env = { DB: bindings.DB, APP_PUBLIC_ORIGIN: "http://127.0.0.1:5176" } as Env;
  await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
  await seed(env);
  return { env, dispose: () => mf.dispose() };
}

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, name TEXT,
  role TEXT, is_active INTEGER, business_phone TEXT
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT, first_name TEXT, last_name TEXT, company_name TEXT,
  phone TEXT, email TEXT, is_test INTEGER DEFAULT 0
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, job_number INTEGER, title TEXT, status TEXT, client_id TEXT,
  billing_model TEXT, job_type TEXT, job_type_detail TEXT, lead_source TEXT,
  source TEXT, data_source TEXT,
  property_address TEXT, property_city TEXT, property_state TEXT, property_zip TEXT,
  contract_total REAL, deposit_amount REAL, deposit_paid INTEGER,
  start_date TEXT, target_end_date TEXT, actual_end_date TEXT, warranty_expiration TEXT,
  portal_token TEXT, portal_type TEXT, conversion_complete INTEGER, estimate_id TEXT, payer_id TEXT,
  created_at TEXT, updated_at TEXT,
  conversion_reversed INTEGER, reversal_reason TEXT, reversed_at TEXT, assigned_to TEXT
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, invoice_number INTEGER, jobber_invoice_number INTEGER,
  job_id TEXT, client_id TEXT, billing_model TEXT, invoice_type TEXT, title TEXT, description TEXT,
  amount REAL, total REAL, tax_amount REAL, late_fee_amount REAL, credits_applied REAL, total_due REAL,
  status TEXT, sent_date TEXT, viewed_date TEXT, due_date TEXT, paid_date TEXT, paid_amount REAL,
  payment_method TEXT, stripe_payment_id TEXT, portal_link TEXT, payment_token TEXT,
  cost_plus_cycle_id TEXT, milestone_number INTEGER, trade_line_item_id TEXT, line_item_ids TEXT,
  payer_id TEXT, notes TEXT, created_at TEXT, created_by TEXT, payments_total REAL, data_source TEXT,
  synced_at TEXT
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), invoice_id TEXT REFERENCES invoices(id),
  client_id TEXT REFERENCES clients(id), amount REAL NOT NULL, convenience_fee REAL, stripe_fee REAL,
  net_amount REAL, payment_method TEXT, stripe_payment_id TEXT, received_date TEXT, collected_at TEXT,
  notes TEXT, synced_at TEXT, created_at TEXT, data_source TEXT
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_id TEXT, details TEXT, created_at TEXT
);
CREATE TABLE notification_logs (id TEXT PRIMARY KEY, trigger_event TEXT, job_id TEXT, client_id TEXT, created_at TEXT);
CREATE TABLE job_documents (
  id TEXT PRIMARY KEY, job_id TEXT, template_type TEXT, filename TEXT, r2_key TEXT,
  generated_at TEXT, generated_by TEXT, auto_generated INTEGER, trigger_event TEXT,
  related_record_id TEXT, review_status TEXT, notes TEXT, signature_status TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, job_id TEXT, task_group TEXT, task_group_order INTEGER, title TEXT,
  status TEXT, sort_order INTEGER, is_punch_list INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE billing_schedule (
  id TEXT PRIMARY KEY, job_id TEXT, billing_model TEXT, sequence INTEGER, label TEXT,
  trigger_type TEXT, trigger_ref TEXT, percentage REAL, amount REAL, period_start TEXT,
  period_end TEXT, status TEXT
);
CREATE TABLE billing_cycles (id TEXT PRIMARY KEY, job_id TEXT);
CREATE TABLE change_orders (
  id TEXT PRIMARY KEY, job_id TEXT, change_order_number INTEGER, title TEXT, amount REAL,
  status TEXT, applied_at TEXT
);
CREATE TABLE schedule_entries (
  id TEXT PRIMARY KEY, job_id TEXT, start_time TEXT, end_time TEXT, sub_id TEXT, notes TEXT
);
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY, value TEXT, value_type TEXT, category TEXT, label TEXT,
  description TEXT, updated_at TEXT
);
`;

type ClientSeed = { id: string; name: string | null; first: string | null; last: string | null };
type JobSeed = {
  id: string;
  num: number;
  title: string;
  status: string;
  client: string;
  source: string;
  dataSource: string | null;
  contract: number | null;
};

const CLIENTS: ClientSeed[] = [
  { id: CLIENT_GUARDIAN, name: "Guardian Construction", first: "Guardian", last: "Construction" },
  { id: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzg1ODM2MDc=", name: "Charlie  Turner", first: "Charlie", last: "Turner" },
  { id: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzcxNTY2MTY=", name: "John  Davis", first: "John", last: "Davis" },
  { id: "23933c84-e62a-4748-9928-857bf6d464ac", name: null, first: "Jon", last: "Gwatney" },
  { id: "c4d73ba6-d4db-4259-bcee-193b7a7ebc80", name: null, first: "Clayton", last: "Price" },
  { id: "6193ad75-dc1a-4143-9406-ca0e20fc85f3", name: null, first: "Tony", last: "Amato" },
  { id: "b776d362-9447-4078-ba2f-291c23ac5e5c", name: null, first: "Lori", last: "Helberg" },
  { id: "b093deef-6198-4ea9-9267-220741d6e5e3", name: null, first: "Abdul", last: "Razaque" },
  { id: "022262bd-d3af-4911-a431-da773fee5e07", name: null, first: "Alicia", last: "Johnson" },
  { id: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMDg5NzI1MDc=", name: "Connie Schenk", first: "Connie", last: "Schenk" },
  { id: "7e9fea3f-e99f-488c-8b1f-d6f1a5e278b6", name: null, first: "Gary", last: "Jechorek" },
  { id: "Z2lkOi8vSm9iYmVyL0NsaWVudC84NjIzNjg3Mg==", name: "Ian Hawk", first: "Ian", last: "Hawk" },
  { id: "e336a474-c8f2-419c-9c1d-9633ec984cd5", name: "Nancee Roberson", first: "Nancee", last: "Roberson" },
  { id: "Z2lkOi8vSm9iYmVyL0NsaWVudC85MTM3MzAzOQ==", name: "Betty Hamilton", first: "Betty", last: "Hamilton" },
  { id: "16107bed-09d7-44cd-8673-4f356ae1df63", name: "Diana Stevens", first: "Diana", last: "Stevens" },
  { id: "1877f15f-d31f-4ecb-9a83-4be4d7086ace", name: "Ann Dinh", first: "Ann", last: "Dinh" },
];

const JOBS: JobSeed[] = [
  { id: "Z2lkOi8vSm9iYmVyL0pvYi8xMzM0Njk0Mjg=", num: 78, title: "HOU5-205 #7090", status: "action_required", client: CLIENT_GUARDIAN, source: "GQL_API", dataSource: "jobber_import", contract: null },
  { id: JOB_91, num: 91, title: "Georgetown Apartments", status: "late", client: CLIENT_GUARDIAN, source: "GQL_API", dataSource: "jobber_import", contract: null },
  { id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQwMTg=", num: 96, title: "Deck refinishing", status: "unscheduled", client: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzcxNTY2MTY=", source: "QUOTE_CONVERT", dataSource: "jobber_import", contract: 4071 },
  { id: JOB_99, num: 99, title: "Deck Railing", status: "action_required", client: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzg1ODM2MDc=", source: "QUOTE_CONVERT", dataSource: "jobber_import", contract: 3750 },
  { id: "79ef7f97-024a-4590-a81f-83459236f6c7", num: 101, title: "Pergola Repair — 2511 Lilac", status: "complete", client: "e336a474-c8f2-419c-9c1d-9633ec984cd5", source: "estimate", dataSource: null, contract: 1300 },
  { id: "d53d33c9-2e62-403f-8bcc-29fc0b0779e7", num: 102, title: "Kitchen Repair — 5305 Vaughn Road", status: "in_progress", client: "Z2lkOi8vSm9iYmVyL0NsaWVudC85MTM3MzAzOQ==", source: "estimate", dataSource: null, contract: 3300 },
  { id: "2df52cbd-b595-43d1-9306-37e6e4adf2a1", num: 103, title: "Countertops — 6012 Karen Drive", status: "punch_list", client: "16107bed-09d7-44cd-8673-4f356ae1df63", source: "estimate", dataSource: null, contract: 4250 },
  { id: "ade35ed4-a850-4665-863e-95f3c5376139", num: 104, title: "Kitchen Cabinets and Countertops — 6 Roxbury Drive", status: "scheduled", client: "1877f15f-d31f-4ecb-9a83-4be4d7086ace", source: "estimate", dataSource: null, contract: 10250 },
  { id: JOB_105, num: 105, title: "Drywall and Flooring", status: "action_required", client: "23933c84-e62a-4748-9928-857bf6d464ac", source: "jobber_import", dataSource: "jobber_import", contract: 3500 },
  { id: JOB_106, num: 106, title: "Deck Repairs", status: "cancelled", client: "c4d73ba6-d4db-4259-bcee-193b7a7ebc80", source: "jobber_import", dataSource: "jobber_import", contract: 400 },
  { id: "0f80002e-29e6-4eb4-8021-ab67ee81f086", num: 107, title: "Patio Project", status: "unscheduled", client: "6193ad75-dc1a-4143-9406-ca0e20fc85f3", source: "jobber_import", dataSource: "jobber_import", contract: 3200 },
  { id: "590bfb77-a786-424b-ae1a-2917e75752fc", num: 108, title: "Basement Finishing and Garage Painting", status: "archived", client: "b776d362-9447-4078-ba2f-291c23ac5e5c", source: "jobber_import", dataSource: "jobber_import", contract: 10350 },
  { id: "99190438-f0a8-4d36-ae78-f8b19a805931", num: 109, title: "Bathroom Remodel", status: "unscheduled", client: "b093deef-6198-4ea9-9267-220741d6e5e3", source: "jobber_import", dataSource: "jobber_import", contract: 11500 },
  { id: "ba9f5359-d69f-45ed-a086-61dbb547a28d", num: 110, title: "Structural Roof Extension Framing", status: "in_progress", client: "022262bd-d3af-4911-a431-da773fee5e07", source: "jobber_import", dataSource: "jobber_import", contract: 23900 },
  { id: "17522999-ad05-427d-9f5a-6428ed4b506e", num: 111, title: "Deck Staining", status: "action_required", client: "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMDg5NzI1MDc=", source: "jobber_import", dataSource: "jobber_import", contract: 1050 },
  { id: JOB_112, num: 112, title: "Pool Deck", status: "archived", client: "7e9fea3f-e99f-488c-8b1f-d6f1a5e278b6", source: "jobber_import", dataSource: "jobber_import", contract: 3000 },
  { id: "c2058923-1dcc-4051-afb0-9841c3d0fd26", num: 113, title: "Maintenance / Billing Only (Jobber history)", status: "archived", client: "Z2lkOi8vSm9iYmVyL0NsaWVudC84NjIzNjg3Mg==", source: "jobber_import", dataSource: "jobber_import", contract: null },
];

async function seed(env: Env) {
  await env.DB.prepare(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active)
     VALUES ('user-owner', ?, 'Tony', 'Columbus', 'owner', 1)`,
  )
    .bind(OWNER)
    .run();
  for (const c of CLIENTS) {
    await env.DB.prepare(
      `INSERT INTO clients (id, name, first_name, last_name, is_test) VALUES (?, ?, ?, ?, 0)`,
    )
      .bind(c.id, c.name, c.first, c.last)
      .run();
  }
  for (const j of JOBS) {
    await env.DB.prepare(
      `INSERT INTO jobs (
        id, job_number, title, status, client_id, billing_model, job_type, source, data_source,
        property_city, property_state, contract_total, deposit_amount, deposit_paid,
        conversion_complete, conversion_reversed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'fixed', 'remodel', ?, ?, 'Conway', 'AR', ?, 0, 0, 1, 0, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    )
      .bind(j.id, j.num, j.title, j.status, j.client, j.source, j.dataSource, j.contract)
      .run();
  }
  await insertProductionInvoice(env, {
    id: INV_133,
    jobberNumber: 133,
    jobId: JOB_91,
    clientId: CLIENT_GUARDIAN,
    total: 7005,
  });
  await insertProductionInvoice(env, {
    id: INV_135,
    jobberNumber: 135,
    jobId: null,
    clientId: CLIENT_GUARDIAN,
    total: 9050,
  });
  await env.DB.prepare(
    `INSERT INTO payments (
      id, job_id, invoice_id, client_id, amount, payment_method, received_date, notes, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '2026-06-17T00:00:00Z')`,
  )
    .bind(
      UNLINKED_105,
      JOB_105,
      "23933c84-e62a-4748-9928-857bf6d464ac",
      1150,
      "check",
      "2026-06-17",
      "Jobber Deposit imported. Payment applied to Quote #253",
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO payments (
      id, job_id, invoice_id, client_id, amount, payment_method, received_date, notes, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '2026-06-17T00:00:00Z')`,
  )
    .bind(
      UNLINKED_106,
      JOB_106,
      "c4d73ba6-d4db-4259-bcee-193b7a7ebc80",
      400,
      "jobber",
      "2026-06-17",
      "Jobber Deposit imported. Payment applied to Estimate #259",
    )
    .run();
}

async function insertProductionInvoice(
  env: Env,
  row: { id: string; jobberNumber: number; jobId: string | null; clientId: string; total: number },
) {
  await env.DB.prepare(
    `INSERT INTO invoices (
      id, invoice_number, jobber_invoice_number, job_id, client_id, data_source,
      amount, total, tax_amount, late_fee_amount, credits_applied, total_due,
      status, paid_amount, payments_total, created_at
    ) VALUES (?, NULL, ?, ?, ?, 'jobber_import', ?, ?, 0, 0, 0, ?, 'past_due', NULL, 0, '2026-04-17T15:26:35Z')`,
  )
    .bind(row.id, row.jobberNumber, row.jobId, row.clientId, row.total, row.total, row.total)
    .run();
}
