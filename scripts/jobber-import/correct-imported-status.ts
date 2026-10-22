/**
 * One-time status correction for three Oct 4 Jobber imports.
 *
 * Preview only. This file never writes to D1. It refuses --remote and --apply.
 *
 * Do not send these through PUT /api/jobs/:id/status.
 * unscheduled and action_required are not movable statuses, so the handler
 * rejects the move. On complete it also stamps actual_end_date with today
 * when that column is empty, and it fires completion side effects.
 *
 * Dates stay blank. Tony adds them by hand after the status change.
 * actual_end_date and start_date are not assigned.
 *
 * Untouched: #105 (action_required), #106 (cancelled), #110 (already complete,
 * actual_end_date 2026-10-22), every archived job, and the older sync rows.
 *
 * After review, Tony runs this himself. Do not run it from the agent:
 *   npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status.sql
 *
 * Rollback (do not delete the audit rows; they are the history):
 *   UPDATE jobs SET status = 'unscheduled', updated_at = datetime('now')
 *    WHERE id IN (
 *      '0f80002e-29e6-4eb4-8021-ab67ee81f086',
 *      '99190438-f0a8-4d36-ae78-f8b19a805931'
 *    ) AND status = 'complete' AND actual_end_date IS NULL AND source = 'jobber_import';
 *   UPDATE jobs SET status = 'action_required', updated_at = datetime('now')
 *    WHERE id = '17522999-ad05-427d-9f5a-6428ed4b506e'
 *      AND status = 'scheduled' AND start_date IS NULL AND source = 'jobber_import';
 */

export interface StatusCorrection {
  jobNumber: number;
  id: string;
  title: string;
  fromStatus: string;
  toStatus: string;
  /** Left null on purpose. Never write today's date here. */
  actualEndDate: null;
  /** Left null. Tony adds #111's start date by hand. */
  startDate: null;
}

export const CORRECTIONS: StatusCorrection[] = [
  {
    jobNumber: 107,
    id: "0f80002e-29e6-4eb4-8021-ab67ee81f086",
    title: "Patio Project",
    fromStatus: "unscheduled",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 109,
    id: "99190438-f0a8-4d36-ae78-f8b19a805931",
    title: "Bathroom Remodel",
    fromStatus: "unscheduled",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 111,
    id: "17522999-ad05-427d-9f5a-6428ed4b506e",
    title: "Deck Staining",
    fromStatus: "action_required",
    toStatus: "scheduled",
    actualEndDate: null,
    startDate: null,
  },
];

export const REMOTE_APPLY_COMMAND =
  "npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status.sql";

export const PREVIEW_SQL = `
SELECT job_number, id, title, status, source, actual_end_date, start_date
  FROM jobs
 WHERE id IN (${CORRECTIONS.map((row) => `'${row.id}'`).join(", ")})
 ORDER BY job_number;
`.trim();

/** Idempotent writes. A second run matches zero rows and inserts no audit. */
export function correctionStatements(): string[] {
  const statements: string[] = [];
  for (const row of CORRECTIONS) {
    const details = JSON.stringify({
      from: row.fromStatus,
      to: row.toStatus,
      via: "imported_status_correction",
      actual_end_date: "left_null",
      start_date: "left_null",
    });
    statements.push(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '${details.replace(/'/g, "''")}', datetime('now')
         FROM jobs
        WHERE id = '${row.id}' AND source = 'jobber_import' AND status = '${row.fromStatus}';`,
    );
    statements.push(
      `UPDATE jobs
          SET status = '${row.toStatus}', updated_at = datetime('now')
        WHERE id = '${row.id}' AND source = 'jobber_import' AND status = '${row.fromStatus}';`,
    );
  }
  return statements;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === "--remote" || arg.includes("remote"))) {
    console.error("Refusing to run against remote. This script is preview-only.");
    process.exit(1);
  }
  console.log("-- preview (no writes) --");
  console.log(PREVIEW_SQL);
  console.log("");
  console.log("-- statements in scripts/jobber-import/correct-imported-status.sql --");
  for (const sql of correctionStatements()) console.log(sql);
  console.log("");
  console.log("Not executed. After review, Tony runs:");
  console.log(REMOTE_APPLY_COMMAND);
  if (args.includes("--apply")) {
    console.error("Refusing --apply. Dates stay null. Tony runs the wrangler command above himself.");
    process.exit(1);
  }
}

const isDirect = process.argv[1]?.includes("correct-imported-status");
if (isDirect) main();
