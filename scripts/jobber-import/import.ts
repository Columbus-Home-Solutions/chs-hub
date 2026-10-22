/**
 * Phase B — Jobber historical import. Local D1 only.
 *
 *   npx tsx scripts/jobber-import/import.ts            # dry-run (rolls back)
 *   npx tsx scripts/jobber-import/import.ts --apply    # writes the local database
 *
 * Refuses --remote. Header totals are Jobber's Total ($), never the line sum.
 * There is no discount column on estimates, so jobber_import headers are
 * protected inside recomputeEstimate. Native estimates are unchanged.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(ROOT, "scripts/jobber-import/data");
const APPLY = process.argv.includes("--apply");
if (process.argv.includes("--remote")) {
  console.error("Refusing to run against remote.");
  process.exit(1);
}

const OPEN_CREATE = [245, 252, 255, 258, 261, 267, 272, 274, 275, 276, 278];
const SKIP_QUOTES = new Set([273, 277]);
const HOLD_NOTE: Record<number, string> = {
  126: "Hold - owner follows up personally",
  127: "Hold - owner follows up personally",
  133: "Paid by check early 2026 - awaiting date/check detail",
  135: "Paid by check early 2026 - awaiting date/check detail",
  145: "Return work pending - hold",
};
const DEPOSIT_SPLIT = new Set([141, 148]);
/** Tony approved header corrections for these stubs only. */
const APPROVED_STUBS = new Set([9054, 9067, 9069, 9000, 9001, 9002]);
/** Stubs whose headers stay at the pre-import amount. The Jobber total goes in the notes. */
const KEEP_STUB_TOTAL: Record<number, number> = {
  9009: 17826.28,
  9035: 15937.5,
  9036: 4940,
  9039: 1000,
  9040: 130600,
  9043: 1700,
  9065: 6650,
  9051: 28720,
  9075: 21356.78,
};
const NATIVE_DIANA_JOB_NUMBER = 103;
const JOBBER_DIANA_JOB = 108;

type Row = Record<string, string>;
type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  data_source: string | null;
  display: string;
  names: string[];
};

const stats = { inserts: 0, updates: 0 };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function loadCsv(name: string, headerStarts: string): Row[] {
  const rows = parseCsv(readFileSync(resolve(DATA, name), "utf8"));
  const headerAt = rows.findIndex((r) => (r[0] ?? "").trim() === headerStarts || r.includes(headerStarts));
  if (headerAt < 0) throw new Error(`Header "${headerStarts}" not found in ${name}`);
  const header = rows[headerAt].map((h) => h.trim());
  return rows.slice(headerAt + 1).map((r) => {
    const o: Row = {};
    header.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
}

function blank(v: string | null | undefined): boolean {
  const s = (v ?? "").trim();
  return s === "" || s === "-" || s.toLowerCase() === "nan" || s === "—";
}
function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function phoneKey(v: string | null | undefined): string | null {
  let d = (v ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 10) return null;
  return d.slice(-10);
}
function emailKey(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  if (blank(s) || !s.includes("@")) return null;
  return s;
}
function money(v: string | null | undefined): number | null {
  const raw = (v ?? "").trim();
  if (blank(raw)) return null;
  const neg = raw.startsWith("(") || raw.startsWith("-");
  const n = Number(raw.replace(/[$,()]/g, "").replace(/^-/, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -Math.abs(n) : n) * 100) / 100;
}
function cents(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function isoDate(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (blank(s)) return null;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = months.findIndex((x) => m[1].toLowerCase().startsWith(x));
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
function ints(v: string | null | undefined): number[] {
  if (blank(v)) return [];
  return [...(v ?? "").matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < 100000);
}
function quoteNum(v: string | null | undefined): number | null {
  const n = Number(String(v ?? "").replace(/\.0$/, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
type Line = { name: string; qty: number; amount: number };
function parseLines(raw: string): Line[] {
  const out: Line[] = [];
  const re = /(?:^|,\s*)(.+?)\s*\(\s*([\d.]+)\s*,\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const amount = money(m[3]);
    const qty = Number(m[2]);
    if (amount == null || !Number.isFinite(qty)) continue;
    out.push({ name: m[1].trim(), qty, amount });
  }
  return out;
}
function lineSum(lines: Line[]): number {
  return Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
}
function usd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function findLocalDb(): string {
  const listed = execFileSync("find", [resolve(ROOT, ".wrangler/state/v3/d1"), "-name", "*.sqlite"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!listed.length) throw new Error("No local D1 sqlite");
  const path = listed.sort()[0];
  if (!path.includes(".wrangler/state")) throw new Error(`Refusing non-local database ${path}`);
  return path;
}
function splitName(display: string): { first: string; last: string } {
  const parts = display.replace(/\s+/g, " ").trim().split(" ");
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
function mapLead(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === "-" || s === "other") return null;
  if (s.includes("thumbtack")) return "thumbtack";
  if (s.includes("referral")) return "referral";
  if (s.includes("website")) return "website";
  if (s.includes("existing")) return "repeat";
  return null;
}
function mapPay(method: string): { method: string; extra: string } {
  const s = method.trim().toLowerCase();
  if (s.includes("jobber")) return { method: "jobber", extra: "" };
  if (s === "check") return { method: "check", extra: "" };
  if (s === "cash") return { method: "cash", extra: "" };
  if (s.includes("ach")) return { method: "other", extra: "Jobber method: ACH bank payment" };
  if (s.includes("venmo")) return { method: "venmo", extra: "" };
  if (s.includes("zelle")) return { method: "zelle", extra: "" };
  return { method: "other", extra: method ? `Jobber method: ${method}` : "" };
}

function main() {
  const dbPath = findLocalDb();
  const db = new DatabaseSync(dbPath);
  const clientsReport = loadCsv("Clients_Report_1_of_1_2026-10-04.csv", "Client name");
  const contacts = loadCsv("Client_Contact_Info.csv", "Contact");
  const properties = loadCsv("Client_Properties.csv", "Client Name");
  const quotes = loadCsv("Quotes_Report_1_of_1_2026-10-04.csv", "Quote #");
  const jobsCsv = loadCsv("One-off_jobs_Report_1_of_1_2026-10-04.csv", "Job #");
  const invoices = loadCsv("Invoices_Report_1_of_1_2026-10-04.csv", "Invoice #");
  const txns = loadCsv("Transaction_List__2_.csv", "Client name");

  const before = {
    clients: scalar(db, "SELECT COUNT(*) n FROM clients"),
    jobs: scalar(db, "SELECT COUNT(*) n FROM jobs"),
    estimates: scalar(db, "SELECT COUNT(*) n FROM estimates"),
    requests: scalar(db, "SELECT COUNT(*) n FROM estimate_requests"),
    invoices: scalar(db, "SELECT COUNT(*) n FROM invoices"),
    payments: scalar(db, "SELECT COUNT(*) n FROM payments"),
    expenses: scalar(db, "SELECT COUNT(*) n FROM expenses"),
    notif: scalar(db, "SELECT COUNT(*) n FROM notification_logs"),
  };
  const stubBefore = db
    .prepare(
      `SELECT estimate_number, total FROM estimates WHERE estimate_number IN (9000, 9054, 9067, 9069, 9001, 9002, 9025)`,
    )
    .all() as Array<{ estimate_number: number; total: number | null }>;

  db.exec("BEGIN");
  try {
    const report = applyImport(db, { clientsReport, contacts, properties, quotes, jobsCsv, invoices, txns });
    const afterInside = {
      clients: scalar(db, "SELECT COUNT(*) n FROM clients"),
      jobs: scalar(db, "SELECT COUNT(*) n FROM jobs"),
      estimates: scalar(db, "SELECT COUNT(*) n FROM estimates"),
      requests: scalar(db, "SELECT COUNT(*) n FROM estimate_requests"),
      invoices: scalar(db, "SELECT COUNT(*) n FROM invoices"),
      payments: scalar(db, "SELECT COUNT(*) n FROM payments"),
      expenses: scalar(db, "SELECT COUNT(*) n FROM expenses"),
      notif: scalar(db, "SELECT COUNT(*) n FROM notification_logs"),
    };
    if (APPLY) db.exec("COMMIT");
    else db.exec("ROLLBACK");
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", before, after: afterInside, writes: stats, stubBefore, report }, null, 2));
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    throw err;
  } finally {
    db.close();
  }
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

function applyImport(
  db: DatabaseSync,
  src: {
    clientsReport: Row[];
    contacts: Row[];
    properties: Row[];
    quotes: Row[];
    jobsCsv: Row[];
    invoices: Row[];
    txns: Row[];
  },
) {
  const notes: string[] = [];
  const createdInvoices: string[] = [];
  const createdPayments: string[] = [];
  const headerChanges: string[] = [];
  const contractFills: string[] = [];
  const invoiceDiffs: string[] = [];
  const relinkSkips: string[] = [];
  const relinks: string[] = [];
  const orphanLinks: string[] = [];
  const orphanUnmatched: string[] = [];
  const jobFixes: string[] = [];
  const nameLinks: string[] = [];

  const chsClients = loadClients(db);
  const byPhone = new Map<string, ClientRow[]>();
  const byEmail = new Map<string, ClientRow[]>();
  const byName = new Map<string, ClientRow[]>();
  const indexClient = (c: ClientRow) => {
    const p = phoneKey(c.phone);
    const e = emailKey(c.email);
    if (p) push(byPhone, p, c);
    if (e) push(byEmail, e, c);
    for (const n of c.names) push(byName, n, c);
  };
  for (const c of chsClients) indexClient(c);

  function matchClient(name: string, phone: string, email: string): { kind: "match" | "missing" | "ambiguous"; via: string; row?: ClientRow; options: ClientRow[] } {
    const p = phoneKey(phone);
    const e = emailKey(email);
    const n = normName(name);
    // Cindee Wright is the Jobber name on Betty Hamilton's house. Never a separate client.
    if (n === normName("Cindee Wright")) {
      const betty = [...new Map((byName.get(normName("Betty Hamilton")) ?? []).map((c) => [c.id, c])).values()];
      if (betty.length === 1) return { kind: "match", via: "cindee-is-betty-hamilton", row: betty[0], options: betty };
    }
    const phoneHits = p ? byPhone.get(p) ?? [] : [];
    const emailHits = e ? byEmail.get(e) ?? [] : [];
    const nameHits = n ? byName.get(n) ?? [] : [];
    if (phoneHits.length > 1) {
      const named = phoneHits.filter((c) => c.names.includes(n));
      if (n && named.length === 1) return { kind: "match", via: "name-among-shared-phone", row: named[0], options: named };
      return { kind: "ambiguous", via: "phone", options: phoneHits };
    }
    if (phoneHits.length === 1) return { kind: "match", via: "phone", row: phoneHits[0], options: phoneHits };
    if (emailHits.length === 1) return { kind: "match", via: "email", row: emailHits[0], options: emailHits };
    if (emailHits.length > 1) return { kind: "ambiguous", via: "email", options: emailHits };
    if (nameHits.length === 1) return { kind: "match", via: "name", row: nameHits[0], options: nameHits };
    if (nameHits.length > 1) return { kind: "ambiguous", via: "name", options: nameHits };
    return { kind: "missing", via: "", options: [] };
  }

  function ensureClient(name: string, phone: string, email: string, lead: string, why: string): ClientRow | null {
    const display = name.replace(/\s+/g, " ").trim();
    if (!display) return null;
    const found = matchClient(display, phone, email);
    if (found.kind === "ambiguous") {
      notes.push(`client ambiguous (${found.via}) for ${display}: ${found.options.map((c) => c.display).join(" | ")}`);
      return null;
    }
    if (found.kind === "match" && found.row) {
      const consent = consentNote(src.clientsReport, display, phone, email);
      const leadNote = mapLead(lead) ? "" : lead && !blank(lead) ? `Jobber lead source: ${lead}` : "";
      const next = appendNote(found.row.notes, [consent, leadNote].filter(Boolean).join("\n"));
      if (next !== (found.row.notes ?? "")) {
        db.prepare("UPDATE clients SET notes = ? WHERE id = ?").run(next, found.row.id);
        found.row.notes = next;
        stats.updates++;
      }
      return found.row;
    }
    const id = crypto.randomUUID();
    const { first, last } = splitName(display);
    const mapped = mapLead(lead);
    const extra = [
      mapped ? "" : lead && !blank(lead) ? `Jobber lead source: ${lead}` : "",
      consentNote(src.clientsReport, display, phone, email),
      `Created by Jobber historical import (${why}).`,
    ].filter(Boolean).join("\n");
    db.prepare(
      `INSERT INTO clients (id, name, first_name, last_name, phone, email, lead_source, notes, data_source, is_test, sms_opt_out, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'jobber_import', 0, 0, datetime('now'), datetime('now'), datetime('now'))`,
    ).run(
      id,
      [first, last].filter(Boolean).join(" ") || null,
      first,
      last,
      blank(phone) ? null : phone,
      blank(email) ? null : email,
      mapped,
      extra || null,
    );
    stats.inserts++;
    const row: ClientRow = {
      id, first_name: first, last_name: last, company_name: null,
      name: [first, last].filter(Boolean).join(" ") || null,
      phone: blank(phone) ? null : phone, email: blank(email) ? null : email, notes: extra || null,
      data_source: "jobber_import", display: [first, last].filter(Boolean).join(" "),
      names: [normName(display), normName([first, last].filter(Boolean).join(" "))].filter(Boolean),
    };
    row.names = [...new Set(row.names)];
    indexClient(row);
    return row;
  }

  // Clients referenced by converted quotes, invoices, jobs CSV, or the open quotes we will create.
  const needed = new Map<string, Row>();
  const consider = (name: string, phone: string, email: string, lead: string) => {
    const key = normName(name);
    if (!key || needed.has(key) || key === normName("Cindee Wright")) return;
    needed.set(key, { name, phone, email, lead });
  };
  for (const r of src.quotes) {
    const n = quoteNum(r["Quote #"]);
    const status = (r.Status ?? "").toLowerCase();
    if (status === "archived" || (n != null && SKIP_QUOTES.has(n))) continue;
    if (status === "converted" || (n != null && OPEN_CREATE.includes(n))) {
      consider(r["Client name"], r["Client phone"], r["Client email"], r["Lead source"] ?? "");
    }
  }
  for (const r of src.invoices) {
    if ((r.Status ?? "").toLowerCase() === "bad debt") continue;
    if (quoteNum(r["Invoice #"]) === 38) continue;
    consider(r["Client name"], r["Client phone"], r["Client email"], r["Lead source"] ?? "");
  }
  for (const r of src.jobsCsv) consider(r["Client name"], r["Client phone"], r["Client email"], r["Lead source"] ?? "");
  for (const spec of needed.values()) ensureClient(spec.name, spec.phone, spec.email, spec.lead, "in scope");

  // Cindee Wright stays off the client list. Her quote and the $950 invoice belong to Betty Hamilton.
  {
    const bettyHits = [...new Map((byName.get(normName("Betty Hamilton")) ?? []).map((c) => [c.id, c])).values()];
    if (bettyHits.length !== 1) {
      notes.push(`Betty Hamilton: expected 1 client, found ${bettyHits.length}`);
    } else {
      const betty = bettyHits[0];
      const next = appendNote(betty.notes, "Quote originally under Cindee Wright (Jobber).");
      if (next !== (betty.notes ?? "")) {
        db.prepare("UPDATE clients SET notes = ? WHERE id = ?").run(next, betty.id);
        betty.notes = next;
        stats.updates++;
      }
      const cindeePhone = "(501) 424-9219";
      const havePhone = db.prepare(
        `SELECT id FROM client_contacts WHERE client_id = ? AND contact_type = 'phone'
           AND substr(replace(replace(replace(replace(value,'(',''),')',''),'-',''),' ',''), -10) = '5014249219'`,
      ).get(betty.id) as { id: string } | undefined;
      if (!havePhone) {
        db.prepare(
          `INSERT INTO client_contacts (id, client_id, label, contact_type, value) VALUES (?, ?, 'Cindee Wright', 'phone', ?)`,
        ).run(crypto.randomUUID(), betty.id, cindeePhone);
        stats.inserts++;
        notes.push("Added Cindee Wright's phone as a secondary contact on Betty Hamilton. No email in the Jobber contact file. No marketing consent.");
      }
      const invLinked = db.prepare(
        `UPDATE invoices SET client_id = ?
          WHERE jobber_invoice_number = 26
            AND job_id = (SELECT id FROM jobs WHERE job_number = 26 AND client_id = ?)
            AND COALESCE(client_id, '') != ?`,
      ).run(betty.id, betty.id, betty.id);
      stats.updates += invLinked.changes ?? 0;
      const payLinked = db.prepare(
        `UPDATE payments SET client_id = ?
          WHERE job_id = (SELECT id FROM jobs WHERE job_number = 26 AND client_id = ?)
            AND amount = 950
            AND COALESCE(client_id, '') != ?`,
      ).run(betty.id, betty.id, betty.id);
      stats.updates += payLinked.changes ?? 0;
      const cindeeHits = [...new Map((byName.get(normName("Cindee Wright")) ?? []).map((c) => [c.id, c])).values()]
        .filter((c) => c.id !== betty.id);
      for (const cindee of cindeeHits) {
        db.prepare("UPDATE estimates SET client_id = ? WHERE client_id = ?").run(betty.id, cindee.id);
        const movedEst = db.prepare("SELECT changes() n").get() as { n: number };
        stats.updates += movedEst.n;
        const props = db.prepare("SELECT id, address FROM properties WHERE client_id = ?").all(cindee.id) as Array<{ id: string; address: string }>;
        for (const prop of props) {
          const dup = db.prepare(
            "SELECT id FROM properties WHERE client_id = ? AND lower(address) = lower(?) LIMIT 1",
          ).get(betty.id, prop.address) as { id: string } | undefined;
          if (dup) {
            db.prepare("DELETE FROM properties WHERE id = ?").run(prop.id);
          } else {
            db.prepare("UPDATE properties SET client_id = ? WHERE id = ?").run(betty.id, prop.id);
            stats.updates++;
          }
        }
        db.prepare("DELETE FROM clients WHERE id = ? AND data_source = 'jobber_import'").run(cindee.id);
        const removed = db.prepare("SELECT changes() n").get() as { n: number };
        if (removed.n) {
          notes.push("Removed the Jobber-import Cindee Wright client. Her quote is on Betty Hamilton.");
          for (const map of [byPhone, byEmail, byName]) {
            for (const [key, list] of map) {
              const kept = list.filter((c) => c.id !== cindee.id);
              if (kept.length) map.set(key, kept);
              else map.delete(key);
            }
          }
        }
      }
      const invCount = (db.prepare("SELECT COUNT(*) n FROM invoices WHERE jobber_invoice_number = 26").get() as { n: number }).n;
      if (invCount !== 1) notes.push(`invoice #26 count is ${invCount}, expected 1`);
    }
  }

  // Properties, de-duplicated by client + street.
  for (const p of src.properties) {
    const client = matchClient(p["Client Name"] ?? "", "", "");
    if (client.kind !== "match" || !client.row) continue;
    const street = (p["Street 1"] || "").trim();
    const city = (p.City || "").trim();
    const zip = (p["ZIP code"] || "").trim();
    if (!street || !city || !zip) continue;
    const exists = db.prepare(
      `SELECT id FROM properties WHERE client_id = ? AND lower(address) = lower(?) LIMIT 1`,
    ).get(client.row.id, street) as { id: string } | undefined;
    if (exists) continue;
    db.prepare(
      `INSERT INTO properties (id, client_id, address, city, state, zip, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(crypto.randomUUID(), client.row.id, street, city, (p.State || "Arkansas").trim() || "Arkansas", zip);
    stats.inserts++;
  }

  // Jobs
  type JobRec = { id: string; job_number: number | null; jobber_job_number: number | null; data_source: string | null; contract_total: number | null; title: string | null; client_id: string | null; estimate_id: string | null };
  const reloadJobs = () => db.prepare(
    `SELECT id, job_number, jobber_job_number, data_source, contract_total, title, client_id, estimate_id FROM jobs`,
  ).all() as JobRec[];
  let jobs = reloadJobs();
  const diana = jobs.find((j) => j.job_number === NATIVE_DIANA_JOB_NUMBER && (j.data_source ?? "") !== "jobber_import");
  if (!diana) throw new Error("Native Diana job 103 not found");
  if (diana.jobber_job_number == null) {
    db.prepare("UPDATE jobs SET jobber_job_number = ? WHERE id = ? AND jobber_job_number IS NULL").run(JOBBER_DIANA_JOB, diana.id);
    stats.updates++;
    diana.jobber_job_number = JOBBER_DIANA_JOB;
  }

  for (const j of jobs) {
    // Only the original import stored the Jobber number in job_number, and those stop at 99.
    // Newer CHS numbers (105+) must not be copied into jobber_job_number.
    if ((j.data_source ?? "") === "jobber_import" && j.jobber_job_number == null && j.job_number != null && j.job_number <= 99) {
      db.prepare("UPDATE jobs SET jobber_job_number = ? WHERE id = ? AND jobber_job_number IS NULL").run(j.job_number, j.id);
      stats.updates++;
      j.jobber_job_number = j.job_number;
    }
  }

  function findJob(jobberNum: number): JobRec | undefined {
    if (jobberNum === JOBBER_DIANA_JOB) return diana;
    // Match the Jobber number only. New CHS job_numbers (105+) collide with later Jobber numbers.
    return jobs.find((j) => j.jobber_job_number === jobberNum);
  }

  const quoteByNum = new Map<number, Row>();
  for (const q of src.quotes) {
    const n = quoteNum(q["Quote #"]);
    if (n != null) quoteByNum.set(n, q);
  }
  const jobCsvByNum = new Map<number, Row>();
  for (const j of src.jobsCsv) {
    const n = quoteNum(j["Job #"]);
    if (n != null) jobCsvByNum.set(n, j);
  }

  function nextJobNumber(): number {
    const row = db.prepare("SELECT COALESCE(MAX(job_number), 0) n FROM jobs").get() as { n: number };
    return row.n + 1;
  }

  function createJob(jobberNum: number, client: ClientRow, title: string, address: { street: string; city: string; state: string; zip: string }, quoteNo: number | null, invoiceNos: number[], status: string): JobRec {
    const existing = findJob(jobberNum);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const jobNumber = nextJobNumber();
    const onCsv = jobCsvByNum.has(jobberNum);
    const note = onCsv
      ? `Jobber job #${jobberNum}.`
      : `Reconstructed from Jobber quote #${quoteNo ?? "?"} and invoice(s) #${invoiceNos.join(", ") || "none"} — Jobs report omitted this job.`;
    db.prepare(
      `INSERT INTO jobs (
         id, job_number, jobber_job_number, title, status, client_id, source, data_source,
         property_address, property_city, property_state, property_zip, job_type,
         contract_total, review_enabled, review_received, notes, synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'jobber_import', 'jobber_import', ?, ?, ?, ?, 'other', NULL, 0, 0, ?, datetime('now'), datetime('now'), datetime('now'))`,
    ).run(id, jobNumber, jobberNum, title || `Jobber job ${jobberNum}`, status, client.id, address.street || null, address.city || null, address.state || "Arkansas", address.zip || null, note);
    stats.inserts++;
    const rec: JobRec = { id, job_number: jobNumber, jobber_job_number: jobberNum, data_source: "jobber_import", contract_total: null, title, client_id: client.id, estimate_id: null };
    jobs.push(rec);
    return rec;
  }

  const converted = src.quotes.filter((q) => (q.Status ?? "").toLowerCase() === "converted");
  const jobbersNeeded = new Set<number>();
  for (const q of converted) for (const n of ints(q["Job #s"])) jobbersNeeded.add(n);
  for (const inv of src.invoices) {
    if ((inv.Status ?? "").toLowerCase() === "bad debt") continue;
    if (quoteNum(inv["Invoice #"]) === 38) continue;
    for (const n of ints(inv["Job #s"])) jobbersNeeded.add(n);
  }

  for (const num of [...jobbersNeeded].sort((a, b) => a - b)) {
    if (findJob(num)) continue;
    const q = converted.find((r) => ints(r["Job #s"]).includes(num));
    const csv = jobCsvByNum.get(num);
    const invs = src.invoices.filter((r) => ints(r["Job #s"]).includes(num) && (r.Status ?? "").toLowerCase() !== "bad debt");
    const name = q?.["Client name"] || csv?.["Client name"] || invs[0]?.["Client name"] || "";
    const phone = q?.["Client phone"] || csv?.["Client phone"] || invs[0]?.["Client phone"] || "";
    const email = q?.["Client email"] || csv?.["Client email"] || invs[0]?.["Client email"] || "";
    const client = matchClient(name, phone, email);
    if (client.kind !== "match" || !client.row) {
      notes.push(`no unique client for Jobber job ${num} (${name}) — job not created`);
      continue;
    }
    const lineTitle = parseLines(q?.["Line items"] ?? "")[0]?.name ?? "";
    const title = (csv?.Title || q?.Title || lineTitle || invs[0]?.Subject || `Jobber job ${num}`).trim();
    const address = addressOf(q ?? csv ?? invs[0] ?? {});
    const statuses = invs.map((r) => (r.Status ?? "").toLowerCase());
    const status = statuses.some((s) => s === "draft") ? "unscheduled" : statuses.some((s) => s === "past due") ? "action_required" : "archived";
    createJob(num, client.row, title, address, q ? quoteNum(q["Quote #"]) : null, invs.map((r) => quoteNum(r["Invoice #"])).filter((n): n is number => n != null), status);
  }

  jobs = reloadJobs();
  // refresh diana reference after reload
  const dianaNow = jobs.find((j) => j.id === diana.id)!;

  function findJobFresh(jobberNum: number): JobRec | undefined {
    if (jobberNum === JOBBER_DIANA_JOB) return dianaNow;
    return jobs.find((j) => j.jobber_job_number === jobberNum);
  }

  // Estimates
  const estRows = db.prepare(
    `SELECT id, estimate_number, total, subtotal, client_id, notes, data_source, status, request_id FROM estimates`,
  ).all() as Array<{ id: string; estimate_number: number | null; total: number | null; subtotal: number | null; client_id: string | null; notes: string | null; data_source: string | null; status: string | null; request_id: string | null }>;
  const estByQuote = new Map<number, typeof estRows>();
  for (const e of estRows) {
    const m = (e.notes ?? "").match(/Jobber Quote #:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!m) continue;
    const n = Math.round(Number(m[1]));
    const list = estByQuote.get(n) ?? [];
    list.push(e);
    estByQuote.set(n, list);
  }

  function nextEstimateNumber(): number {
    return (db.prepare("SELECT COALESCE(MAX(estimate_number), 0) n FROM estimates").get() as { n: number }).n + 1;
  }
  function nextRequestNumber(): number {
    return (db.prepare("SELECT COALESCE(MAX(request_number), 0) n FROM estimate_requests").get() as { n: number }).n + 1;
  }

  function writeLines(estimateId: string, lines: Line[], zeroPrices: boolean) {
    const n = (db.prepare("SELECT COUNT(*) n FROM estimate_line_items WHERE estimate_id = ?").get(estimateId) as { n: number }).n;
    if (n > 0) return;
    lines.forEach((l, i) => {
      const desc = zeroPrices
        ? `Optional in Jobber, listed at $${usd(l.amount)} (qty ${l.qty}). Not included in the $0 total.`
        : `Jobber qty ${l.qty}.`;
      db.prepare(
        `INSERT INTO estimate_line_items (id, estimate_id, sort_order, product_service, description, quantity, unit_price, total, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))`,
      ).run(crypto.randomUUID(), estimateId, i + 1, l.name || "Item", desc, zeroPrices ? 0 : l.amount, zeroPrices ? 0 : l.amount);
      stats.inserts++;
    });
  }

  function gapNote(q: Row, total: number, lines: Line[]): string {
    const sum = lineSum(lines);
    const discount = money(q["Discount ($)"]) ?? 0;
    const n = quoteNum(q["Quote #"]);
    if (n === 272) return "All three items were optional in Jobber (client picks); total $0 until selected.";
    if (Math.abs(sum - total) <= 0.01) return "";
    if (discount > 0 && Math.abs(sum - total - discount) <= 0.05) {
      return `Jobber discount $${usd(discount)}. Header total is the Jobber Total $${usd(total)}, not the line sum.`;
    }
    return `Jobber total $${usd(total)} excludes optional/unselected items totaling $${usd(Math.round((sum - total) * 100) / 100)}. Line items may include options the client did not select.`;
  }

  function makeRequest(opts: {
    client: ClientRow;
    title: string;
    address: { street: string; city: string; state: string; zip: string };
    status: "won" | "lost";
    lostReason: string | null;
    sent: string | null;
    jobId: string | null;
    estimateId: string;
  }): string {
    const id = crypto.randomUUID();
    const when = opts.sent ? `${opts.sent}T12:00:00Z` : new Date().toISOString();
    db.prepare(
      `INSERT INTO estimate_requests (
         id, request_number, status, client_id, property_address, property_city, property_state, property_zip,
         job_type, lead_source, estimate_id, converted_job_id, lost_reason, lost_notes,
         follow_up_count, follow_up_sequence_active, lead_outreach_sequence_active, lead_outreach_count,
         source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'other', ?, ?, ?, ?, 0, 0, 0, 0, 'manual', ?, ?)`,
    ).run(
      id,
      nextRequestNumber(),
      opts.status,
      opts.client.id,
      opts.address.street || "Address not in Jobber export",
      opts.address.city || "Unknown",
      opts.address.state || "Arkansas",
      opts.address.zip || "00000",
      (opts.title || "historical").slice(0, 120),
      opts.estimateId,
      opts.jobId,
      opts.status === "lost" ? "other" : null,
      opts.lostReason,
      when,
      when,
    );
    stats.inserts++;
    return id;
  }

  function upsertQuote(q: Row, mode: "converted" | "open") {
    const n = quoteNum(q["Quote #"]);
    if (n == null || SKIP_QUOTES.has(n)) return;
    if ((q.Status ?? "").toLowerCase() === "archived") return;
    const total = money(q["Total ($)"]) ?? 0;
    const lines = parseLines(q["Line items"] ?? "");
    const clientMatch = matchClient(q["Client name"], q["Client phone"], q["Client email"]);
    if (mode === "open" && n === 274) {
      const hoa = [...byName.get(normName("Gap Creek HOA")) ?? []];
      if (hoa.length !== 1) {
        relinkSkips.push("274 Gap Creek HOA client was not a unique name match");
        return;
      }
      clientMatch.kind = "match";
      clientMatch.row = hoa[0];
      clientMatch.via = "gap-creek-name";
    }
    if (clientMatch.kind !== "match" || !clientMatch.row) {
      relinkSkips.push(`${n} ${q["Client name"]}: client ${clientMatch.kind}`);
      return;
    }
    const client = clientMatch.row;
    const jobsOnQuote = ints(q["Job #s"]);
    const job = jobsOnQuote.length ? findJobFresh(jobsOnQuote[0]) : undefined;
    const existing = estByQuote.get(n) ?? [];
    const addr = addressOf(q);
    const extra = [
      `Jobber Quote #: ${n}`,
      `Jobber status: ${q.Status}`,
      gapNote(q, total, lines),
    ].filter(Boolean).join("\n");

    if (existing.length > 1) {
      relinkSkips.push(`${n} has ${existing.length} estimates — not overwritten`);
      return;
    }
    if (existing.length === 1) {
      const e = existing[0];
      if (e.client_id !== client.id) {
        db.prepare("UPDATE estimates SET client_id = ? WHERE id = ?").run(client.id, e.id);
        stats.updates++;
        relinks.push(`${n} → ${client.display} (${clientMatch.via})`);
      }
      const keepPrior = e.estimate_number != null ? KEEP_STUB_TOTAL[e.estimate_number] : undefined;
      if (keepPrior != null && cents(e.total) !== cents(keepPrior)) {
        headerChanges.push(`${e.estimate_number} quote ${n}: $${e.total ?? 0} -> $${keepPrior} (header restored)`);
        db.prepare(`UPDATE estimates SET total = ?, subtotal = ? WHERE id = ?`).run(keepPrior, keepPrior, e.id);
        stats.updates++;
        e.total = keepPrior;
        e.subtotal = keepPrior;
      } else if (
        e.estimate_number != null &&
        APPROVED_STUBS.has(e.estimate_number) &&
        (e.data_source ?? "") === "jobber_import" &&
        cents(e.total) !== cents(total)
      ) {
        headerChanges.push(`${e.estimate_number} quote ${n}: $${e.total ?? 0} -> $${total}`);
        db.prepare(`UPDATE estimates SET total = ?, subtotal = ? WHERE id = ?`).run(total, total, e.id);
        stats.updates++;
      }
      // 9000 is corrected to the Jobber total. Keep the quote-total note
      // that the $0 stub carried, since the lines already match the header.
      const noteBits = keepPrior != null || e.estimate_number === 9000
        ? `Jobber quote total $${usd(total)}.`
        : gapNote(q, total, lines);
      const nextNotes = appendNote(e.notes, noteBits);
      if (nextNotes !== (e.notes ?? "")) {
        db.prepare("UPDATE estimates SET notes = ? WHERE id = ?").run(nextNotes, e.id);
        stats.updates++;
      }
      writeLines(e.id, lines, n === 272);
      if (job && !job.estimate_id) {
        db.prepare("UPDATE jobs SET estimate_id = ? WHERE id = ? AND estimate_id IS NULL").run(e.id, job.id);
        stats.updates++;
        job.estimate_id = e.id;
      }
      return;
    }

    const estId = crypto.randomUUID();
    const status = mode === "open" ? "viewed" : "approved";
    const sent = isoDate(q["Sent date"]);
    db.prepare(
      `INSERT INTO estimates (
         id, estimate_number, client_id, title, status, subtotal, tax_amount, total, notes, data_source,
         is_current_version, sent_at, include_contract, include_reviews, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'jobber_import', 1, ?, 0, 0, 1, ?, datetime('now'))`,
    ).run(
      estId,
      nextEstimateNumber(),
      client.id,
      (q.Title || "").trim() || `Jobber quote ${n}`,
      status,
      total,
      total,
      extra,
      sent ? `${sent}T12:00:00Z` : null,
      sent ? `${sent}T12:00:00Z` : new Date().toISOString(),
    );
    stats.inserts++;
    writeLines(estId, lines, n === 272);
    const reqId = makeRequest({
      client,
      title: q.Title || `Jobber quote ${n}`,
      address: addr,
      status: mode === "open" ? "lost" : "won",
      lostReason: mode === "open" ? "Jobber historical quote — not a live lead. Revise clones a draft that recomputes from lines." : null,
      sent,
      jobId: job?.id ?? null,
      estimateId: estId,
    });
    db.prepare("UPDATE estimates SET request_id = ? WHERE id = ?").run(reqId, estId);
    stats.updates++;
    if (job && !job.estimate_id) {
      db.prepare("UPDATE jobs SET estimate_id = ? WHERE id = ? AND estimate_id IS NULL").run(estId, job.id);
      stats.updates++;
      job.estimate_id = estId;
    }
    estByQuote.set(n, [{ id: estId, estimate_number: null, total, subtotal: total, client_id: client.id, notes: extra, data_source: "jobber_import", status, request_id: reqId }]);
  }

  for (const q of converted) upsertQuote(q, "converted");
  for (const n of OPEN_CREATE) {
    const q = quoteByNum.get(n);
    if (!q) notes.push(`open quote ${n} missing from CSV`);
    else upsertQuote(q, "open");
  }
  notes.push("Skipped quote 273 (Ann Dinh hand-keyed estimate 287 — not overwritten).");
  notes.push("Skipped quote 277 (Lori Helberg $400 Tile — cancelled, nothing created).");

  // contract_total where empty and a converted quote links the job.
  const quotesByJob = new Map<number, Row[]>();
  for (const q of converted) {
    for (const jn of ints(q["Job #s"])) {
      const list = quotesByJob.get(jn) ?? [];
      list.push(q);
      quotesByJob.set(jn, list);
    }
  }
  for (const [jn] of quotesByJob) {
    if (!findJobFresh(jn)) invoiceDiffs.push(`Jobber job ${jn} has no CHS job`);
  }

  // Invoices. Match only rows that already existed. Inserts are not candidates,
  // so a second invoice with the same total (Alicia 143 and 150) is created too.
  type InvRec = { id: string; total: number | null; status: string | null; job_id: string | null; client_id: string | null; jobber_invoice_number: number | null; issued: string | null };
  const originals = db.prepare(
    `SELECT id, total, status, job_id, client_id, jobber_invoice_number, substr(issued_date,1,10) issued FROM invoices`,
  ).all() as InvRec[];

  const usedInv = new Set<string>();
  function take(row: InvRec | undefined): InvRec | undefined {
    if (!row || usedInv.has(row.id)) return undefined;
    usedInv.add(row.id);
    return row;
  }
  function ownerOf(inv: InvRec): string | null {
    if (inv.client_id) return inv.client_id;
    if (!inv.job_id) return null;
    return jobs.find((j) => j.id === inv.job_id)?.client_id ?? null;
  }
  function matchInvoice(num: number, jobId: string | null, clientId: string, total: number, issued: string | null, groupSize: number): InvRec | undefined {
    const byNum = originals.find((i) => i.jobber_invoice_number === num && !usedInv.has(i.id));
    if (byNum) return take(byNum);
    const sameTotal = originals.filter((i) => !usedInv.has(i.id) && cents(i.total) === cents(total));
    const pool = jobId
      ? sameTotal.filter((i) => i.job_id === jobId)
      : sameTotal.filter((i) => ownerOf(i) === clientId || (i.job_id == null && i.client_id == null));
    const dated = pool.filter((i) => issued && i.issued === issued);
    if (dated.length === 1) return take(dated[0]);
    const owned = pool.filter((i) => ownerOf(i) === clientId);
    if (owned.length === 1) return take(owned[0]);
    if (pool.length === 1) return take(pool[0]);
    if (owned.length === groupSize && groupSize > 0) {
      return take(owned.slice().sort((a, b) => (a.issued ?? "").localeCompare(b.issued ?? ""))[0]);
    }
    if (!jobId && pool.length === groupSize && groupSize > 0) {
      return take(pool.slice().sort((a, b) => (a.issued ?? "").localeCompare(b.issued ?? ""))[0]);
    }
    return undefined;
  }

  function insertInvoice(opts: {
    num: number | null;
    jobId: string | null;
    clientId: string;
    total: number;
    status: string;
    issued: string | null;
    due: string | null;
    title: string;
    invoiceType: string | null;
    hold: boolean;
    note: string;
    paidAmount: number | null;
    paidDate: string | null;
  }): string {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO invoices (
         id, job_id, client_id, title, amount, tax_amount, total, total_due, status,
         issued_date, due_date, paid_amount, paid_date, invoice_type, data_source,
         jobber_invoice_number, billing_hold, notes, synced_at, created_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'jobber_import', ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      id, opts.jobId, opts.clientId, opts.title, opts.total, opts.total, opts.total, opts.status,
      opts.issued, opts.due, opts.paidAmount, opts.paidDate, opts.invoiceType, opts.num,
      opts.hold ? 1 : 0, opts.note || null,
    );
    stats.inserts++;
    createdInvoices.push(`#${opts.num ?? "deposit"} $${opts.total} ${opts.status} ${opts.title}`);
    return id;
  }

  const invoiceIdByNumber = new Map<number, string>();
  const depositInvoiceByNumber = new Map<number, { id: string; amount: number }>();
  const groupCount = new Map<string, number>();
  for (const inv of src.invoices) {
    const key = `${normName(inv["Client name"])}|${ints(inv["Job #s"]).join("+")}|${cents(money(inv["Total ($)"]))}`;
    groupCount.set(key, (groupCount.get(key) ?? 0) + 1);
  }
  function billOnlyJob(client: ClientRow): JobRec {
    const title = "Maintenance / Billing Only (Jobber history)";
    let bill = jobs.find((j) => j.client_id === client.id && (j.title ?? "") === title && (j.data_source ?? "") === "jobber_import");
    if (bill) return bill;
    const id = crypto.randomUUID();
    const jobNumber = nextJobNumber();
    db.prepare(
      `INSERT INTO jobs (id, job_number, title, status, client_id, source, data_source, job_type, review_enabled, review_received, notes, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, 'archived', ?, 'jobber_import', 'jobber_import', 'other', 0, 0, 'Bill-only Jobber history. No Jobber job number.', datetime('now'), datetime('now'), datetime('now'))`,
    ).run(id, jobNumber, title, client.id);
    stats.inserts++;
    bill = { id, job_number: jobNumber, jobber_job_number: null, data_source: "jobber_import", contract_total: null, title, client_id: client.id, estimate_id: null };
    jobs.push(bill);
    return bill;
  }
  const invoiceRows = src.invoices.slice().sort((a, b) => (isoDate(a["Issued date"]) ?? "").localeCompare(isoDate(b["Issued date"]) ?? ""));
  for (const inv of invoiceRows) {
    const num = quoteNum(inv["Invoice #"]);
    if (num == null) continue;
    const statusRaw = (inv.Status ?? "").toLowerCase();
    if (statusRaw === "bad debt" || num === 38) {
      notes.push(`left invoice #${num} (${inv.Status}) untouched`);
      continue;
    }
    const total = money(inv["Total ($)"]) ?? 0;
    const issued = isoDate(inv["Issued date"]);
    const due = isoDate(inv["Due date"]) ?? issued;
    const jobNums = ints(inv["Job #s"]);
    let job = jobNums.length ? findJobFresh(jobNums[0]) : undefined;
    const clientMatch = matchClient(inv["Client name"], inv["Client phone"], inv["Client email"]);
    const clientId = job?.client_id || (clientMatch.kind === "match" ? clientMatch.row?.id : null);
    if (!clientId) {
      notes.push(`invoice #${num} has no client — skipped`);
      continue;
    }
    const hold = HOLD_NOTE[num] != null;
    let status = statusRaw === "paid" ? "paid" : statusRaw === "past due" ? "past_due" : statusRaw === "draft" ? "draft" : "draft";
    if (num === 149) status = "paid";
    const deposit = money(inv["Deposit $"]) ?? 0;
    const balance = money(inv["Balance ($)"]);
    if (DEPOSIT_SPLIT.has(num) && deposit > 0) {
      const existingMain = matchInvoice(num, job?.id ?? null, clientId, Math.round((total - deposit) * 100) / 100, issued, 1)
        ?? matchInvoice(num, job?.id ?? null, clientId, total, issued, 1);
      if (!existingMain) {
        const depId = insertInvoice({
          num: null, jobId: job?.id ?? null, clientId, total: deposit, status: "paid",
          issued, due, title: `Deposit — Jobber invoice #${num}`, invoiceType: "deposit",
          hold: false, note: `Deposit received for Jobber invoice #${num}.`, paidAmount: deposit, paidDate: issued,
        });
        const mainId = insertInvoice({
          num, jobId: job?.id ?? null, clientId, total: Math.round((total - deposit) * 100) / 100,
          status: "draft", issued, due, title: inv.Subject || `Jobber invoice #${num}`,
          invoiceType: "manual", hold, note: HOLD_NOTE[num] ?? `Remainder of Jobber invoice #${num} after the $${usd(deposit)} deposit.`,
          paidAmount: null, paidDate: null,
        });
        invoiceIdByNumber.set(num, mainId);
        depositInvoiceByNumber.set(num, { id: depId, amount: deposit });
        notes.push(`split Jobber #${num} into deposit ${depId.slice(0, 8)} and remainder ${mainId.slice(0, 8)}`);
      } else {
        invoiceIdByNumber.set(num, existingMain.id);
      }
      continue;
    }
    const groupKey = `${normName(inv["Client name"])}|${jobNums.join("+")}|${cents(total)}`;
    const existing = matchInvoice(num, job?.id ?? null, clientId, total, issued, groupCount.get(groupKey) ?? 1);
    if (existing) {
      invoiceIdByNumber.set(num, existing.id);
      if (existing.jobber_invoice_number == null) {
        db.prepare("UPDATE invoices SET jobber_invoice_number = ? WHERE id = ? AND jobber_invoice_number IS NULL").run(num, existing.id);
        stats.updates++;
        existing.jobber_invoice_number = num;
      }
      if (hold) {
        const row = db.prepare("SELECT notes, billing_hold, status FROM invoices WHERE id = ?").get(existing.id) as { notes: string | null; billing_hold: number; status: string };
        const next = appendNote(row.notes, HOLD_NOTE[num]);
        if (next !== (row.notes ?? "") || row.billing_hold !== 1) {
          db.prepare("UPDATE invoices SET notes = ?, billing_hold = 1 WHERE id = ?").run(next, existing.id);
          stats.updates++;
        }
      }
      if (num === 149 && existing.status !== "paid") {
        db.prepare("UPDATE invoices SET status = 'paid', paid_amount = ?, paid_date = COALESCE(paid_date, '2026-09-18'), data_source = 'jobber_import' WHERE id = ?").run(total, existing.id);
        stats.updates++;
      }
      continue;
    }
    const paid = status === "paid";
    if (!job && clientMatch.kind === "match" && clientMatch.row) job = billOnlyJob(clientMatch.row);
    const id = insertInvoice({
      num, jobId: job?.id ?? null, clientId, total, status, issued, due,
      title: inv.Subject || `Jobber invoice #${num}`, invoiceType: "manual", hold,
      note: HOLD_NOTE[num] ?? "",
      paidAmount: paid ? (balance === 0 ? total : Math.round((total - (balance ?? 0)) * 100) / 100) : null,
      paidDate: paid ? (issued ?? due) : null,
    });
    invoiceIdByNumber.set(num, id);
  }

  // Tag existing Jobber-id invoices so the invoice data_source exclusion covers them.
  const tagged = db.prepare(
    `UPDATE invoices SET data_source = 'jobber_import' WHERE data_source IS NULL AND id LIKE 'Z2lkOi8vSm9iYmVy%'`,
  ).run();
  stats.updates += tagged.changes ?? 0;

  // Payments from the transaction list. One-to-one with an existing same-amount row on the job.
  const payRows = db.prepare(
    `SELECT id, job_id, invoice_id, client_id, amount, substr(COALESCE(received_date, collected_at),1,10) d, payment_method FROM payments`,
  ).all() as Array<{ id: string; job_id: string | null; invoice_id: string | null; client_id: string | null; amount: number; d: string | null; payment_method: string | null }>;
  const usedPay = new Set<string>();
  for (const t of src.txns) {
    const type = (t.Type ?? "").toLowerCase();
    if (type.includes("refund")) {
      if (normName(t["Client name"]).includes("christi") && Math.abs(money(t["Total $"]) ?? 0) === 2500) {
        const christi = matchClient(t["Client name"], "", "");
        if (christi.kind === "match" && christi.row) {
          const text = "Christi Marret refund of $2,500 on Sep 18, 2024 is in the Jobber transaction list only. No negative payment was posted.";
          const next = appendNote(christi.row.notes, text);
          if (next !== (christi.row.notes ?? "")) {
            db.prepare("UPDATE clients SET notes = ? WHERE id = ?").run(next, christi.row.id);
            christi.row.notes = next;
            stats.updates++;
          }
        }
      }
      continue;
    }
    if (type !== "payment" && type !== "deposit") continue;
    const amount = Math.abs(money(t["Total $"]) ?? 0);
    if (amount <= 0) continue;
    const date = isoDate(t.Date);
    const invNum = quoteNum(t["Invoice #"]);
    const jobNum = quoteNum(t["Job #"]);
    const job = jobNum != null ? findJobFresh(jobNum) : undefined;
    const depositInv = invNum != null ? depositInvoiceByNumber.get(invNum) : undefined;
    const invoiceId = depositInv && cents(depositInv.amount) === cents(amount)
      ? depositInv.id
      : invNum != null ? invoiceIdByNumber.get(invNum) ?? null : null;
    const jobId = job?.id ?? (invoiceId ? (db.prepare("SELECT job_id FROM invoices WHERE id = ?").get(invoiceId) as { job_id: string | null }).job_id : null);
    const clientMatch = matchClient(t["Client name"], "", "");
    const clientId = job?.client_id || (clientMatch.kind === "match" ? clientMatch.row?.id : null);
    const hit = payRows.find((p) => !usedPay.has(p.id) && cents(p.amount) === cents(amount) && (jobId ? p.job_id === jobId : p.invoice_id === invoiceId) && (!date || !p.d || p.d === date));
    if (hit) {
      usedPay.add(hit.id);
      if (invoiceId && !hit.invoice_id) {
        db.prepare("UPDATE payments SET invoice_id = ? WHERE id = ? AND invoice_id IS NULL").run(invoiceId, hit.id);
        stats.updates++;
        hit.invoice_id = invoiceId;
      }
      continue;
    }
    // Same amount already on the job on a different date still counts as the imported Jobber row
    // when only one unmatched row has that amount (the $12,000 Ian payment was stored on the invoice date).
    const loose = payRows.find((p) => !usedPay.has(p.id) && cents(p.amount) === cents(amount) && jobId && p.job_id === jobId);
    if (loose) {
      usedPay.add(loose.id);
      continue;
    }
    // GraphQL payments were often stored with no job. Same cents, one such row
    // (or the only one within three weeks) is that payment — link it, don't copy it.
    const orphans = payRows.filter((p) => !usedPay.has(p.id) && p.job_id == null && cents(p.amount) === cents(amount));
    let orphan = orphans.length === 1 ? orphans[0] : undefined;
    if (!orphan && date && orphans.length > 1) {
      const ranked = orphans
        .map((p) => ({ p, days: p.d ? Math.abs(Date.parse(p.d) - Date.parse(date)) / 86400000 : 9999 }))
        .sort((a, b) => a.days - b.days);
      if (ranked[0].days <= 21 && (ranked.length === 1 || ranked[1].days - ranked[0].days > 1)) orphan = ranked[0].p;
    }
    if (orphan) {
      usedPay.add(orphan.id);
      if ((jobId && !orphan.job_id) || (invoiceId && !orphan.invoice_id)) {
        db.prepare(
          `UPDATE payments SET job_id = COALESCE(job_id, ?), invoice_id = COALESCE(invoice_id, ?), client_id = COALESCE(client_id, ?) WHERE id = ?`,
        ).run(jobId, invoiceId, clientId, orphan.id);
        stats.updates++;
        orphan.job_id = orphan.job_id ?? jobId;
        orphan.invoice_id = orphan.invoice_id ?? invoiceId;
        orphan.client_id = orphan.client_id ?? clientId;
      }
      continue;
    }
    const mapped = mapPay(t.Method ?? "");
    if (!jobId && clientId) {
      const owner = (p: { client_id: string | null; job_id: string | null }) =>
        p.client_id ?? (p.job_id ? jobs.find((j) => j.id === p.job_id)?.client_id ?? null : null);
      const sameClient = payRows.filter((p) => !usedPay.has(p.id) && cents(p.amount) === cents(amount) && owner(p) === clientId);
      const dated = sameClient.filter((p) => date && p.d === date);
      if (dated.length === 1) {
        usedPay.add(dated[0].id);
        continue;
      }
    }
    if (!jobId && !invoiceId) {
      notes.push(`payment ${amount} on ${date} for ${t["Client name"]} has no job — skipped`);
      continue;
    }
    const id = crypto.randomUUID();
    const note = [`Jobber ${t.Type} imported.`, mapped.extra, t.Note && !blank(t.Note) ? t.Note : ""].filter(Boolean).join(" ");
    db.prepare(
      `INSERT INTO payments (id, job_id, invoice_id, client_id, amount, convenience_fee, stripe_fee, net_amount, payment_method, received_date, collected_at, notes, data_source, synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'jobber_import', datetime('now'), datetime('now'))`,
    ).run(id, jobId, invoiceId, clientId, amount, amount, mapped.method, date, date, note);
    stats.inserts++;
    createdPayments.push(`${date} $${amount} ${mapped.method} ${t["Client name"]} job ${jobNum ?? "?"} inv ${invNum ?? "?"}`);
    payRows.push({ id, job_id: jobId, invoice_id: invoiceId, client_id: clientId, amount, d: date, payment_method: mapped.method });
    usedPay.add(id);
  }

  // A Jobber invoice we matched can still be a CHS draft until its payment lands.
  // Flip it only when the payments now linked to that invoice cover the total.
  const coveredDrafts = db.prepare(
    `SELECT i.id, i.total FROM invoices i
      WHERE i.status = 'draft' AND i.jobber_invoice_number IS NOT NULL
        AND (SELECT ROUND(COALESCE(SUM(p.amount), 0), 2) FROM payments p WHERE p.invoice_id = i.id) >= i.total - 0.01`,
  ).all() as Array<{ id: string; total: number }>;
  for (const row of coveredDrafts) {
    const flipped = db.prepare(
      `UPDATE invoices SET status = 'paid', paid_amount = ?, total_due = ? WHERE id = ? AND status = 'draft'`,
    ).run(row.total, row.total, row.id);
    stats.updates += flipped.changes ?? 0;
  }

  // Ian Hawk #131 must be paid with both payments. Job 75 $600 void.
  const ian = invoiceIdByNumber.get(131);
  if (ian) {
    const paid = (db.prepare("SELECT ROUND(COALESCE(SUM(amount),0),2) n FROM payments WHERE invoice_id = ?").get(ian) as { n: number }).n;
    if (Math.abs(paid - 18877.5) <= 0.01) {
      db.prepare("UPDATE invoices SET status = 'paid', paid_amount = 18877.5, total_due = 18877.5, paid_date = COALESCE(paid_date, '2026-06-18') WHERE id = ? AND status != 'paid'").run(ian);
      const ch = db.prepare("SELECT changes() n").get() as { n: number };
      stats.updates += ch.n;
    } else notes.push(`Ian #131 payments sum to ${paid}, expected 18877.50`);
  }
  const voided = db.prepare(
    `UPDATE invoices SET status = 'void', notes = 'Voided by owner Oct 2026 - no matching Jobber invoice.'
      WHERE total = 600 AND status != 'void'
        AND job_id IN (SELECT id FROM jobs WHERE job_number = 75 AND data_source = 'jobber_import')`,
  ).run();
  stats.updates += voided.changes ?? 0;

  // Link Diana's two existing payments to invoice 149 if they are still unassigned.
  const dianaInv = invoiceIdByNumber.get(149);
  if (dianaInv && dianaNow) {
    db.prepare(
      `UPDATE payments SET invoice_id = ? WHERE job_id = ? AND invoice_id IS NULL AND amount = 2125`,
    ).run(dianaInv, dianaNow.id);
    const ch = db.prepare("SELECT changes() n").get() as { n: number };
    stats.updates += ch.n;
    const stamped = db.prepare(
      `UPDATE invoices SET status = 'paid', paid_amount = 4250, total_due = 4250, paid_date = COALESCE(paid_date, '2026-09-18'), data_source = 'jobber_import'
        WHERE id = ? AND (status != 'paid' OR COALESCE(paid_amount, 0) != 4250 OR COALESCE(data_source, '') != 'jobber_import')`,
    ).run(dianaInv);
    stats.updates += stamped.changes ?? 0;
  }

  for (const [jn, qs] of quotesByJob) {
    const job = findJobFresh(jn);
    if (!job) continue;
    const quoteTotal = Math.round(qs.reduce((s, q) => s + (money(q["Total ($)"]) ?? 0), 0) * 100) / 100;
    const invoiced = (db.prepare(
      `SELECT ROUND(COALESCE(SUM(total),0),2) n FROM invoices WHERE job_id = ? AND COALESCE(status,'') != 'void'`,
    ).get(job.id) as { n: number }).n;
    const fresh = db.prepare("SELECT contract_total, notes FROM jobs WHERE id = ?").get(job.id) as {
      contract_total: number | null;
      notes: string | null;
    };
    // Invoiced above the quote becomes the contract. A shortfall stays at the quote total for review.
    // Clayton (Jobber 102) is cancelled: contract is the $400 deposit, set below, and he is not an uninvoiced balance.
    // Charlie (Jobber 99) was collected outside Jobber: contract stays the quote, and he is not an uninvoiced balance.
    const clayton = jn === 102;
    const charlie = jn === 99;
    const extras = invoiced - quoteTotal > 1;
    const short = quoteTotal - invoiced > 1;
    const target = extras ? invoiced : quoteTotal;
    if (!clayton && cents(fresh.contract_total) !== cents(target)) {
      db.prepare("UPDATE jobs SET contract_total = ? WHERE id = ?").run(target, job.id);
      stats.updates++;
      contractFills.push(`CHS ${job.job_number} / Jobber ${jn}: contract_total $${target} (${extras ? "invoiced" : "quote"})`);
    }
    if (extras) {
      const text = `Jobber quote $${usd(quoteTotal)}; invoiced $${usd(invoiced)} (change orders/extras)`;
      const next = appendNote(fresh.notes, text);
      if (next !== (fresh.notes ?? "")) {
        db.prepare("UPDATE jobs SET notes = ? WHERE id = ?").run(next, job.id);
        stats.updates++;
      }
      invoiceDiffs.push(`EXTRAS Jobber ${jn} / CHS ${job.job_number}: quote $${quoteTotal} invoiced $${invoiced} → contract $${invoiced}`);
    } else if (short && !clayton && !charlie) {
      invoiceDiffs.push(`REVIEW Jobber ${jn} / CHS ${job.job_number}: quote $${quoteTotal} invoiced $${invoiced} → contract stays $${quoteTotal}`);
    }
  }

  // Tony's status and contract corrections. Amounts on invoices and payments are not touched.
  const tonyFixes: Array<{ jobNumber: number; status: string; contract?: number; note: string }> = [
    { jobNumber: 110, status: "in_progress", contract: 23900, note: "Final $4,780 to be invoiced at completion." },
    { jobNumber: 99, status: "action_required", note: "Collected - invoice/payment to be recorded in CHS." },
    { jobNumber: 105, status: "action_required", note: "Insurance claim in dispute; $2,350 unbilled." },
    { jobNumber: 106, status: "cancelled", contract: 400, note: "Cancelled. Quote $1,750; $400 non-refundable deposit retained." },
  ];
  for (const fix of tonyFixes) {
    const row = db.prepare("SELECT id, status, contract_total, notes, job_number FROM jobs WHERE job_number = ?").get(fix.jobNumber) as {
      id: string; status: string | null; contract_total: number | null; notes: string | null; job_number: number;
    } | undefined;
    if (!row) {
      jobFixes.push(`CHS ${fix.jobNumber} missing`);
      continue;
    }
    if (row.status !== fix.status) {
      db.prepare("UPDATE jobs SET status = ? WHERE id = ? AND status != ?").run(fix.status, row.id, fix.status);
      const ch = db.prepare("SELECT changes() n").get() as { n: number };
      stats.updates += ch.n;
    }
    if (fix.contract != null && cents(row.contract_total) !== cents(fix.contract)) {
      db.prepare("UPDATE jobs SET contract_total = ? WHERE id = ?").run(fix.contract, row.id);
      stats.updates++;
    }
    const next = appendNote(row.notes, fix.note);
    if (next !== (row.notes ?? "")) {
      db.prepare("UPDATE jobs SET notes = ? WHERE id = ?").run(next, row.id);
      stats.updates++;
    }
    jobFixes.push(`CHS ${fix.jobNumber}: status ${fix.status}${fix.contract != null ? `, contract $${usd(fix.contract)}` : ""}`);
  }

  // Orphan Jobber invoices have a number but no job and no client. Attach client_id
  // from the Invoices CSV name. Amounts and statuses stay as they are.
  // Shared-phone clients are matched by name inside matchClient, never merged.
  const csvByInvoice = new Map<number, Row>();
  for (const inv of src.invoices) {
    const num = quoteNum(inv["Invoice #"]);
    if (num != null) csvByInvoice.set(num, inv);
  }
  const orphans = db.prepare(
    `SELECT id, jobber_invoice_number, total, status FROM invoices WHERE job_id IS NULL AND client_id IS NULL AND jobber_invoice_number IS NOT NULL`,
  ).all() as Array<{ id: string; jobber_invoice_number: number; total: number | null; status: string | null }>;
  for (const inv of orphans) {
    const csv = csvByInvoice.get(inv.jobber_invoice_number);
    if (!csv) {
      orphanUnmatched.push(`#${inv.jobber_invoice_number} $${inv.total} has no Invoices CSV row`);
      continue;
    }
    const clientName = csv["Client name"] ?? "";
    const found = matchClient(clientName, csv["Client phone"] ?? "", csv["Client email"] ?? "");
    if (found.kind !== "match" || !found.row) {
      const who = found.options.map((c) => c.display).join(" | ") || "none";
      orphanUnmatched.push(`#${inv.jobber_invoice_number} ${clientName}: ${found.kind || "missing"} (${who})`);
      continue;
    }
    const linked = db.prepare(
      `UPDATE invoices SET client_id = ? WHERE id = ? AND client_id IS NULL AND job_id IS NULL`,
    ).run(found.row.id, inv.id);
    stats.updates += linked.changes ?? 0;
    const pays = db.prepare(
      `UPDATE payments SET client_id = ? WHERE invoice_id = ? AND client_id IS NULL`,
    ).run(found.row.id, inv.id);
    stats.updates += pays.changes ?? 0;
    orphanLinks.push(`#${inv.jobber_invoice_number} $${inv.total} ${inv.status} → ${found.row.display} (${pays.changes ?? 0} payments)`);
  }

  // Gap Creek HOA and Mike Lee stay two clients. Link their quotes, jobs, invoices,
  // and payments by the CSV Client name, never by the shared phone.
  const splitNote = "Mike Lee is president of Gap Creek HOA. Separate billing: personal home vs. HOA.";
  function uniqueByName(label: string): ClientRow | null {
    const hits = [...new Map((byName.get(normName(label)) ?? []).map((c) => [c.id, c])).values()];
    if (hits.length !== 1) {
      notes.push(`${label}: expected 1 client by name, found ${hits.length}`);
      return null;
    }
    return hits[0];
  }
  const hoa = uniqueByName("Gap Creek HOA");
  const mike = uniqueByName("Mike Lee");
  const byLabel = new Map<string, ClientRow>();
  if (hoa) byLabel.set(normName("Gap Creek HOA"), hoa);
  if (mike) byLabel.set(normName("Mike Lee"), mike);
  for (const [label, row] of [["Gap Creek HOA", hoa], ["Mike Lee", mike]] as const) {
    if (!row) continue;
    const next = appendNote(row.notes, splitNote);
    if (next !== (row.notes ?? "")) {
      db.prepare("UPDATE clients SET notes = ? WHERE id = ?").run(next, row.id);
      row.notes = next;
      stats.updates++;
    }
    nameLinks.push(`${label} kept (${row.id})`);
  }
  function assignClient(table: "estimates" | "jobs" | "invoices" | "payments" | "estimate_requests", id: string, clientId: string, label: string) {
    const changed = db.prepare(
      `UPDATE ${table} SET client_id = ? WHERE id = ? AND COALESCE(client_id, '') != ?`,
    ).run(clientId, id, clientId);
    const n = changed.changes ?? 0;
    if (n > 0) {
      stats.updates += n;
      nameLinks.push(`${label} → ${clientId === hoa?.id ? "Gap Creek HOA" : "Mike Lee"}`);
    }
  }
  for (const q of src.quotes) {
    const client = byLabel.get(normName(q["Client name"] ?? ""));
    if (!client) continue;
    const n = quoteNum(q["Quote #"]);
    if (n == null) continue;
    for (const e of estByQuote.get(n) ?? []) {
      assignClient("estimates", e.id, client.id, `quote ${n}`);
      if (e.request_id) assignClient("estimate_requests", e.request_id, client.id, `quote ${n} request`);
    }
    if ((estByQuote.get(n) ?? []).length === 0) nameLinks.push(`quote ${n} ${q["Client name"]} has no CHS estimate`);
    for (const jn of ints(q["Job #s"])) {
      const job = findJobFresh(jn);
      if (!job) {
        nameLinks.push(`quote ${n} Jobber job ${jn} has no CHS job`);
        continue;
      }
      assignClient("jobs", job.id, client.id, `CHS job ${job.job_number} / Jobber ${jn}`);
    }
  }
  for (const inv of src.invoices) {
    const client = byLabel.get(normName(inv["Client name"] ?? ""));
    if (!client) continue;
    const num = quoteNum(inv["Invoice #"]);
    if (num == null) continue;
    const id = invoiceIdByNumber.get(num);
    if (!id) {
      nameLinks.push(`invoice #${num} ${inv["Client name"]} not in CHS`);
      continue;
    }
    assignClient("invoices", id, client.id, `invoice #${num}`);
    const pays = db.prepare(
      `SELECT id FROM payments WHERE invoice_id = ? OR job_id = (SELECT job_id FROM invoices WHERE id = ?)`,
    ).all(id, id) as Array<{ id: string }>;
    pays.forEach((p, i) => assignClient("payments", p.id, client.id, `invoice #${num} payment ${i + 1}`));
  }

  // Bad-debt remainders were stored as payment rows. They are write-offs, not cash.
  // Status and invoice total stay as they are. There is no write-off column;
  // status bad_debt plus the note is the write-off, and paid_amount is the cash.
  const writeoffFixes: string[] = [];
  function oneClient(label: string): string | null {
    const hits = [...new Map((byName.get(normName(label)) ?? []).map((c) => [c.id, c])).values()];
    if (hits.length !== 1) {
      notes.push(`${label}: expected 1 client for the write-off, found ${hits.length}`);
      return null;
    }
    return hits[0].id;
  }
  const kathleenId = oneClient("Kathleen Paul");
  const boydId = oneClient("Mike Boyd");
  const droppedWriteoffs = db.prepare(
    `DELETE FROM payments WHERE id IN (?, ?)`,
  ).run(
    "Z2lkOi8vSm9iYmVyL1BheW1lbnRSZWNvcmQvMjcyOTE0NjYx",
    "Z2lkOi8vSm9iYmVyL1BheW1lbnRSZWNvcmQvMjkzOTgyODY1",
  );
  stats.updates += droppedWriteoffs.changes ?? 0;
  if ((droppedWriteoffs.changes ?? 0) > 0) {
    writeoffFixes.push(`removed ${droppedWriteoffs.changes} write-off payment row(s)`);
  }
  function setCheck(id: string, clientId: string, date: string, note: string) {
    const changed = db.prepare(
      `UPDATE payments
          SET client_id = ?, received_date = ?, collected_at = ?, payment_method = 'check', notes = ?
        WHERE id = ?
          AND (COALESCE(client_id, '') != ?
            OR COALESCE(substr(received_date, 1, 10), '') != ?
            OR COALESCE(substr(collected_at, 1, 10), '') != ?
            OR COALESCE(payment_method, '') != 'check'
            OR COALESCE(notes, '') != ?)`,
    ).run(clientId, date, date, note, id, clientId, date, date, note);
    stats.updates += changed.changes ?? 0;
  }
  if (kathleenId) {
    setCheck(
      "Z2lkOi8vSm9iYmVyL1BheW1lbnRSZWNvcmQvMTc2MjU5Mjky",
      kathleenId,
      "2024-06-06",
      "Check #6006. Same check as the Apr 29, 2024 deposit, which was not posted.",
    );
    setCheck(
      "Z2lkOi8vSm9iYmVyL1BheW1lbnRSZWNvcmQvMTc3ODg2NjI0",
      kathleenId,
      "2024-06-17",
      "Check.",
    );
  }
  function stampBadDebt(jobNumber: number, total: number, clientId: string | null, jobberNum: number, cash: number, note: string) {
    if (!clientId) return;
    const inv = db.prepare(
      `SELECT i.id, i.notes FROM invoices i
         JOIN jobs j ON j.id = i.job_id
        WHERE j.job_number = ? AND i.total = ? AND lower(COALESCE(i.status, '')) = 'bad_debt'`,
    ).get(jobNumber, total) as { id: string; notes: string | null } | undefined;
    if (!inv) {
      notes.push(`bad-debt invoice on job ${jobNumber} for $${total} was not found`);
      return;
    }
    const next = appendNote(inv.notes, note);
    const changed = db.prepare(
      `UPDATE invoices
          SET client_id = ?, jobber_invoice_number = ?, paid_amount = ?, payments_total = ?, notes = ?, status = 'bad_debt'
        WHERE id = ?
          AND (COALESCE(client_id, '') != ?
            OR COALESCE(jobber_invoice_number, -1) != ?
            OR COALESCE(paid_amount, -1) != ?
            OR COALESCE(payments_total, -1) != ?
            OR COALESCE(notes, '') != ?
            OR COALESCE(status, '') != 'bad_debt')`,
    ).run(clientId, jobberNum, cash, cash, next, inv.id, clientId, jobberNum, cash, cash, next);
    stats.updates += changed.changes ?? 0;
    writeoffFixes.push(`job ${jobNumber} invoice #${jobberNum}: cash $${usd(cash)}, write-off $${usd(total - cash)}`);
  }
  stampBadDebt(
    2,
    21356.78,
    kathleenId,
    3,
    20356.78,
    "Bad-debt write-off $1,000.00. Collected $20,356.78 by check #6006 (Jun 6, 2024) and a check (Jun 17, 2024).",
  );
  stampBadDebt(
    94,
    1300,
    boydId,
    137,
    0,
    "Bad-debt write-off $1,300.00. Never paid. The $1,300 payment record was the write-off, not cash.",
  );

  // Invoices that already sit on a job were invisible on the client page when
  // client_id was empty. Copy the job's client onto those invoices and onto
  // the payments already linked to them. No new payment rows.
  const clientStamps: string[] = [];
  const stampInvoices = db.prepare(
    `SELECT i.id AS invoice_id, j.client_id AS client_id, COALESCE(c.name, c.first_name || ' ' || c.last_name) AS client_name
       FROM invoices i
       JOIN jobs j ON j.id = i.job_id
       JOIN clients c ON c.id = j.client_id
      WHERE COALESCE(i.client_id, '') = ''
        AND COALESCE(j.client_id, '') != ''`,
  ).all() as Array<{ invoice_id: string; client_id: string; client_name: string }>;
  const stampedInvoiceIds = stampInvoices.map((row) => row.invoice_id);
  if (stampedInvoiceIds.length) {
    const changed = db.prepare(
      `UPDATE invoices
          SET client_id = (SELECT j.client_id FROM jobs j WHERE j.id = invoices.job_id)
        WHERE COALESCE(client_id, '') = ''
          AND job_id IN (SELECT id FROM jobs WHERE COALESCE(client_id, '') != '')`,
    ).run();
    stats.updates += changed.changes ?? 0;
    const payChanged = db.prepare(
      `UPDATE payments
          SET client_id = (SELECT i.client_id FROM invoices i WHERE i.id = payments.invoice_id)
        WHERE COALESCE(client_id, '') = ''
          AND invoice_id IN (SELECT id FROM invoices WHERE COALESCE(client_id, '') != '')
          AND invoice_id IN (${stampedInvoiceIds.map(() => "?").join(", ")})`,
    ).run(...stampedInvoiceIds);
    stats.updates += payChanged.changes ?? 0;
    const byClient = new Map<string, { invoices: number; name: string }>();
    for (const row of stampInvoices) {
      const cur = byClient.get(row.client_id) ?? { invoices: 0, name: row.client_name };
      cur.invoices += 1;
      byClient.set(row.client_id, cur);
    }
    clientStamps.push(
      `${changed.changes ?? 0} invoices, ${payChanged.changes ?? 0} payments, ${byClient.size} clients`,
    );
    for (const [id, info] of [...byClient.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      clientStamps.push(`${info.name} (${id}): ${info.invoices} invoice(s)`);
    }
  }

  // Brandon Cole invoice #38. The Jan 21, 2025 Jobber Payments row has no invoice
  // or job column, so the generic matcher cannot see it. It is a different
  // transaction from the Dec 5 payment (py_3QjoGt… vs ch_3QSqLK…).
  // Do not post the AndMark $10,678.12, the Christi $2,500 deposit/refund,
  // or the Kathleen Apr 29 deposit.
  const brandonFixes: string[] = [];
  const brandonInv = db.prepare(
    `SELECT i.id, i.jobber_invoice_number, i.payments_total, i.paid_amount, j.id AS job_id, j.client_id
       FROM invoices i
       JOIN jobs j ON j.id = i.job_id
      WHERE j.job_number = 34 AND i.total = 2880`,
  ).all() as Array<{
    id: string;
    jobber_invoice_number: number | null;
    payments_total: number | null;
    paid_amount: number | null;
    job_id: string;
    client_id: string | null;
  }>;
  if (brandonInv.length !== 1) {
    notes.push(`Brandon #38: expected 1 invoice of $2,880 on job 34, found ${brandonInv.length}`);
  } else {
    const inv = brandonInv[0];
    const BRANDON_TXN = "py_3QjoGtKXLQIAg16L0ZfflQ9Y";
    const already = db.prepare(
      `SELECT id FROM payments
        WHERE notes LIKE ?
           OR (invoice_id = ? AND amount = 2880 AND substr(COALESCE(received_date, collected_at), 1, 10) = '2025-01-21')
        LIMIT 1`,
    ).get(`%${BRANDON_TXN}%`, inv.id) as { id: string } | undefined;
    if (!already) {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO payments (
           id, job_id, invoice_id, client_id, amount, convenience_fee, stripe_fee, net_amount,
           payment_method, received_date, collected_at, notes, data_source, synced_at, created_at
         ) VALUES (?, ?, ?, ?, 2880, 0, 0, 2880, 'jobber', '2025-01-21', '2025-01-21', ?, 'jobber_import', datetime('now'), datetime('now'))`,
      ).run(
        id,
        inv.job_id,
        inv.id,
        inv.client_id,
        `Jobber Payments ${BRANDON_TXN}. Payment applied to Invoice #38.`,
      );
      stats.inserts++;
      brandonFixes.push(`posted $2,880 jobber payment ${BRANDON_TXN} on invoice ${inv.id}`);
    }
    const numbered = db.prepare(
      `UPDATE invoices
          SET jobber_invoice_number = 38,
              payments_total = 2880,
              paid_amount = 2880
        WHERE id = ?
          AND (COALESCE(jobber_invoice_number, -1) != 38
            OR COALESCE(payments_total, -1) != 2880
            OR COALESCE(paid_amount, -1) != 2880)`,
    ).run(inv.id);
    stats.updates += numbered.changes ?? 0;
    if ((numbered.changes ?? 0) > 0) brandonFixes.push("stamped jobber invoice number 38 and paid amount $2,880");
  }

  const newJobs = db.prepare(
    `SELECT job_number, jobber_job_number, title, status, contract_total FROM jobs WHERE job_number > 104 ORDER BY job_number`,
  ).all();

  const stubAfter = db.prepare(
    `SELECT estimate_number, total FROM estimates WHERE estimate_number IN (9000, 9054, 9067, 9069, 9001, 9002, 9025) ORDER BY estimate_number`,
  ).all();

  return { notes, headerChanges, contractFills, invoiceDiffs, relinks, relinkSkips, stubAfter, createdInvoices, createdPayments, newJobs, orphanLinks, orphanUnmatched, jobFixes, nameLinks, writeoffFixes, clientStamps, brandonFixes };
}

function loadClients(db: DatabaseSync): ClientRow[] {
  const rows = db.prepare(
    `SELECT id, first_name, last_name, company_name, name, phone, email, notes, data_source FROM clients`,
  ).all() as Array<Omit<ClientRow, "display" | "names">>;
  return rows.map((r) => {
    const display = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || r.name || r.company_name || r.id;
    const names = [r.name, display, r.company_name, [r.first_name, r.last_name].filter(Boolean).join(" ")].map(normName).filter(Boolean);
    return { ...r, display, names: [...new Set(names)] };
  });
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

function appendNote(current: string | null, text: string): string {
  const add = text.trim();
  if (!add) return current ?? "";
  if ((current ?? "").includes(add)) return current ?? "";
  return current ? `${current}\n${add}` : add;
}

function consentNote(report: Row[], name: string, phone: string, email: string): string {
  const n = normName(name);
  const p = phoneKey(phone);
  const e = emailKey(email);
  const row = report.find((r) => normName(r["Client name"]) === n || (p && phoneKey(r.Phone) === p) || (e && emailKey(r.Email) === e));
  if (!row) return "";
  const sms = (row["Consent for SMS marketing"] ?? "").trim().toLowerCase();
  const em = (row["Consent for email marketing"] ?? "").trim().toLowerCase();
  const bits: string[] = [];
  if (sms === "true" || sms === "false") bits.push(`Jobber SMS marketing consent: ${sms}`);
  if (em === "true" || em === "false") bits.push(`Jobber email marketing consent: ${em}`);
  if (!bits.length) return "";
  return `${bits.join(", ")}, as of 2026-10-04`;
}

function addressOf(r: Row): { street: string; city: string; state: string; zip: string } {
  return {
    street: (r["Service street"] || r["Billing street"] || "").trim(),
    city: (r["Service city"] || r["Billing city"] || "").trim(),
    state: (r["Service province"] || r["Billing province"] || "Arkansas").trim() || "Arkansas",
    zip: (r["Service ZIP"] || r["Billing ZIP"] || "").trim(),
  };
}

main();
