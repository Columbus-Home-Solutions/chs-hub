/**
 * Phase A — Jobber historical import diff. Read-only.
 *
 * Loads the Oct 4, 2026 CSVs and the local D1 file (a copy of production).
 * Writes scripts/jobber-import/out/diff-report.md plus detail CSVs.
 * Never opens a remote database and never writes to D1.
 *
 *   npx tsx scripts/jobber-import/diff.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(ROOT, "scripts/jobber-import/data");
const OUT = resolve(ROOT, "scripts/jobber-import/out");

const MISSING_FROM_JOBS_CSV = [4, 18, 38, 44, 69, 79, 87, 88, 96, 100, 104, 105, 106, 107];

type Row = Record<string, string>;

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
  return (v ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** Jobber expense export stores job numbers as "#44". Other files use a bare integer. */
function jobNum(v: string | null | undefined): number | null {
  const n = ints(v);
  return n.length ? n[0] : null;
}

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name: string, header: string[], rows: Array<Array<string | number | null>>) {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  writeFileSync(resolve(OUT, name), lines.join("\n") + "\n");
}

function findLocalDb(): string {
  const listed = execFileSync("find", [resolve(ROOT, ".wrangler/state/v3/d1"), "-name", "*.sqlite"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (listed.length === 0) throw new Error("No local D1 sqlite file under .wrangler/state");
  return listed.sort()[0];
}

type ChsClient = {
  id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  phone: string | null;
  email: string | null;
  data_source: string | null;
  is_test: number;
  display: string;
  names: string[];
};

type JobberClient = {
  key: string;
  display: string;
  company: string;
  phone: string | null;
  email: string | null;
  leadSource: string;
  referredBy: string;
  smsConsent: string;
  emailConsent: string;
  status: string;
  names: string[];
  inScope: boolean;
  scopeWhy: string[];
};

function indexPush<T>(map: Map<string, T[]>, key: string | null, value: T) {
  if (!key) return;
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const dbPath = findLocalDb();
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const clientsReport = loadCsv("Clients_Report_1_of_1_2026-10-04.csv", "Client name");
  const contacts = loadCsv("Client_Contact_Info.csv", "Contact");
  const quotes = loadCsv("Quotes_Report_1_of_1_2026-10-04.csv", "Quote #");
  const jobsCsv = loadCsv("One-off_jobs_Report_1_of_1_2026-10-04.csv", "Job #");
  const invoices = loadCsv("Invoices_Report_1_of_1_2026-10-04.csv", "Invoice #");
  const txns = loadCsv("Transaction_List__2_.csv", "Client name").filter((r) => !blank(r["Type"]));
  const expenses = loadCsv("Expense_Report.csv", "Item name").filter((r) => {
    const item = (r["Item name"] ?? "").trim();
    return item !== "" && !/report totals/i.test(item);
  });
  const balances = loadCsv("Client_Balance_Summary_Report_2026-10-04.csv", "Name");

  // ── Jobber clients ────────────────────────────────────────────────────────
  const jobberClients: JobberClient[] = [];
  const byPhone = new Map<string, JobberClient[]>();
  const byEmail = new Map<string, JobberClient[]>();
  const byName = new Map<string, JobberClient[]>();

  function addName(c: JobberClient, raw: string) {
    const n = normName(raw);
    if (!n || c.names.includes(n)) return;
    c.names.push(n);
    indexPush(byName, n, c);
  }

  for (const r of clientsReport) {
    const display = r["Client name"] ?? "";
    const c: JobberClient = {
      key: `r${jobberClients.length}`,
      display,
      company: "",
      phone: phoneKey(r.Phone),
      email: emailKey(r.Email),
      leadSource: blank(r["Lead source"]) ? "" : r["Lead source"],
      referredBy: blank(r["Referred By"]) ? "" : r["Referred By"],
      smsConsent: (r["Consent for SMS marketing"] ?? "").trim(),
      emailConsent: (r["Consent for email marketing"] ?? "").trim(),
      status: r.Status ?? "",
      names: [],
      inScope: false,
      scopeWhy: [],
    };
    const jobsN = Number(r.Jobs || 0);
    const invN = Number(r.Invoices || 0);
    if (jobsN > 0) c.scopeWhy.push(`clients-report jobs=${jobsN}`);
    if (invN > 0) c.scopeWhy.push(`clients-report invoices=${invN}`);
    addName(c, display);
    indexPush(byPhone, c.phone, c);
    indexPush(byEmail, c.email, c);
    jobberClients.push(c);
  }

  for (const r of contacts) {
    const contact = blank(r.Contact) ? "" : r.Contact;
    const company = blank(r.Company) ? "" : r.Company;
    const display = contact || company;
    const phone = phoneKey(r.Phone);
    const email = emailKey(r.Email);
    const hits = new Set<JobberClient>();
    for (const h of byPhone.get(phone ?? "") ?? []) hits.add(h);
    for (const h of byEmail.get(email ?? "") ?? []) hits.add(h);
    for (const h of byName.get(normName(display)) ?? []) hits.add(h);
    for (const h of byName.get(normName(company)) ?? []) hits.add(h);
    const target = hits.size === 1 ? [...hits][0] : hits.size === 0 ? null : null;
    if (target) {
      if (company && !target.company) target.company = company;
      if (!target.phone && phone) {
        target.phone = phone;
        indexPush(byPhone, phone, target);
      }
      if (!target.email && email) {
        target.email = email;
        indexPush(byEmail, email, target);
      }
      if (!target.leadSource && !blank(r["Lead source"])) target.leadSource = r["Lead source"];
      if (!target.referredBy && !blank(r["Referred By"])) target.referredBy = r["Referred By"];
      addName(target, contact);
      addName(target, company);
    }
  }

  function findJobber(name: string, phone: string, email: string): JobberClient | null {
    const p = phoneKey(phone);
    const e = emailKey(email);
    const n = normName(name);
    const phoneHits = p ? (byPhone.get(p) ?? []) : [];
    if (phoneHits.length === 1) return phoneHits[0];
    const emailHits = e ? (byEmail.get(e) ?? []) : [];
    if (emailHits.length === 1) return emailHits[0];
    const nameHits = n ? (byName.get(n) ?? []) : [];
    if (nameHits.length === 1) return nameHits[0];
    return null;
  }

  function markScope(name: string, phone: string, email: string, why: string) {
    const c = findJobber(name, phone, email);
    if (!c) return;
    if (!c.scopeWhy.includes(why)) c.scopeWhy.push(why);
    c.inScope = true;
  }

  for (const r of jobsCsv) markScope(r["Client name"], r["Client phone"], r["Client email"], "jobs-csv");
  for (const r of invoices) markScope(r["Client name"], r["Client phone"], r["Client email"], "invoice");
  for (const r of quotes) {
    if ((r.Status ?? "").toLowerCase() !== "converted") continue;
    markScope(r["Client name"], r["Client phone"], r["Client email"], "converted-quote");
  }
  for (const c of jobberClients) {
    if (c.scopeWhy.some((w) => w.startsWith("clients-report"))) c.inScope = true;
  }
  const inScope = jobberClients.filter((c) => c.inScope);

  // ── CHS clients ───────────────────────────────────────────────────────────
  const chsClients = db
    .prepare(
      `SELECT id, name, first_name, last_name, company_name, phone, email, data_source, is_test
         FROM clients`,
    )
    .all() as Array<Omit<ChsClient, "display" | "names">>;
  const chs: ChsClient[] = chsClients.map((r) => {
    const display =
      [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || r.name || r.company_name || r.id;
    const names = [r.name, display, r.company_name, [r.first_name, r.last_name].filter(Boolean).join(" ")]
      .map(normName)
      .filter(Boolean);
    return { ...r, display, names: [...new Set(names)] };
  });
  const chsByPhone = new Map<string, ChsClient[]>();
  const chsByEmail = new Map<string, ChsClient[]>();
  const chsByName = new Map<string, ChsClient[]>();
  for (const c of chs) {
    indexPush(chsByPhone, phoneKey(c.phone), c);
    indexPush(chsByEmail, emailKey(c.email), c);
    for (const n of c.names) indexPush(chsByName, n, c);
  }

  type ClientMatch = {
    jobber: JobberClient;
    kind: "match" | "missing" | "ambiguous";
    via: string;
    chs: ChsClient[];
    nameMismatch: boolean;
  };
  const clientMatches: ClientMatch[] = [];
  const usedChs = new Set<string>();

  for (const j of inScope) {
    if (j.names.includes(normName("Cindee Wright"))) {
      const betty = [...new Map((chsByName.get(normName("Betty Hamilton")) ?? []).map((c) => [c.id, c])).values()];
      if (betty.length === 1) {
        usedChs.add(betty[0].id);
        clientMatches.push({ jobber: j, kind: "match", via: "name", chs: betty, nameMismatch: false });
        continue;
      }
    }
    const phoneHits = j.phone ? (chsByPhone.get(j.phone) ?? []) : [];
    const emailHits = j.email ? (chsByEmail.get(j.email) ?? []) : [];
    const nameHits = [...new Set(j.names.flatMap((n) => chsByName.get(n) ?? []))];
    let kind: ClientMatch["kind"] = "missing";
    let via = "";
    let hits: ChsClient[] = [];
    if (j.phone && phoneHits.length === 1) {
      kind = "match";
      via = "phone";
      hits = phoneHits;
    } else if (j.phone && phoneHits.length > 1) {
      kind = "ambiguous";
      via = "phone";
      hits = phoneHits;
    } else if (j.email && emailHits.length === 1) {
      kind = "match";
      via = "email";
      hits = emailHits;
    } else if (j.email && emailHits.length > 1) {
      kind = "ambiguous";
      via = "email";
      hits = emailHits;
    } else if (nameHits.length === 1) {
      kind = "match";
      via = "name";
      hits = nameHits;
    } else if (nameHits.length > 1) {
      kind = "ambiguous";
      via = "name";
      hits = nameHits;
    }
    const nameMismatch =
      kind === "match" &&
      hits.length === 1 &&
      j.names.length > 0 &&
      !hits[0].names.some((n) => j.names.includes(n));
    if (kind === "match") for (const h of hits) usedChs.add(h.id);
    clientMatches.push({ jobber: j, kind, via, chs: hits, nameMismatch });
  }

  const chsNotInScope = chs.filter((c) => !usedChs.has(c.id));

  // ── Jobs ──────────────────────────────────────────────────────────────────
  const referenced = new Set<number>();
  function takeJobs(v: string) {
    for (const n of ints(v)) if (n >= 1 && n <= 109) referenced.add(n);
  }
  for (const r of jobsCsv) takeJobs(r["Job #"]);
  for (const r of quotes) takeJobs(r["Job #s"]);
  for (const r of invoices) takeJobs(r["Job #s"]);
  for (const r of txns) takeJobs(r["Job #"]);
  for (const r of expenses) takeJobs(r["Job #"]);

  const jobsInCsv = new Set(jobsCsv.map((r) => Number(r["Job #"])).filter((n) => n > 0));

  type ChsJob = {
    id: string;
    job_number: number | null;
    title: string | null;
    status: string | null;
    source: string | null;
    data_source: string | null;
    client_id: string | null;
    estimate_id: string | null;
    total: number | null;
  };
  const chsJobs = db
    .prepare(
      `SELECT id, job_number, title, status, source, data_source, client_id, estimate_id, total FROM jobs`,
    )
    .all() as ChsJob[];
  const jobberJobs = chsJobs.filter((j) => j.data_source === "jobber_import");
  const nativeJobs = chsJobs.filter((j) => j.data_source !== "jobber_import");
  const jobberNum = new Map<number, ChsJob[]>();
  for (const j of jobberJobs) {
    if (j.job_number == null) continue;
    const list = jobberNum.get(j.job_number) ?? [];
    list.push(j);
    jobberNum.set(j.job_number, list);
  }
  const nativeNum = new Map<number, ChsJob[]>();
  for (const j of nativeJobs) {
    if (j.job_number == null) continue;
    const list = nativeNum.get(j.job_number) ?? [];
    list.push(j);
    nativeNum.set(j.job_number, list);
  }

  type JobClass = "match" | "missing" | "ambiguous" | "collision";
  const jobRows: Array<{ n: number; kind: JobClass; inJobsCsv: boolean; chs: string; note: string }> = [];
  for (const n of [...referenced].sort((a, b) => a - b)) {
    const hits = jobberNum.get(n) ?? [];
    const native = nativeNum.get(n) ?? [];
    let kind: JobClass = "missing";
    let note = "";
    if (hits.length === 1 && native.length === 0) kind = "match";
    else if (hits.length === 1 && native.length > 0) {
      kind = "collision";
      note = `jobber_import row exists AND native job ${native.map((j) => `${j.job_number} ${j.title} source=${j.source}`).join("; ")}`;
    } else if (hits.length > 1) {
      kind = "ambiguous";
      note = `${hits.length} jobber_import rows share job_number ${n}`;
    } else if (native.length > 0) {
      kind = "collision";
      note = `no jobber_import row; native job uses this number: ${native.map((j) => `${j.title ?? ""} source=${j.source} status=${j.status}`).join("; ")}`;
    } else note = "not in CHS";
    const chs =
      hits.map((j) => `${j.title ?? "(no title)"} [${j.status}/${j.source}]`).join(" | ") ||
      native.map((j) => `NATIVE ${j.title ?? ""} [${j.status}/${j.source}]`).join(" | ");
    jobRows.push({ n, kind, inJobsCsv: jobsInCsv.has(n), chs, note });
  }
  const jobberNotReferenced = jobberJobs.filter((j) => j.job_number == null || !referenced.has(j.job_number));

  // ── Estimates / quotes ────────────────────────────────────────────────────
  type ChsEst = {
    id: string;
    estimate_number: number | null;
    title: string | null;
    total: number | null;
    notes: string | null;
    created_at: string | null;
    client_id: string | null;
    data_source: string | null;
    status: string | null;
    client_exists: number;
  };
  const chsEst = db
    .prepare(
      `SELECT e.id, e.estimate_number, e.title, e.total, e.notes, e.created_at, e.client_id,
              e.data_source, e.status, CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS client_exists
         FROM estimates e
         LEFT JOIN clients c ON c.id = e.client_id
        WHERE e.data_source = 'jobber_import' OR e.estimate_number >= 9000`,
    )
    .all() as ChsEst[];

  const quoteNumFromNotes = (notes: string | null): number | null => {
    const m = (notes ?? "").match(/Jobber Quote #:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const estByQuote = new Map<number, ChsEst[]>();
  for (const e of chsEst) {
    const qn = quoteNumFromNotes(e.notes);
    if (qn == null) continue;
    const list = estByQuote.get(qn) ?? [];
    list.push(e);
    estByQuote.set(qn, list);
  }

  const converted = quotes.filter((r) => (r.Status ?? "").toLowerCase() === "converted");
  const clientById = new Map(chs.map((c) => [c.id, c]));

  type QuoteLink = {
    quote: string;
    client: string;
    title: string;
    total: string;
    kind: "match" | "missing" | "ambiguous";
    estId: string;
    estNumber: string;
    currentClient: string;
    clientExists: string;
    proposed: string;
    proposal: string;
  };
  const quoteLinks: QuoteLink[] = [];
  const matchedEst = new Set<string>();

  for (const q of converted) {
    const qn = Number(q["Quote #"]);
    const hits = estByQuote.get(qn) ?? [];
    const jc = findJobber(q["Client name"], q["Client phone"], q["Client email"]);
    const cm = jc ? clientMatches.find((m) => m.jobber === jc) : undefined;
    let proposed = "";
    let proposal = "no unique CHS client";
    if (cm?.kind === "match" && cm.chs.length === 1) {
      proposed = `${cm.chs[0].id} ${cm.chs[0].display}`;
      proposal = `relink via ${cm.via}`;
    } else if (cm?.kind === "ambiguous") {
      proposal = `ambiguous CHS client via ${cm.via}: ${cm.chs.map((c) => c.display).join(" | ")}`;
    }
    if (hits.length === 1) {
      matchedEst.add(hits[0].id);
      const cur = hits[0].client_id ?? "";
      const same = cm?.kind === "match" && cm.chs[0]?.id === cur;
      quoteLinks.push({
        quote: String(qn),
        client: q["Client name"],
        title: q.Title,
        total: q["Total ($)"],
        kind: "match",
        estId: hits[0].id,
        estNumber: String(hits[0].estimate_number ?? ""),
        currentClient: cur,
        clientExists: String(hits[0].client_exists),
        proposed: same ? "(already this client)" : proposed,
        proposal: same ? "client already correct" : proposal,
      });
    } else     if (hits.length === 0) {
      const title = normName(q.Title);
      const totalC = cents(money(q["Total ($)"]));
      const dates = [isoDate(q["Drafted date"]), isoDate(q["Sent date"]), isoDate(q["Converted date"])].filter(
        (d): d is string => !!d,
      );
      let fallback = chsEst.filter((e) => {
        if (matchedEst.has(e.id)) return false;
        const noted = quoteNumFromNotes(e.notes);
        if (noted != null && noted !== qn) return false;
        return cents(e.total) === totalC && title !== "" && normName(e.title) === title;
      });
      if (fallback.length > 1 && dates.length) {
        const dated = fallback.filter((e) => dates.includes(isoDate(e.created_at) ?? ""));
        if (dated.length) fallback = dated;
      }
      if (fallback.length === 1) {
        matchedEst.add(fallback[0].id);
        const cur = fallback[0].client_id ?? "";
        const same = cm?.kind === "match" && cm.chs[0]?.id === cur;
        quoteLinks.push({
          quote: String(qn),
          client: q["Client name"],
          title: q.Title,
          total: q["Total ($)"],
          kind: "match",
          estId: fallback[0].id,
          estNumber: String(fallback[0].estimate_number ?? ""),
          currentClient: cur,
          clientExists: String(fallback[0].client_exists),
          proposed: same ? "(already this client)" : proposed,
          proposal: `${same ? "client already correct" : proposal}; matched on title+total because notes have no Quote # ${qn}`,
        });
      } else if (fallback.length > 1) {
        quoteLinks.push({
          quote: String(qn),
          client: q["Client name"],
          title: q.Title,
          total: q["Total ($)"],
          kind: "ambiguous",
          estId: fallback.map((h) => h.id).join(" | "),
          estNumber: fallback.map((h) => h.estimate_number).join(" | "),
          currentClient: "",
          clientExists: "",
          proposed: "",
          proposal: `${fallback.length} estimates share this title and total and notes do not contain Quote # ${qn} — not guessing`,
        });
      } else {
        quoteLinks.push({
          quote: String(qn),
          client: q["Client name"],
          title: q.Title,
          total: q["Total ($)"],
          kind: "missing",
          estId: "",
          estNumber: "",
          currentClient: "",
          clientExists: "",
          proposed,
          proposal: `no estimate notes contain Quote # ${qn}, and title+total is not a unique match. ${proposal}`,
        });
      }
    } else {
      quoteLinks.push({
        quote: String(qn),
        client: q["Client name"],
        title: q.Title,
        total: q["Total ($)"],
        kind: "ambiguous",
        estId: hits.map((h) => h.id).join(" | "),
        estNumber: hits.map((h) => h.estimate_number).join(" | "),
        currentClient: "",
        clientExists: "",
        proposed: "",
        proposal: `${hits.length} estimates share this quote number — not guessing`,
      });
    }
  }
  const estNotConverted = chsEst.filter((e) => !matchedEst.has(e.id));

  // ── Rule 17: still-open quotes (report only; the importer does not apply these) ──
  const OPEN_QUOTE_NUMBERS = [245, 252, 255, 258, 261, 267, 272, 273, 274, 275, 276, 278];
  const CANCELLED_OPEN_QUOTES = new Set([277]);
  type OpenLine = { name: string; qty: number; amount: number };
  function parseJobberLines(raw: string): OpenLine[] {
    const out: OpenLine[] = [];
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
  function lineKey(lines: OpenLine[]): string {
    return lines
      .map((l) => `${normName(l.name)}|${l.qty}|${cents(l.amount)}`)
      .sort()
      .join(";");
  }
  type EstLineRow = {
    id: string;
    estimate_number: number | null;
    title: string | null;
    total: number | null;
    client_id: string | null;
    status: string | null;
    data_source: string | null;
    notes: string | null;
    product_service: string | null;
    quantity: number | null;
    line_total: number | null;
    unit_price: number | null;
  };
  const estLineRows = db
    .prepare(
      `SELECT e.id, e.estimate_number, e.title, e.total, e.client_id, e.status, e.data_source, e.notes,
              li.product_service, li.quantity, li.total AS line_total, li.unit_price
         FROM estimates e
         LEFT JOIN estimate_line_items li ON li.estimate_id = e.id`,
    )
    .all() as EstLineRow[];
  const allEstimates = new Map<
    string,
    {
      id: string;
      estimate_number: number | null;
      title: string | null;
      total: number | null;
      client_id: string | null;
      status: string | null;
      data_source: string | null;
      notes: string | null;
      lines: OpenLine[];
    }
  >();
  for (const r of estLineRows) {
    let est = allEstimates.get(r.id);
    if (!est) {
      est = {
        id: r.id,
        estimate_number: r.estimate_number,
        title: r.title,
        total: r.total,
        client_id: r.client_id,
        status: r.status,
        data_source: r.data_source,
        notes: r.notes,
        lines: [],
      };
      allEstimates.set(r.id, est);
    }
    if (r.product_service) {
      const amount = r.line_total ?? (r.quantity != null && r.unit_price != null ? r.quantity * r.unit_price : null);
      if (amount != null) est.lines.push({ name: r.product_service, qty: r.quantity ?? 1, amount });
    }
  }
  function matchChsClient(name: string, phone: string, email: string): { kind: "match" | "missing" | "ambiguous"; via: string; chs: ChsClient[] } {
    const p = phoneKey(phone);
    const e = emailKey(email);
    const n = normName(name);
    // Cindee Wright is the Jobber name on Betty Hamilton's job. Not a missing client.
    if (n === normName("Cindee Wright")) {
      const betty = chsByName.get(normName("Betty Hamilton")) ?? [];
      const unique = [...new Map(betty.map((c) => [c.id, c])).values()];
      if (unique.length === 1) return { kind: "match", via: "name", chs: unique };
    }
    const phoneHits = p ? (chsByPhone.get(p) ?? []) : [];
    const emailHits = e ? (chsByEmail.get(e) ?? []) : [];
    const nameHits = n ? (chsByName.get(n) ?? []) : [];
    if (phoneHits.length === 1) return { kind: "match", via: "phone", chs: phoneHits };
    if (phoneHits.length > 1) return { kind: "ambiguous", via: "phone", chs: phoneHits };
    if (emailHits.length === 1) return { kind: "match", via: "email", chs: emailHits };
    if (emailHits.length > 1) return { kind: "ambiguous", via: "email", chs: emailHits };
    if (nameHits.length === 1) return { kind: "match", via: "name", chs: nameHits };
    if (nameHits.length > 1) return { kind: "ambiguous", via: "name", chs: nameHits };
    return { kind: "missing", via: "", chs: [] };
  }
  type OpenQuoteRow = {
    quote: number;
    client: string;
    status: string;
    title: string;
    total: number | null;
    lineSum: number;
    sent: string;
    property: string;
    clientKind: string;
    clientVia: string;
    chsClient: string;
    action: "skip" | "create" | "review";
    estimate: string;
    note: string;
    flag: string;
  };
  const openQuotes: OpenQuoteRow[] = [];
  for (const n of OPEN_QUOTE_NUMBERS) {
    const q = quotes.find((r) => Number(r["Quote #"]) === n);
    if (!q) {
      openQuotes.push({
        quote: n,
        client: "",
        status: "",
        title: "",
        total: null,
        lineSum: 0,
        sent: "",
        property: "",
        clientKind: "",
        clientVia: "",
        chsClient: "",
        action: "review",
        estimate: "",
        note: "quote number not in the Quotes CSV",
        flag: "",
      });
      continue;
    }
    const lines = parseJobberLines(q["Line items"] ?? "");
    const lineSum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const total = money(q["Total ($)"]);
    const titleN = normName(q.Title);
    const key = lineKey(lines);
    const cm = matchChsClient(q["Client name"], q["Client phone"], q["Client email"]);
    const clientId = cm.kind === "match" ? cm.chs[0].id : null;
    const pool = [...allEstimates.values()];
    const full = pool.filter((e) => {
      if (cents(e.total) !== cents(total)) return false;
      if (normName(e.title) !== titleN) return false;
      if (lineKey(e.lines) !== key) return false;
      if (clientId && e.client_id !== clientId) return false;
      return true;
    });
    const sameClientTotal = clientId
      ? pool.filter((e) => e.client_id === clientId && cents(e.total) === cents(total))
      : [];
    const lineTwins = pool.filter((e) => lineKey(e.lines) === key && key !== "");
    let action: OpenQuoteRow["action"] = "create";
    let estimate = "";
    let note = "no CHS estimate has this client, total, title, and line items";
    if (full.length === 1) {
      action = "skip";
      estimate = `${full[0].estimate_number ?? "?"} ${full[0].id}`;
      note = `already in CHS as status ${full[0].status ?? "?"} data_source=${full[0].data_source ?? ""} — do not overwrite`;
    } else if (full.length > 1) {
      action = "review";
      estimate = full.map((e) => e.estimate_number ?? e.id).join(" | ");
      note = `${full.length} estimates match client+total+title+lines — not guessing`;
    } else if (sameClientTotal.length) {
      action = "review";
      estimate = sameClientTotal.map((e) => `${e.estimate_number ?? "?"} “${e.title ?? ""}” $${e.total}`).join(" | ");
      note = "same client and total, title or line items differ — not a skip, not a create";
    } else if (!clientId && lineTwins.length) {
      action = "review";
      estimate = lineTwins.map((e) => `${e.estimate_number ?? "?"} client ${e.client_id ?? "none"}`).join(" | ");
      note = "line items match an estimate whose client was not uniquely identified — not guessing";
    } else if (cm.kind === "ambiguous") {
      action = "review";
      note = `client is ambiguous via ${cm.via} (${cm.chs.map((c) => c.display).join(" | ")}). No estimate match. Do not create until the client is chosen.`;
    }
    const flags: string[] = [];
    if (n === 277) flags.push("Approved, never converted — do not auto-convert");
    if (n === 272) flags.push(`header total $0; line items sum $${lineSum.toFixed(2)}`);
    const street = [q["Service street"], q["Service city"], q["Service province"], q["Service ZIP"]].filter((p) => !blank(p)).join(", ");
    openQuotes.push({
      quote: n,
      client: q["Client name"],
      status: q.Status,
      title: q.Title,
      total,
      lineSum,
      sent: isoDate(q["Sent date"]) ?? "",
      property: street,
      clientKind: cm.kind,
      clientVia: cm.via,
      chsClient: cm.chs.map((c) => `${c.display} (${c.id.slice(0, 8)})`).join(" | "),
      action,
      estimate,
      note,
      flag: flags.join("; "),
    });
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  type ChsInv = {
    id: string;
    invoice_number: number | null;
    total: number | null;
    amount: number | null;
    status: string | null;
    issued_date: string | null;
    data_source: string | null;
    job_number: number | null;
    job_data_source: string | null;
    job_title: string | null;
    paid_sum: number | null;
  };
  const chsInv = db
    .prepare(
      `SELECT i.id, i.invoice_number, i.total, i.amount, i.status, i.issued_date, i.data_source,
              j.job_number, j.data_source AS job_data_source, j.title AS job_title,
              (SELECT ROUND(SUM(p.amount), 2) FROM payments p WHERE p.invoice_id = i.id) AS paid_sum
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id`,
    )
    .all() as ChsInv[];

  type InvRec = {
    num: number;
    client: string;
    phone: string;
    email: string;
    jobs: number[];
    status: string;
    total: number | null;
    balance: number | null;
    issued: string | null;
    line: string;
  };
  const invRecs: InvRec[] = invoices.map((r) => ({
    num: Number(r["Invoice #"]),
    client: r["Client name"],
    phone: r["Client phone"],
    email: r["Client email"],
    jobs: ints(r["Job #s"]).filter((n) => n <= 109),
    status: r.Status,
    total: money(r["Total ($)"]),
    balance: money(r["Balance ($)"]),
    issued: isoDate(r["Issued date"]),
    line: r["Line items"] ?? "",
  }));

  type InvLink = {
    num: number;
    client: string;
    status: string;
    total: number | null;
    jobs: string;
    kind: "match" | "missing" | "ambiguous";
    chsId: string;
    chsStatus: string;
    note: string;
  };

  const usedInv = new Set<string>();
  const invLinks: InvLink[] = [];

  function invPool(rec: InvRec): ChsInv[] {
    const jobSet = new Set(rec.jobs);
    if (jobSet.size) {
      return chsInv.filter((i) => i.job_number != null && jobSet.has(i.job_number) && i.job_data_source === "jobber_import");
    }
    return chsInv.filter((i) => !usedInv.has(i.id));
  }

  // Group CSV invoices that share the same job set + total so identical pairs
  // (Wilson Wong 58/59) can match by count instead of being called ambiguous.
  const groups = new Map<string, InvRec[]>();
  for (const rec of invRecs) {
    const key = `${rec.jobs.slice().sort().join("+")}|${cents(rec.total)}|${rec.client}`;
    const list = groups.get(key) ?? [];
    list.push(rec);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    const pool = invPool(group[0]).filter((i) => !usedInv.has(i.id));
    const totalC = cents(group[0].total);
    const amountHits = pool.filter((i) => cents(i.total) === totalC || cents(i.amount) === totalC);
    const dated = group.map((g) => g.issued);
    const dateHits = amountHits.filter((i) => dated.includes(isoDate(i.issued_date)));

    const assign = (chsRow: ChsInv, rec: InvRec, note: string) => {
      usedInv.add(chsRow.id);
      invLinks.push({
        num: rec.num,
        client: rec.client,
        status: rec.status,
        total: rec.total,
        jobs: rec.jobs.join(" "),
        kind: "match",
        chsId: chsRow.id,
        chsStatus: chsRow.status ?? "",
        note,
      });
    };

    if (group.length === 1 && dateHits.length === 1) {
      assign(dateHits[0], group[0], "job+total+issued date");
      continue;
    }
    if (group.length === 1 && amountHits.length === 1) {
      assign(amountHits[0], group[0], "job+total (issued date did not match uniquely)");
      continue;
    }
    if (amountHits.length === group.length && amountHits.length > 0) {
      const sortedCsv = group.slice().sort((a, b) => (a.issued ?? "").localeCompare(b.issued ?? "") || a.num - b.num);
      const sortedChs = amountHits.slice().sort((a, b) => (isoDate(a.issued_date) ?? "").localeCompare(isoDate(b.issued_date) ?? ""));
      sortedCsv.forEach((rec, i) => assign(sortedChs[i], rec, "paired by equal count of same job+total (not a unique key)"));
      continue;
    }
    for (const rec of group) {
      invLinks.push({
        num: rec.num,
        client: rec.client,
        status: rec.status,
        total: rec.total,
        jobs: rec.jobs.join(" "),
        kind: amountHits.length === 0 ? "missing" : "ambiguous",
        chsId: "",
        chsStatus: "",
        note:
          amountHits.length === 0
            ? `no jobber_import invoice with this job # and total${
                rec.jobs.some((n) => (nativeNum.get(n) ?? []).length > 0)
                  ? ` (job # ${rec.jobs.filter((n) => nativeNum.has(n)).join(", ")} is a native CHS job, not a Jobber import)`
                  : ""
              }`
            : `${amountHits.length} CHS invoices share this total but ${group.length} CSV rows — not guessing`,
      });
    }
  }
  invLinks.sort((a, b) => a.num - b.num);
  const chsInvNotInJobber = chsInv.filter((i) => !usedInv.has(i.id));

  // Payments recorded on the transaction list vs invoice total.
  const payTxns = txns.filter((r) => /payment|deposit|refund/i.test(r.Type ?? ""));
  type PayGap = { num: number; client: string; status: string; total: number | null; balance: number | null; paid: number; gap: number | null };
  const payGaps: PayGap[] = [];
  for (const rec of invRecs) {
    const related = payTxns.filter((t) => ints(t["Invoice #"]).includes(rec.num));
    let paid = 0;
    for (const t of related) {
      const amt = money(t["Total $"]) ?? 0;
      const type = (t.Type ?? "").toLowerCase();
      if (type.includes("refund")) paid -= Math.abs(amt);
      else paid += Math.abs(amt);
    }
    paid = Math.round(paid * 100) / 100;
    const gap = rec.total == null ? null : Math.round((rec.total - paid) * 100) / 100;
    const balance = rec.balance ?? 0;
    if (gap == null || Math.abs((gap ?? 0) - balance) > 0.01 || (rec.status === "Paid" && Math.abs(paid - (rec.total ?? 0)) > 0.01)) {
      payGaps.push({ num: rec.num, client: rec.client, status: rec.status, total: rec.total, balance: rec.balance, paid, gap });
    }
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  type ChsExp = {
    id: string;
    amount: number | null;
    description: string | null;
    incurred_at: string | null;
    incurred_date: string | null;
    expense_type: string | null;
    jobber_id: string | null;
    job_number: number | null;
    job_data_source: string | null;
  };
  const chsExp = db
    .prepare(
      `SELECT e.id, e.amount, e.description, e.incurred_at, e.incurred_date, e.expense_type, e.jobber_id,
              j.job_number, j.data_source AS job_data_source
         FROM expenses e
         LEFT JOIN jobs j ON j.id = e.job_id`,
    )
    .all() as ChsExp[];

  const expKey = (job: number | null, amount: number | null, date: string | null, desc: string) =>
    `${job ?? "none"}|${cents(amount)}|${date ?? ""}|${normName(desc)}`;

  // Native jobs 101–104 share numbers with later Jobber jobs. Compare the CSV only
  // to jobber_import jobs and to expenses with no job.
  const expPool = chsExp.filter((e) => e.job_data_source === "jobber_import" || e.job_number == null);
  const nativeExp = chsExp.filter((e) => e.job_data_source !== "jobber_import" && e.job_number != null);
  const chsExpByKey = new Map<string, ChsExp[]>();
  for (const e of expPool) {
    const date = isoDate(e.incurred_date) ?? isoDate(e.incurred_at);
    const k = expKey(e.job_number, e.amount, date, e.description ?? "");
    const list = chsExpByKey.get(k) ?? [];
    list.push(e);
    chsExpByKey.set(k, list);
  }
  const usedExp = new Set<string>();
  let expMatch = 0;
  let expMissing = 0;
  let expAmbiguous = 0;
  const expMissingRows: string[][] = [];
  const expAmbiguousRows: string[][] = [];

  const descHead = (description: string | null) => normName((description ?? "").split("—")[0].split(" - ")[0]);

  for (const r of expenses) {
    const job = jobNum(r["Job #"]);
    const amount = money(r["Total $"]);
    const date = isoDate(r.Date);
    const desc = r["Item name"] ?? "";
    const k = expKey(job, amount, date, desc);
    const exact = (chsExpByKey.get(k) ?? []).filter((e) => !usedExp.has(e.id));
    const headed = expPool.filter((e) => {
      if (usedExp.has(e.id)) return false;
      const ed = isoDate(e.incurred_date) ?? isoDate(e.incurred_at);
      return e.job_number === job && cents(e.amount) === cents(amount) && ed === date && descHead(e.description) === normName(desc);
    });
    const hits = exact.length ? exact : headed;
    if (hits.length === 1) {
      usedExp.add(hits[0].id);
      expMatch++;
    } else if (hits.length === 0) {
      const loose = expPool.filter((e) => {
        if (usedExp.has(e.id)) return false;
        const ed = isoDate(e.incurred_date) ?? isoDate(e.incurred_at);
        return e.job_number === job && cents(e.amount) === cents(amount) && ed === date;
      });
      if (loose.length === 1) {
        usedExp.add(loose[0].id);
        expMatch++;
      } else if (loose.length === 0) {
        expMissing++;
        expMissingRows.push([String(job ?? ""), r["Client name"], desc, String(amount ?? ""), date ?? "", r["Act. code"]]);
      } else {
        expAmbiguous++;
        expAmbiguousRows.push([String(job ?? ""), r["Client name"], desc, String(amount ?? ""), date ?? "", String(loose.length)]);
      }
    } else {
      expAmbiguous++;
      expAmbiguousRows.push([String(job ?? ""), r["Client name"], desc, String(amount ?? ""), date ?? "", String(hits.length)]);
    }
  }

  function shiftDay(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  let expDateShifted = 0;
  const expStillMissing: string[][] = [];
  for (const row of expMissingRows) {
    const job = row[0] === "" ? null : Number(row[0]);
    const amount = Number(row[3]);
    const date = row[4];
    const hits = expPool.filter((e) => {
      if (usedExp.has(e.id) || !date) return false;
      const ed = isoDate(e.incurred_date) ?? isoDate(e.incurred_at);
      return e.job_number === job && cents(e.amount) === cents(amount) && (ed === shiftDay(date, 1) || ed === shiftDay(date, -1));
    });
    if (hits.length === 1) {
      usedExp.add(hits[0].id);
      expDateShifted++;
    } else expStillMissing.push(row);
  }
  // Identical amount+date pairs (two $7,000 Tito payments, two Lowe's receipts):
  // both sides have the same count, so the money matches even though a single
  // row cannot be told apart. Mark those CHS rows used.
  const ambGroups = new Map<string, string[][]>();
  for (const row of expAmbiguousRows) {
    const k = row.slice(0, 5).join("|");
    const list = ambGroups.get(k) ?? [];
    list.push(row);
    ambGroups.set(k, list);
  }
  let expPairedSets = 0;
  for (const rows of ambGroups.values()) {
    const job = rows[0][0] === "" ? null : Number(rows[0][0]);
    const amount = Number(rows[0][3]);
    const date = rows[0][4];
    const hits = expPool.filter((e) => {
      if (usedExp.has(e.id)) return false;
      const ed = isoDate(e.incurred_date) ?? isoDate(e.incurred_at);
      return e.job_number === job && cents(e.amount) === cents(amount) && ed === date;
    });
    if (hits.length === rows.length) {
      for (const h of hits) usedExp.add(h.id);
      expPairedSets += rows.length;
    }
  }

  const expByJob = new Map<string, { csv: number; chs: number; csvN: number; chsN: number }>();
  const bump = (job: string, side: "csv" | "chs", amount: number) => {
    const row = expByJob.get(job) ?? { csv: 0, chs: 0, csvN: 0, chsN: 0 };
    row[side] = Math.round((row[side] + amount) * 100) / 100;
    if (side === "csv") row.csvN++;
    else row.chsN++;
    expByJob.set(job, row);
  };
  for (const r of expenses) {
    const job = jobNum(r["Job #"]);
    bump(job == null ? "(no job)" : String(job), "csv", money(r["Total $"]) ?? 0);
  }
  for (const e of expPool) {
    const job = e.job_number == null ? "(no job)" : String(e.job_number);
    bump(job, "chs", e.amount ?? 0);
  }
  const nativeExpTotal = Math.round(nativeExp.reduce((s, e) => s + (e.amount ?? 0), 0) * 100) / 100;
  const expJobDiffs = [...expByJob.entries()]
    .map(([job, v]) => ({ job, ...v, diff: Math.round((v.chs - v.csv) * 100) / 100 }))
    .filter((v) => Math.abs(v.diff) > 0.01)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const csvExpTotal = Math.round(expenses.reduce((s, r) => s + (money(r["Total $"]) ?? 0), 0) * 100) / 100;
  const chsExpTotal = Math.round(chsExp.reduce((s, e) => s + (e.amount ?? 0), 0) * 100) / 100;
  const job44 = expByJob.get("44");

  // ── 2026 + spot checks ────────────────────────────────────────────────────
  const y2026 = invRecs.filter((r) => (r.issued ?? "").startsWith("2026"));
  const y2026Total = Math.round(y2026.reduce((s, r) => s + (r.total ?? 0), 0) * 100) / 100;
  const allInvTotal = Math.round(invRecs.reduce((s, r) => s + (r.total ?? 0), 0) * 100) / 100;

  const spot = (n: number) => invLinks.find((i) => i.num === n);
  const txnFor = (n: number) =>
    payTxns
      .filter((t) => ints(t["Invoice #"]).includes(n))
      .map((t) => `${t.Type} ${t["Total $"]} ${t.Method || ""} ${t.Date}`)
      .join("; ");

  const count = (arr: ClientMatch[], k: string) => arr.filter((m) => m.kind === k).length;
  const jobCount = (k: string) => jobRows.filter((r) => r.kind === k).length;
  const quoteCount = (k: string) => quoteLinks.filter((r) => r.kind === k).length;
  const invCount = (k: string) => invLinks.filter((r) => r.kind === k).length;

  const consentSms = jobberClients.filter((c) => /^(true|false)$/i.test(c.smsConsent));
  const consentEmail = jobberClients.filter((c) => /^(true|false)$/i.test(c.emailConsent));
  const notReferenced = [];
  for (let n = 1; n <= 109; n++) if (!referenced.has(n)) notReferenced.push(n);

  const lines: string[] = [];
  const h = (s: string) => lines.push(s);
  h("# Jobber historical import — Phase A diff");
  h("");
  h(`Generated ${new Date().toISOString()}.`);
  h("");
  h("Local D1 is the Oct 4, 2026 production export (`backups/pre-jobber-historical-import-20261004.sql`), also stored at `chs-backups/pre-jobber-historical-import-20261004.sql` and verified by a full download compare. Remote D1 was not written.");
  h("");
  h("## Counts");
  h("");
  h("| Entity | Match | Missing in CHS | In CHS but not in this Jobber export | Ambiguous |");
  h("|---|---:|---:|---:|---:|");
  h(`| Clients (in scope) | ${count(clientMatches, "match")} | ${count(clientMatches, "missing")} | ${chsNotInScope.length} CHS clients unmatched | ${count(clientMatches, "ambiguous")} |`);
  h(`| Jobs (referenced #s 1–109) | ${jobCount("match")} | ${jobCount("missing")} | ${jobberNotReferenced.length} jobber_import jobs not referenced | ${jobCount("ambiguous")} (+ ${jobCount("collision")} number collisions) |`);
  h(`| Converted quotes | ${quoteCount("match")} | ${quoteCount("missing")} | ${estNotConverted.length} EST-9000-range rows not tied to a converted quote | ${quoteCount("ambiguous")} |`);
  h(`| Invoices | ${invCount("match")} | ${invCount("missing")} | ${chsInvNotInJobber.length} | ${invCount("ambiguous")} |`);
  h(`| Expenses (rows) | ${expMatch + expDateShifted + expPairedSets} | ${expStillMissing.length} | ${nativeExp.length} on native jobs, plus ${expPool.length - (expMatch + expDateShifted + expPairedSets)} jobber rows left over | ${expAmbiguous - expPairedSets} |`);
  h("");
  h(`In-scope Jobber clients: **${inScope.length}** (has a job, an invoice, or a converted quote, including the Clients Report job/invoice columns). Clients Report rows: ${clientsReport.length}. Converted quotes: ${converted.length}. Jobs CSV rows: ${jobsCsv.length}. Invoice rows: ${invRecs.length}. Expense rows after dropping the report-totals line: ${expenses.length} totaling **$${csvExpTotal.toFixed(2)}**. Transaction rows: ${txns.length}.`);
  h("");
  h(`All-time invoiced in the Invoices CSV: **$${allInvTotal.toFixed(2)}** across ${invRecs.length} invoices. 2026 issued: **$${y2026Total.toFixed(2)}** across ${y2026.length} invoices.`);
  h("");
  h(`CHS expenses total **$${chsExpTotal.toFixed(2)}** (${chsExp.length} rows) vs CSV **$${csvExpTotal.toFixed(2)}**. Of the CHS total, **$${nativeExpTotal.toFixed(2)}** sits on native (non-jobber_import) jobs and is outside this export.`);
  h("");

  h("## Clients");
  h("");
  h(`Matched ${count(clientMatches, "match")} (phone ${clientMatches.filter((m) => m.kind === "match" && m.via === "phone").length}, email ${clientMatches.filter((m) => m.kind === "match" && m.via === "email").length}, name ${clientMatches.filter((m) => m.kind === "match" && m.via === "name").length}). Name was normalized only for matching. ${clientMatches.filter((m) => m.nameMismatch).length} phone/email matches have a different normalized display name.`);
  h("");
  h("### Missing in CHS");
  h("");
  for (const m of clientMatches.filter((x) => x.kind === "missing")) {
    h(`- ${m.jobber.display}${m.jobber.company ? ` (${m.jobber.company})` : ""} — ${m.jobber.scopeWhy.join(", ") || "in scope"}`);
  }
  if (!clientMatches.some((x) => x.kind === "missing")) h("- None");
  h("");
  h("### Ambiguous (not guessed)");
  h("");
  for (const m of clientMatches.filter((x) => x.kind === "ambiguous")) {
    h(`- ${m.jobber.display} via ${m.via}: ${m.chs.map((c) => `${c.display} [${c.id.startsWith("Z2lk") ? "jobber gid" : "uuid"} is_test=${c.is_test}]`).join(" | ")}`);
  }
  if (!clientMatches.some((x) => x.kind === "ambiguous")) h("- None");
  h("");
  h("### CHS clients not matched to an in-scope Jobber client");
  h("");
  h(`${chsNotInScope.length} rows. Jobber-gid among them: ${chsNotInScope.filter((c) => c.id.startsWith("Z2lk")).length}. Test flag: ${chsNotInScope.filter((c) => c.is_test).length}. Full list in \`clients-chs-unmatched.csv\`.`);
  h("");
  h(`Marketing consent is explicit on the full Clients Report for SMS on ${consentSms.length} rows (${consentSms.filter((c) => /^true$/i.test(c.smsConsent)).length} true, ${consentSms.filter((c) => /^false$/i.test(c.smsConsent)).length} false) and email on ${consentEmail.length} rows (${consentEmail.filter((c) => /^true$/i.test(c.emailConsent)).length} true, ${consentEmail.filter((c) => /^false$/i.test(c.emailConsent)).length} false). CHS has no marketing-consent column. \`clients.sms_opt_out\` is a transactional STOP flag (default 0), not a marketing opt-in. Consent should not be imported.`);
  h("");

  h("## Jobs");
  h("");
  h(`Referenced job numbers 1–109: ${referenced.size}. Present on the Jobs CSV: ${jobsInCsv.size}. Numbers 1–109 never referenced: ${notReferenced.join(", ") || "(none)"}.`);
  h("");
  h("### The 14 numbers absent from the Jobs CSV");
  h("");
  h("| Job # | In CHS as jobber_import? | What CHS has |");
  h("|---:|---|---|");
  for (const n of MISSING_FROM_JOBS_CSV) {
    const row = jobRows.find((r) => r.n === n);
    const referencedNote = referenced.has(n) ? "" : " (not referenced by quotes/invoices/expenses/transactions either)";
    h(`| ${n} | ${row?.kind ?? "not referenced"} | ${(row?.chs || row?.note || "absent") + referencedNote} |`);
  }
  h("");
  h("### Referenced numbers missing from CHS entirely");
  h("");
  const trulyMissing = jobRows.filter((r) => r.kind === "missing");
  if (!trulyMissing.length) h("- None");
  for (const r of trulyMissing) h(`- #${r.n}${r.inJobsCsv ? " (on Jobs CSV)" : " (only on a quote, invoice, payment, or expense)"}`);
  h("");
  h("### Number collisions with native CHS jobs");
  h("");
  const collisions = jobRows.filter((r) => r.kind === "collision");
  if (!collisions.length) h("- None");
  for (const r of collisions) h(`- #${r.n}: ${r.note}`);
  h("");
  h("### jobber_import jobs whose number is not referenced in these CSVs");
  h("");
  if (!jobberNotReferenced.length) h("- None");
  for (const j of jobberNotReferenced) h(`- #${j.job_number ?? "?"} ${j.title ?? "(no title)"} [${j.status}]`);
  h("");
  h(`Native CHS jobs (data_source is not jobber_import): ${nativeJobs.length}.`);
  for (const j of nativeJobs) h(`- #${j.job_number} ${j.title ?? ""} source=${j.source} status=${j.status}`);
  h("");

  h("## Estimates");
  h("");
  h(`Converted quotes: ${converted.length}. EST-9000-range / jobber_import estimates: ${chsEst.length}. Dangling client_id (id not in clients): ${chsEst.filter((e) => !e.client_exists).length}.`);
  h("");
  h("Match key is the quote number already stored in `estimates.notes` (`Jobber Quote #: N`). When that number is absent, the diff tries normalized title + total and keeps the row only when exactly one unused estimate hits. Nothing with two candidates was paired.");
  h("");
  h("### Converted quotes with no unique estimate");
  h("");
  const quoteProblems = quoteLinks.filter((q) => q.kind !== "match");
  if (!quoteProblems.length) h("- None — every converted quote number is on exactly one estimate.");
  for (const q of quoteProblems) h(`- Quote #${q.quote} ${q.client} “${q.title}” $${q.total}: ${q.kind}. ${q.proposal}`);
  h("");
  h("### Client relink (matched quotes whose client_id is dangling or a different client)");
  h("");
  const relinks = quoteLinks.filter((q) => q.kind === "match" && q.proposal.startsWith("relink"));
  const noGuess = quoteLinks.filter((q) => q.kind === "match" && q.proposal.startsWith("no unique") || (q.kind === "match" && q.proposal.startsWith("ambiguous")));
  h(`${relinks.length} unique proposals. ${quoteLinks.filter((q) => q.kind === "match" && q.proposal === "client already correct").length} already point at the matched client. ${noGuess.length} matched estimates have no unique client proposal.`);
  h("");
  h("Proposals that are not unique:");
  h("");
  if (!noGuess.length) h("- None");
  for (const q of noGuess) h(`- Quote #${q.quote} ${q.client}: ${q.proposal}`);
  h("");
  h(`Estimates not tied to a converted quote in this export: ${estNotConverted.length}. Quote numbers parsed from their notes are in \`estimates-not-converted.csv\`. They are not proposed for deletion.`);
  h("");

  h("## Invoices and payments");
  h("");
  h("CHS `invoice_number` is null on the Jobber GraphQL invoices (120 of 121). The one populated number is invoice_number 1, data_source `jobber_historical`, a UUID row. Matching used job number + total + issued date, and when several invoices share a job and a total (both sides the same count) they were paired as a set and labeled, not treated as uniquely identified.");
  h("");
  h("### Not uniquely matched");
  h("");
  const invProblems = invLinks.filter((i) => i.kind !== "match");
  if (!invProblems.length) h("- None");
  for (const i of invProblems) h(`- #${i.num} ${i.client} ${i.status} $${i.total ?? "?"} jobs ${i.jobs || "(none)"}: ${i.kind}. ${i.note}`);
  h("");
  h("### CHS invoices not paired to the CSV");
  h("");
  for (const i of chsInvNotInJobber) {
    h(`- ${i.invoice_number ?? "(no number)"} ${i.status} $${i.total} job #${i.job_number ?? "?"} ${i.job_title ?? ""} data_source=${i.data_source ?? i.job_data_source ?? ""}`);
  }
  h("");
  h("### Invoice total vs recorded Jobber payments");
  h("");
  h("A row is listed when the payment/deposit/refund transactions on that invoice number do not leave a balance equal to the Invoices CSV balance, or a Paid invoice’s payments do not equal its total.");
  h("");
  if (!payGaps.length) h("- None");
  for (const g of payGaps) {
    h(`- #${g.num} ${g.client} ${g.status} total $${g.total} balance $${g.balance} payments $${g.paid} (total−payments $${g.gap}). Txns: ${txnFor(g.num) || "(none)"}`);
  }
  h("");

  h("## Expenses");
  h("");
  h(`Exact or description-head matches: ${expMatch}. Same amount on the adjacent day (old import stored the UTC date): ${expDateShifted}. Identical amount+date pairs on both sides, not individually distinguishable: ${expPairedSets}. Still unmatched: ${expStillMissing.length}. Per-job dollar totals for every Jobber job match within $0.01, including job #44 (Frank Kelly, absent from the Jobs CSV): CSV $${(job44?.csv ?? 0).toFixed(2)} (${job44?.csvN ?? 0} rows), CHS $${(job44?.chs ?? 0).toFixed(2)} (${job44?.chsN ?? 0} rows).`);
  h("");
  h("### Per-job totals that differ by more than $0.01");
  h("");
  if (!expJobDiffs.length) h("- None");
  for (const d of expJobDiffs) h(`- Job ${d.job}: CSV $${d.csv.toFixed(2)} (${d.csvN}) vs CHS $${d.chs.toFixed(2)} (${d.chsN}), CHS−CSV $${d.diff.toFixed(2)}`);
  h("");
  h(`Rows that stayed unmatched (${expStillMissing.length}) are in \`expenses-missing.csv\`. The identical pairs are in \`expenses-ambiguous.csv\`.`);
  h("");

  h("## Spot checks");
  h("");
  const spots = [149, 133, 135, 145, 126, 127, 137, 3, 38, 58, 59, 148, 141, 108];
  for (const n of spots) {
    const s = spot(n);
    const rec = invRecs.find((r) => r.num === n);
    h(`- Invoice #${n} ${rec?.client ?? "?"} Jobber status ${rec?.status ?? "?"} total $${rec?.total} balance $${rec?.balance} jobs ${rec?.jobs.join(" ") || "(none)"} → CHS ${s?.kind}: ${s?.note ?? ""} ${s?.chsStatus ? `chs status ${s.chsStatus}` : ""}`);
  }
  h("");
  const refunds = txns.filter((t) => /refund/i.test(t.Type ?? ""));
  h(`Refund rows in the transaction list: ${refunds.length}.`);
  for (const t of refunds) h(`- ${t["Client name"]} ${t.Date} ${t.Type} ${t["Total $"]} invoice ${t["Invoice #"]} job ${t["Job #"]} refunded on ${t["Refunded on"]}`);
  h("");

  h("## Open quotes (rule 17) — not applied");
  h("");
  h(`These ${OPEN_QUOTE_NUMBERS.length} quotes are the open-quote scope. Quote 277 was cancelled and is omitted. Archived quotes are excluded. A skip requires the same client, total, title, and line items. A partial hit is held for review and is not created and not overwritten.`);
  h("");
  h("| Quote | Client | Jobber status | Title | Total | Client in CHS | Action |");
  h("|---:|---|---|---|---:|---|---|");
  for (const q of openQuotes) {
    h(`| ${q.quote} | ${q.client} | ${q.status} | ${q.title || "(no title)"} | ${q.total ?? "?"} | ${q.clientKind}${q.clientVia ? ` via ${q.clientVia}` : ""} | **${q.action}** |`);
  }
  h("");
  for (const q of openQuotes) {
    const flag = q.flag ? ` Flag: ${q.flag}.` : "";
    h(`- #${q.quote} ${q.client} sent ${q.sent || "?"} property ${q.property || "(none)"}. ${q.note}.${flag} ${q.chsClient ? `CHS client: ${q.chsClient}.` : ""} ${q.estimate ? `Estimate: ${q.estimate}.` : ""}`);
  }
  h("");
  h(`Skip: ${openQuotes.filter((q) => q.action === "skip").length}. Create: ${openQuotes.filter((q) => q.action === "create").length}. Review: ${openQuotes.filter((q) => q.action === "review").length}. Cancelled and omitted: ${[...CANCELLED_OPEN_QUOTES].join(", ")} (Lori Helberg $400 Tile). None of these rows are written by this diff.`);
  h("");

  h("## What this diff does not do");
  h("");
  h("This diff does not insert or update rows. Quote 277 is omitted. The open quotes above are reported only.");
  h("");

  writeFileSync(resolve(OUT, "diff-report.md"), lines.join("\n"));

  writeCsv(
    "clients-missing.csv",
    ["name", "company", "phone", "email", "why"],
    clientMatches.filter((m) => m.kind === "missing").map((m) => [m.jobber.display, m.jobber.company, m.jobber.phone, m.jobber.email, m.jobber.scopeWhy.join("; ")]),
  );
  writeCsv(
    "clients-ambiguous.csv",
    ["name", "via", "candidates"],
    clientMatches.filter((m) => m.kind === "ambiguous").map((m) => [m.jobber.display, m.via, m.chs.map((c) => `${c.id} ${c.display}`).join(" | ")]),
  );
  writeCsv(
    "clients-chs-unmatched.csv",
    ["id", "display", "phone", "email", "data_source", "is_test"],
    chsNotInScope.map((c) => [c.id, c.display, c.phone, c.email, c.data_source, c.is_test]),
  );
  writeCsv(
    "jobs.csv",
    ["job_number", "kind", "on_jobs_csv", "chs", "note"],
    jobRows.map((r) => [r.n, r.kind, r.inJobsCsv ? "yes" : "no", r.chs, r.note]),
  );
  writeCsv(
    "quotes-relink.csv",
    ["quote", "client", "title", "total", "kind", "estimate_id", "estimate_number", "current_client_id", "client_exists", "proposed", "proposal"],
    quoteLinks.map((q) => [q.quote, q.client, q.title, q.total, q.kind, q.estId, q.estNumber, q.currentClient, q.clientExists, q.proposed, q.proposal]),
  );
  writeCsv(
    "open-quotes.csv",
    ["quote", "client", "jobber_status", "title", "total", "line_sum", "sent", "property", "client_kind", "client_via", "chs_client", "action", "estimate", "note", "flag"],
    openQuotes.map((q) => [q.quote, q.client, q.status, q.title, q.total, q.lineSum, q.sent, q.property, q.clientKind, q.clientVia, q.chsClient, q.action, q.estimate, q.note, q.flag]),
  );
  writeCsv(
    "estimates-not-converted.csv",
    ["estimate_number", "title", "total", "quote_in_notes", "client_exists", "notes"],
    estNotConverted.map((e) => [e.estimate_number, e.title, e.total, quoteNumFromNotes(e.notes), e.client_exists, e.notes]),
  );
  writeCsv(
    "invoices.csv",
    ["invoice", "client", "status", "total", "jobs", "kind", "chs_id", "chs_status", "note"],
    invLinks.map((i) => [i.num, i.client, i.status, i.total, i.jobs, i.kind, i.chsId, i.chsStatus, i.note]),
  );
  writeCsv(
    "invoice-payment-gaps.csv",
    ["invoice", "client", "status", "total", "balance", "payments", "total_minus_payments"],
    payGaps.map((g) => [g.num, g.client, g.status, g.total, g.balance, g.paid, g.gap]),
  );
  writeCsv("expenses-missing.csv", ["job", "client", "item", "amount", "date", "act_code"], expStillMissing);
  writeCsv("expenses-ambiguous.csv", ["job", "client", "item", "amount", "date", "candidate_count"], expAmbiguousRows);
  writeCsv(
    "expense-job-diffs.csv",
    ["job", "csv_total", "csv_rows", "chs_total", "chs_rows", "chs_minus_csv"],
    expJobDiffs.map((d) => [d.job, d.csv, d.csvN, d.chs, d.chsN, d.diff]),
  );

  console.log(`Wrote ${resolve(OUT, "diff-report.md")}`);
  console.log(
    JSON.stringify(
      {
        clientsInScope: inScope.length,
        clientMatch: count(clientMatches, "match"),
        clientMissing: count(clientMatches, "missing"),
        clientAmbiguous: count(clientMatches, "ambiguous"),
        jobsReferenced: referenced.size,
        jobMatch: jobCount("match"),
        jobMissing: jobCount("missing"),
        jobCollision: jobCount("collision"),
        quotesConverted: converted.length,
        quoteMatch: quoteCount("match"),
        quoteMissing: quoteCount("missing"),
        invoices: invRecs.length,
        invMatch: invCount("match"),
        invMissing: invCount("missing"),
        invAmbiguous: invCount("ambiguous"),
        expMatch,
        expMissing,
        expAmbiguous,
        csvExpTotal,
        y2026Total,
        y2026Count: y2026.length,
        allInvTotal,
        dbPath,
      },
      null,
      2,
    ),
  );
  db.close();
}

main();
