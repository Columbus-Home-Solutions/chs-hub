/**
 * Nightly D1 → R2 backup with 30-day retention.
 *
 * Format:
 *   backups/d1/YYYY-MM-DD.ndjson.gz
 *
 *   First line is a manifest object:
 *     { "_manifest": true, "exported_at": ISO, "tables": [{ name, rows }, ...] }
 *
 *   Subsequent lines are one JSON object per row, prefixed with the table:
 *     { "_table": "jobs", ...row fields }
 *
 *   Why NDJSON over a single JSON document: D1 tables can be tens of
 *   thousands of rows; streaming line-at-a-time keeps memory bounded and
 *   makes restore scripts trivial (`zcat | jq -c 'select(._table=="jobs")'`).
 *
 *   Why gzip: ~10x compression on these JSON-ish payloads. We use the
 *   Workers-built-in CompressionStream so there's no extra dependency.
 *
 * Retention:
 *   Same handler lists `backups/d1/*` and deletes anything older than
 *   30 days. R2 lifecycle rules would be cleaner but require dashboard
 *   config; doing it in code keeps the policy in source.
 */

import type { Env } from "../../env.js";
import { notify } from "./notify.js";

const BACKUP_PREFIX = "backups/d1/";
const RETENTION_DAYS = 30;

// Tables to back up. Order matters only for restore (parents before
// children for FK satisfaction); the export itself is independent.
const TABLES = [
  "users",
  "clients",
  "jobs",
  "leads",
  "estimates",
  "quotes",
  "invoices",
  "payments",
  "line_items",
  "expenses",
  "notes",
  "photos",
  "company_documents",
  "drive_mirror_folders",
  "subcontractors",
  "files",
  "file_tags",
  "file_shares",
  "ai_generations",
  "integrations",
  "sync_log",
  "sync_dead_letters",
  "audit_log",
  "kv_cache",
] as const;

export interface BackupResult {
  ok: boolean;
  key: string;
  size_bytes: number;
  total_rows: number;
  tables: Array<{ name: string; rows: number; error?: string }>;
  retention_deleted: number;
  duration_ms: number;
  error?: string;
}

export async function runBackup(env: Env): Promise<BackupResult> {
  const startedAt = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const key = `${BACKUP_PREFIX}${date}.ndjson.gz`;

  const result: BackupResult = {
    ok: false,
    key,
    size_bytes: 0,
    total_rows: 0,
    tables: [],
    retention_deleted: 0,
    duration_ms: 0,
  };

  try {
    const lines: string[] = [];
    const manifest = {
      _manifest: true,
      exported_at: new Date().toISOString(),
      tables: [] as Array<{ name: string; rows: number }>,
    };
    lines.push(""); // placeholder for manifest, filled in last

    for (const table of TABLES) {
      try {
        const rows = await dumpTable(env, table);
        for (const row of rows) {
          lines.push(JSON.stringify({ _table: table, ...row }));
        }
        result.tables.push({ name: table, rows: rows.length });
        manifest.tables.push({ name: table, rows: rows.length });
        result.total_rows += rows.length;
      } catch (err) {
        const msg = (err as Error).message;
        result.tables.push({ name: table, rows: 0, error: msg });
        manifest.tables.push({ name: table, rows: 0 });
      }
    }

    lines[0] = JSON.stringify(manifest);

    const ndjson = lines.join("\n") + "\n";
    const gz = await gzip(ndjson);
    result.size_bytes = gz.byteLength;

    await env.FILES.put(key, gz, {
      httpMetadata: {
        contentType: "application/gzip",
        contentEncoding: "gzip",
      },
      customMetadata: {
        backup_date: date,
        total_rows: String(result.total_rows),
        tables: String(TABLES.length),
      },
    });

    result.retention_deleted = await sweepRetention(env);
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
    result.ok = false;
  }

  result.duration_ms = Date.now() - startedAt;

  // Alert on failure (deduped for 24h so we get one ping per stuck day).
  if (!result.ok) {
    await notify(env, {
      severity: "error",
      subject: "Nightly D1 backup failed",
      text:
        `Backup attempt failed at ${new Date().toISOString()}.\n\n` +
        `Error: ${result.error ?? "(unknown)"}\n` +
        `Tables attempted: ${result.tables.length}\n` +
        `Rows captured before failure: ${result.total_rows}\n`,
      dedupeKey: "backup:failed",
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    }).catch(() => undefined);
  }

  return result;
}

async function dumpTable(
  env: Env,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  // D1 caps result sets per query; for safety we paginate on the rowid.
  // `users` doesn't always have a rowid alias, but every D1 table has the
  // implicit rowid we can SELECT from sqlite_schema-aware queries.
  const PAGE = 1000;
  const out: Array<Record<string, unknown>> = [];
  let lastRowid = 0;

  while (true) {
    const res = await env.DB.prepare(
      `SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
      .bind(lastRowid, PAGE)
      .all<Record<string, unknown> & { __rowid: number }>();

    const rows = res.results ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      lastRowid = r.__rowid;
      delete (r as Record<string, unknown>).__rowid;
      out.push(r);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function gzip(input: string): Promise<Uint8Array> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function sweepRetention(env: Env): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const list = await env.FILES.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    for (const obj of list.objects) {
      if (obj.uploaded.getTime() < cutoff) {
        await env.FILES.delete(obj.key);
        deleted++;
      }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return deleted;
}

export async function getLatestBackup(env: Env): Promise<{
  key: string;
  uploaded_at: string;
  size_bytes: number;
} | null> {
  const list = await env.FILES.list({ prefix: BACKUP_PREFIX, limit: 1000 });
  if (list.objects.length === 0) return null;
  // Sort by upload time desc — list() doesn't guarantee order across pages
  // but we cap at 1000 (~3 years of dailies; way past retention so safe).
  const latest = list.objects.reduce((a, b) =>
    a.uploaded.getTime() >= b.uploaded.getTime() ? a : b,
  );
  return {
    key: latest.key,
    uploaded_at: latest.uploaded.toISOString(),
    size_bytes: latest.size,
  };
}
