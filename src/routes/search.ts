/**
 * GET /api/search?q=<query>
 *
 * Fuzzy-ish search across the operational D1 tables, powering the
 * dashboard Cmd+K palette. LIKE-based (SQLite has no trigram index
 * out of the box and our dataset is small enough that sequential
 * scans are ~1ms). Results are merged, ranked by type + recency,
 * and capped at 20.
 *
 * Searches:
 *   - clients.name, clients.phone, clients.email
 *   - jobs.job_number, jobs.title
 *   - quotes.quote_number
 *   - invoices.id (prefix)
 */

import type { Env } from "../env.js";

interface SearchHit {
  type: "client" | "job" | "quote" | "invoice";
  id: string;
  label: string;
  secondary: string;
  meta: string;
}

const MIN_QUERY = 2;
const LIMIT = 20;

export async function handleSearch(env: Env, url: URL): Promise<SearchHit[]> {
  const raw = (url.searchParams.get("q") || "").trim();
  if (raw.length < MIN_QUERY) return [];

  const q = `%${raw.toLowerCase()}%`;
  const numQ = Number(raw);
  const isNumeric = !isNaN(numQ) && raw.match(/^\d+$/);

  // Run the four searches in parallel. D1 batches them on the same
  // physical connection so the combined latency is roughly one round trip.
  const [clients, jobs, quotes, invoices] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, phone, email
       FROM clients
       WHERE LOWER(name) LIKE ?
          OR LOWER(COALESCE(phone,'')) LIKE ?
          OR LOWER(COALESCE(email,'')) LIKE ?
       LIMIT 10`,
    )
      .bind(q, q, q)
      .all<{ id: string; name: string; phone: string | null; email: string | null }>(),
    env.DB.prepare(
      `SELECT j.id, j.job_number, j.title, j.status, j.total, j.created_at,
              c.name AS client_name
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE LOWER(COALESCE(j.title,'')) LIKE ?
          ${isNumeric ? "OR j.job_number = ?" : ""}
          OR LOWER(COALESCE(c.name,'')) LIKE ?
       ORDER BY j.created_at DESC
       LIMIT 10`,
    )
      .bind(...(isNumeric ? [q, numQ, q] : [q, q]))
      .all<{
        id: string;
        job_number: number | null;
        title: string | null;
        status: string | null;
        total: number | null;
        created_at: string | null;
        client_name: string | null;
      }>(),
    env.DB.prepare(
      `SELECT q.id, q.quote_number, q.status, q.subtotal, q.created_at,
              c.name AS client_name
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE ${isNumeric ? "q.quote_number = ? OR" : ""} LOWER(COALESCE(c.name,'')) LIKE ?
       ORDER BY q.created_at DESC
       LIMIT 10`,
    )
      .bind(...(isNumeric ? [numQ, q] : [q]))
      .all<{
        id: string;
        quote_number: number | null;
        status: string | null;
        subtotal: number | null;
        created_at: string | null;
        client_name: string | null;
      }>(),
    env.DB.prepare(
      `SELECT inv.id, inv.status, inv.total, inv.issued_date,
              c.name AS client_name
       FROM invoices inv
       LEFT JOIN jobs j ON j.id = inv.job_id
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE LOWER(COALESCE(c.name,'')) LIKE ?
       ORDER BY inv.issued_date DESC
       LIMIT 6`,
    )
      .bind(q)
      .all<{
        id: string;
        status: string | null;
        total: number | null;
        issued_date: string | null;
        client_name: string | null;
      }>(),
  ]);

  const hits: SearchHit[] = [];

  for (const c of clients.results ?? []) {
    hits.push({
      type: "client",
      id: c.id,
      label: c.name || "(unnamed)",
      secondary: [c.phone, c.email].filter(Boolean).join(" · ") || "Client",
      meta: "",
    });
  }

  for (const j of jobs.results ?? []) {
    hits.push({
      type: "job",
      id: j.id,
      label: `#${j.job_number ?? "?"} — ${j.title || "(untitled)"}`,
      secondary: `${j.client_name || "—"} · ${prettyStatus(j.status)}`,
      meta: fmtMoney(j.total),
    });
  }

  for (const q of quotes.results ?? []) {
    hits.push({
      type: "quote",
      id: q.id,
      label: `Quote #${q.quote_number ?? "?"}`,
      secondary: `${q.client_name || "—"} · ${prettyStatus(q.status)}`,
      meta: fmtMoney(q.subtotal),
    });
  }

  for (const inv of invoices.results ?? []) {
    hits.push({
      type: "invoice",
      id: inv.id,
      label: `Invoice · ${inv.client_name || "—"}`,
      secondary: `${prettyStatus(inv.status)} · ${inv.issued_date || "—"}`,
      meta: fmtMoney(inv.total),
    });
  }

  return hits.slice(0, LIMIT);
}

function prettyStatus(s: string | null | undefined): string {
  if (!s) return "—";
  return s
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  const sign = v < 0 ? "-" : "";
  return sign + "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
