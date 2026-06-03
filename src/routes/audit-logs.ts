/**
 * Audit-log viewer + CSV export — Sprint 17 (Owner-only via RBAC gate).
 *
 *   GET /api/audit-logs          filters: entity_type, entity_id, user_email,
 *                                action, from, to; paginated, newest-first.
 *   GET /api/audit-logs/export   CSV of the filtered set (no pagination).
 *
 * Built over the EXISTING audit_logs rows prior sprints already write — this is
 * a read surface, not a re-plumbing of audit logging.
 */

import type { Env } from "../env.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

interface AuditRow {
  id: string;
  user_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

interface Filters {
  where: string;
  binds: unknown[];
}

function buildFilters(url: URL): Filters {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const add = (param: string, column: string) => {
    const v = url.searchParams.get(param);
    if (v) {
      clauses.push(`${column} = ?`);
      binds.push(v);
    }
  };
  add("entity_type", "entity_type");
  add("entity_id", "entity_id");
  add("user_email", "user_email");
  add("action", "action");

  const from = url.searchParams.get("from");
  if (from) {
    clauses.push("created_at >= ?");
    binds.push(from);
  }
  const to = url.searchParams.get("to");
  if (to) {
    clauses.push("created_at <= ?");
    binds.push(to);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

// ─── GET /api/audit-logs ─────────────────────────────────────────────────────

export async function handleAuditLogList(env: Env, url: URL): Promise<Response> {
  const { where, binds } = buildFilters(url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`)
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT id, user_email, action, entity_type, entity_id, details, ip_address, created_at
       FROM audit_logs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<AuditRow>();

  const logs = (results ?? []).map((r) => {
    let details: unknown = r.details;
    if (r.details) {
      try {
        details = JSON.parse(r.details);
      } catch {
        details = r.details;
      }
    }
    return { ...r, details };
  });

  return json({
    logs,
    pagination: { total: total?.n ?? 0, limit, offset },
  });
}

// ─── GET /api/audit-logs/export (CSV) ────────────────────────────────────────

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function handleAuditLogExport(env: Env, url: URL): Promise<Response> {
  const { where, binds } = buildFilters(url);
  // Hard cap the export so a runaway filter can't OOM the worker.
  const cap = 50000;
  const { results } = await env.DB.prepare(
    `SELECT id, user_email, action, entity_type, entity_id, details, ip_address, created_at
       FROM audit_logs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(...binds, cap)
    .all<AuditRow>();

  const header = [
    "created_at",
    "user_email",
    "action",
    "entity_type",
    "entity_id",
    "ip_address",
    "details",
  ];
  const lines = [header.join(",")];
  for (const r of results ?? []) {
    lines.push(
      [
        csvCell(r.created_at),
        csvCell(r.user_email),
        csvCell(r.action),
        csvCell(r.entity_type),
        csvCell(r.entity_id),
        csvCell(r.ip_address),
        csvCell(r.details),
      ].join(","),
    );
  }

  const csv = lines.join("\r\n") + "\r\n";
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-logs-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
