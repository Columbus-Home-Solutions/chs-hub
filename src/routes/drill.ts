/**
 * GET /api/drill?tile=<name>
 *
 * Drill-down data for each KPI tile. Returns a list of rows keyed to what
 * the user most wants to see when they click that tile. Kept as a single
 * endpoint so the frontend has a consistent contract: `{ tile, title,
 * columns, rows }`.
 *
 * Tiles:
 *   pipeline          → open quotes (awaiting_response / changes_requested / approved)
 *   unpaid            → invoices with an outstanding balance, ordered by age
 *   scheduled         → unpaid invoices with a future due_date
 *   jobs-in-progress  → active jobs (non-archived) with client + last activity
 *   ytd-profit        → monthly revenue / cost / profit / margin breakdown
 *   monthly-revenue   → invoices paid this month, ordered newest first
 *   weekly-revenue    → invoices paid this week, ordered newest first
 */

import type { Env } from "../env.js";

interface DrillResponse {
  tile: string;
  title: string;
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
  as_of: string;
}

const OPEN_JOB_STATUSES = [
  "late",
  "action_required",
  "requires_invoicing",
  "upcoming",
  "on_the_way",
  "active",
  "in_progress",
];

const PIPELINE_QUOTE_STATUSES = [
  "awaiting_response",
  "changes_requested",
  "approved",
];

const MAX_ROWS = 200;

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  const sign = v < 0 ? "-" : "";
  return sign + "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  return Math.round((Date.now() - then) / 86400000);
}

function prettyStatus(s: string | null | undefined): string {
  if (!s) return "—";
  return s
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function handleDrill(env: Env, url: URL): Promise<DrillResponse> {
  const tile = (url.searchParams.get("tile") || "").toLowerCase();
  const asOf = new Date().toISOString();
  const yearStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), 0, 1),
  ).toISOString();
  const yearEnd = new Date(
    Date.UTC(new Date().getUTCFullYear() + 1, 0, 1),
  ).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  switch (tile) {
    case "pipeline": {
      const placeholders = PIPELINE_QUOTE_STATUSES.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT q.id, q.quote_number, q.status, q.subtotal, q.created_at,
                c.name AS client_name
         FROM quotes q
         LEFT JOIN jobs j ON j.id = q.job_id
         LEFT JOIN clients c ON c.id = j.client_id
         WHERE LOWER(COALESCE(q.status,'')) IN (${placeholders})
         ORDER BY q.created_at DESC
         LIMIT ${MAX_ROWS}`,
      )
        .bind(...PIPELINE_QUOTE_STATUSES)
        .all<{
          id: string;
          quote_number: number | null;
          status: string;
          subtotal: number | null;
          created_at: string | null;
          client_name: string | null;
        }>();

      const total = (rows.results ?? []).reduce(
        (s, r) => s + (r.subtotal ?? 0),
        0,
      );

      return {
        tile,
        title: `Pipeline — ${rows.results?.length ?? 0} open quotes`,
        columns: [
          { key: "quote_number", label: "Quote #" },
          { key: "client_name", label: "Client" },
          { key: "status", label: "Status" },
          { key: "age", label: "Age" },
          { key: "subtotal", label: "Amount", align: "right" },
        ],
        rows: (rows.results ?? []).map((r) => ({
          quote_number: r.quote_number ? `#${r.quote_number}` : "—",
          client_name: r.client_name || "—",
          status: prettyStatus(r.status),
          age: ageDays(r.created_at) !== null ? `${ageDays(r.created_at)}d` : "—",
          subtotal: fmtMoney(r.subtotal),
        })),
        totals: { subtotal: fmtMoney(total) },
        as_of: asOf,
      };
    }

    case "unpaid": {
      const rows = await env.DB.prepare(
        `SELECT inv.id, inv.total, inv.payments_total, inv.issued_date, inv.due_date, inv.status,
                c.name AS client_name
         FROM invoices inv
         LEFT JOIN jobs j ON j.id = inv.job_id
         LEFT JOIN clients c ON c.id = j.client_id
         WHERE UPPER(COALESCE(inv.status,'')) <> 'PAID'
           AND COALESCE(inv.total,0) > COALESCE(inv.payments_total,0)
         ORDER BY inv.issued_date ASC
         LIMIT ${MAX_ROWS}`,
      ).all<{
        id: string;
        total: number | null;
        payments_total: number | null;
        issued_date: string | null;
        due_date: string | null;
        status: string;
        client_name: string | null;
      }>();

      const data = (rows.results ?? []).map((r) => {
        const balance = (r.total ?? 0) - (r.payments_total ?? 0);
        return { ...r, balance };
      });
      const total = data.reduce((s, r) => s + r.balance, 0);

      return {
        tile,
        title: `Unpaid Invoices — ${data.length}`,
        columns: [
          { key: "client_name", label: "Client" },
          { key: "status", label: "Status" },
          { key: "issued", label: "Issued" },
          { key: "due", label: "Due" },
          { key: "age", label: "Age" },
          { key: "balance", label: "Balance", align: "right" },
        ],
        rows: data.map((r) => ({
          client_name: r.client_name || "—",
          status: prettyStatus(r.status),
          issued: r.issued_date || "—",
          due: r.due_date || "—",
          age:
            ageDays(r.issued_date) !== null
              ? `${ageDays(r.issued_date)}d`
              : "—",
          balance: fmtMoney(r.balance),
        })),
        totals: { balance: fmtMoney(total) },
        as_of: asOf,
      };
    }

    case "scheduled": {
      const rows = await env.DB.prepare(
        `SELECT inv.id, inv.total, inv.payments_total, inv.due_date, inv.status,
                c.name AS client_name
         FROM invoices inv
         LEFT JOIN jobs j ON j.id = inv.job_id
         LEFT JOIN clients c ON c.id = j.client_id
         WHERE UPPER(COALESCE(inv.status,'')) <> 'PAID'
           AND inv.due_date IS NOT NULL
           AND inv.due_date >= ?
         ORDER BY inv.due_date ASC
         LIMIT ${MAX_ROWS}`,
      )
        .bind(today)
        .all<{
          id: string;
          total: number | null;
          payments_total: number | null;
          due_date: string | null;
          status: string;
          client_name: string | null;
        }>();

      const data = (rows.results ?? []).map((r) => ({
        ...r,
        balance: (r.total ?? 0) - (r.payments_total ?? 0),
      }));
      const total = data.reduce((s, r) => s + r.balance, 0);

      return {
        tile,
        title: `Payments Scheduled — ${data.length}`,
        columns: [
          { key: "client_name", label: "Client" },
          { key: "status", label: "Status" },
          { key: "due", label: "Due" },
          { key: "in_days", label: "In" },
          { key: "balance", label: "Balance", align: "right" },
        ],
        rows: data.map((r) => {
          const inDays = r.due_date
            ? Math.max(
                0,
                Math.round(
                  (new Date(r.due_date).getTime() - Date.now()) / 86400000,
                ),
              )
            : null;
          return {
            client_name: r.client_name || "—",
            status: prettyStatus(r.status),
            due: r.due_date || "—",
            in_days: inDays !== null ? `${inDays}d` : "—",
            balance: fmtMoney(r.balance),
          };
        }),
        totals: { balance: fmtMoney(total) },
        as_of: asOf,
      };
    }

    case "jobs-in-progress": {
      const placeholders = OPEN_JOB_STATUSES.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT j.id, j.job_number, j.title, j.status, j.total, j.start_at, j.created_at,
                c.name AS client_name
         FROM jobs j
         LEFT JOIN clients c ON c.id = j.client_id
         WHERE LOWER(COALESCE(j.status,'')) IN (${placeholders})
         ORDER BY COALESCE(j.start_at, '0000-01-01') DESC, j.created_at DESC
         LIMIT ${MAX_ROWS}`,
      )
        .bind(...OPEN_JOB_STATUSES)
        .all<{
          id: string;
          job_number: number | null;
          title: string | null;
          status: string;
          total: number | null;
          start_at: string | null;
          created_at: string | null;
          client_name: string | null;
        }>();

      const total = (rows.results ?? []).reduce(
        (s, r) => s + (r.total ?? 0),
        0,
      );

      return {
        tile,
        title: `Jobs In Progress — ${rows.results?.length ?? 0}`,
        columns: [
          { key: "job_number", label: "Job #" },
          { key: "client_name", label: "Client" },
          { key: "title", label: "Title" },
          { key: "status", label: "Status" },
          { key: "start", label: "Start" },
          { key: "total", label: "Total", align: "right" },
        ],
        rows: (rows.results ?? []).map((r) => ({
          job_number: r.job_number ? `#${r.job_number}` : "—",
          client_name: r.client_name || "—",
          title: r.title || "—",
          status: prettyStatus(r.status),
          start: r.start_at ? r.start_at.slice(0, 10) : "—",
          total: fmtMoney(r.total),
        })),
        totals: { total: fmtMoney(total) },
        as_of: asOf,
      };
    }

    case "ytd-profit": {
      // Per-month gross revenue (from jobs.total) and line-item cost,
      // joined with expenses bucketed by month.
      const monthly = await env.DB.prepare(
        `WITH months AS (
           SELECT SUBSTR(created_at, 1, 7) AS ym,
                  COALESCE(SUM(total), 0) AS gross
           FROM jobs
           WHERE created_at >= ? AND created_at < ?
           GROUP BY ym
         ),
         li_cost AS (
           SELECT SUBSTR(j.created_at, 1, 7) AS ym,
                  COALESCE(SUM(li.quantity * li.unit_cost), 0) AS cost
           FROM line_items li
           JOIN jobs j ON j.id = li.job_id
           WHERE j.created_at >= ? AND j.created_at < ?
           GROUP BY ym
         ),
         exp_cost AS (
           SELECT SUBSTR(incurred_at, 1, 7) AS ym,
                  COALESCE(SUM(amount), 0) AS cost
           FROM expenses
           WHERE incurred_at >= ? AND incurred_at < ?
           GROUP BY ym
         )
         SELECT m.ym,
                m.gross,
                COALESCE(li.cost, 0) AS li_cost,
                COALESCE(ex.cost, 0) AS exp_cost
         FROM months m
         LEFT JOIN li_cost li ON li.ym = m.ym
         LEFT JOIN exp_cost ex ON ex.ym = m.ym
         ORDER BY m.ym ASC`,
      )
        .bind(
          yearStart,
          yearEnd,
          yearStart,
          yearEnd,
          yearStart.slice(0, 10),
          yearEnd.slice(0, 10),
        )
        .all<{
          ym: string;
          gross: number;
          li_cost: number;
          exp_cost: number;
        }>();

      let sumGross = 0;
      let sumCost = 0;
      const data = (monthly.results ?? []).map((r) => {
        const cost = (r.li_cost ?? 0) + (r.exp_cost ?? 0);
        const profit = r.gross - cost;
        const margin = r.gross > 0 ? (profit / r.gross) * 100 : 0;
        sumGross += r.gross;
        sumCost += cost;
        return {
          ym: r.ym,
          gross: fmtMoney(r.gross),
          cost: fmtMoney(cost),
          profit: fmtMoney(profit),
          margin: margin.toFixed(1) + "%",
        };
      });
      const totalProfit = sumGross - sumCost;
      const totalMargin = sumGross > 0 ? (totalProfit / sumGross) * 100 : 0;

      return {
        tile,
        title: `YTD Profit — Monthly Breakdown`,
        columns: [
          { key: "ym", label: "Month" },
          { key: "gross", label: "Gross", align: "right" },
          { key: "cost", label: "Cost", align: "right" },
          { key: "profit", label: "Profit", align: "right" },
          { key: "margin", label: "Margin", align: "right" },
        ],
        rows: data,
        totals: {
          ym: "YTD",
          gross: fmtMoney(sumGross),
          cost: fmtMoney(sumCost),
          profit: fmtMoney(totalProfit),
          margin: totalMargin.toFixed(1) + "%",
        },
        as_of: asOf,
      };
    }

    case "monthly-revenue":
    case "weekly-revenue": {
      // Paid invoices in the current month or week — shows who paid, when,
      // and how much. Trusts `total` on paid invoices (not payments_total)
      // to match the KPI tile value.
      const now = new Date();
      let start: string;
      if (tile === "weekly-revenue") {
        const s = new Date(now);
        s.setUTCDate(now.getUTCDate() - now.getUTCDay());
        s.setUTCHours(0, 0, 0, 0);
        start = s.toISOString().slice(0, 10);
      } else {
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
          .toISOString()
          .slice(0, 10);
      }

      const rows = await env.DB.prepare(
        `SELECT inv.id, inv.total, inv.issued_date, inv.status,
                c.name AS client_name
         FROM invoices inv
         LEFT JOIN jobs j ON j.id = inv.job_id
         LEFT JOIN clients c ON c.id = j.client_id
         WHERE UPPER(COALESCE(inv.status,'')) = 'PAID'
           AND inv.issued_date >= ?
         ORDER BY inv.issued_date DESC
         LIMIT ${MAX_ROWS}`,
      )
        .bind(start)
        .all<{
          id: string;
          total: number | null;
          issued_date: string | null;
          status: string;
          client_name: string | null;
        }>();

      const total = (rows.results ?? []).reduce(
        (s, r) => s + (r.total ?? 0),
        0,
      );

      return {
        tile,
        title:
          tile === "weekly-revenue"
            ? `Revenue This Week — ${rows.results?.length ?? 0} paid`
            : `Monthly Revenue — ${rows.results?.length ?? 0} paid`,
        columns: [
          { key: "client_name", label: "Client" },
          { key: "issued", label: "Paid" },
          { key: "total", label: "Amount", align: "right" },
        ],
        rows: (rows.results ?? []).map((r) => ({
          client_name: r.client_name || "—",
          issued: r.issued_date || "—",
          total: fmtMoney(r.total),
        })),
        totals: { total: fmtMoney(total) },
        as_of: asOf,
      };
    }

    default:
      throw new Error(`Unknown tile: ${tile}`);
  }
}
