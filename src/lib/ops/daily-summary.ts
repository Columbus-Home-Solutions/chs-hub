/**
 * Daily summary — "everything is fine, here's what happened yesterday."
 *
 * Sent at 7 AM Central by the 0 12 * * * cron. Designed to be glanceable:
 * if it lands and nothing's red, you can ignore it. The presence of the
 * email itself is also a signal that the cron pipeline is alive.
 *
 * What we report:
 *   - Sync runs in the last 24h: success / error count, latest run age
 *   - Jobs created (created_at >= 24h ago)
 *   - Quotes created
 *   - Invoices issued
 *   - Notes captured
 *   - DLQ depth (open / resolved-24h)
 *   - Latest D1 backup: key + age + size
 */

import type { Env } from "../../env.js";
import { getLatestBackup } from "./backup.js";
import { getDlqSummary } from "./dlq.js";
import { notify } from "./notify.js";

export interface DailySummary {
  for_date: string;
  sync_success: number;
  sync_error: number;
  last_sync_started: string | null;
  jobs_created: number;
  quotes_created: number;
  invoices_issued: number;
  notes_created: number;
  dlq_open: number;
  dlq_resolved_24h: number;
  latest_backup_key: string | null;
  latest_backup_age_hours: number | null;
  latest_backup_size_kb: number | null;
}

export async function buildSummary(env: Env): Promise<DailySummary> {
  const since = "datetime('now', '-1 day')";

  const [
    syncSuccess,
    syncError,
    lastSync,
    jobsCreated,
    quotesCreated,
    invoicesIssued,
    notesCreated,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sync_log
       WHERE status = 'success' AND started_at >= ${since}`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sync_log
       WHERE status = 'error' AND started_at >= ${since}`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT started_at FROM sync_log ORDER BY started_at DESC LIMIT 1`,
    ).first<{ started_at: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ${since}`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM quotes WHERE created_at >= ${since}`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM invoices WHERE issued_date >= date('now', '-1 day')`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notes WHERE created_at >= ${since}`,
    ).first<{ n: number }>(),
  ]);

  const dlq = await getDlqSummary(env).catch(() => ({
    open: 0,
    resolved_24h: 0,
    oldest_open_at: null as string | null,
    by_type: {} as Record<string, number>,
  }));

  const backup = await getLatestBackup(env).catch(() => null);
  const backupAgeHours = backup
    ? (Date.now() - new Date(backup.uploaded_at).getTime()) / (60 * 60 * 1000)
    : null;

  return {
    for_date: new Date().toISOString().slice(0, 10),
    sync_success: syncSuccess?.n ?? 0,
    sync_error: syncError?.n ?? 0,
    last_sync_started: lastSync?.started_at ?? null,
    jobs_created: jobsCreated?.n ?? 0,
    quotes_created: quotesCreated?.n ?? 0,
    invoices_issued: invoicesIssued?.n ?? 0,
    notes_created: notesCreated?.n ?? 0,
    dlq_open: dlq.open,
    dlq_resolved_24h: dlq.resolved_24h,
    latest_backup_key: backup?.key ?? null,
    latest_backup_age_hours: backupAgeHours,
    latest_backup_size_kb: backup ? Math.round(backup.size_bytes / 1024) : null,
  };
}

export async function sendDailySummary(env: Env): Promise<{
  summary: DailySummary;
  sent: boolean;
}> {
  const s = await buildSummary(env);
  const flags: string[] = [];
  if (s.sync_success === 0) flags.push("⚠ no successful syncs in 24h");
  if (s.dlq_open > 0) flags.push(`⚠ ${s.dlq_open} open DLQ rows`);
  if (s.latest_backup_age_hours == null) flags.push("⚠ no D1 backup found");
  else if (s.latest_backup_age_hours > 36)
    flags.push(`⚠ latest backup is ${s.latest_backup_age_hours.toFixed(1)}h old`);

  const subject = flags.length
    ? `Daily summary — ${s.for_date} (${flags.length} flag${flags.length > 1 ? "s" : ""})`
    : `Daily summary — ${s.for_date}`;

  const text = renderText(s, flags);
  const result = await notify(env, {
    severity: flags.length ? "warning" : "info",
    subject,
    text,
    // Daily summary is intentionally NOT deduped — we want it every day.
  });

  return { summary: s, sent: result.sent };
}

function renderText(s: DailySummary, flags: string[]): string {
  const lines: string[] = [];
  lines.push(`Daily summary for ${s.for_date}`);
  lines.push("");
  if (flags.length) {
    lines.push("Flags:");
    for (const f of flags) lines.push(`  ${f}`);
    lines.push("");
  }
  lines.push("Sync (last 24h)");
  lines.push(`  success: ${s.sync_success}`);
  lines.push(`  error:   ${s.sync_error}`);
  lines.push(`  last started: ${s.last_sync_started ?? "(none)"}`);
  lines.push("");
  lines.push("Activity (last 24h)");
  lines.push(`  jobs created:    ${s.jobs_created}`);
  lines.push(`  quotes created:  ${s.quotes_created}`);
  lines.push(`  invoices issued: ${s.invoices_issued}`);
  lines.push(`  notes captured:  ${s.notes_created}`);
  lines.push("");
  lines.push("Dead-letter queue");
  lines.push(`  open:           ${s.dlq_open}`);
  lines.push(`  resolved (24h): ${s.dlq_resolved_24h}`);
  lines.push("");
  lines.push("D1 backup");
  if (s.latest_backup_key) {
    lines.push(`  latest:  ${s.latest_backup_key}`);
    lines.push(
      `  age:     ${s.latest_backup_age_hours?.toFixed(1)}h | size: ${s.latest_backup_size_kb} KB`,
    );
  } else {
    lines.push("  (no backup found)");
  }
  return lines.join("\n");
}
