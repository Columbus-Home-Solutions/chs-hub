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
 * Untouched: #105 (on hold / action_required), #106 (cancelled), #110 (already
 * complete), #107 and #109 (already complete; their statements match zero rows
 * on a second run), #111 (already scheduled; same), every archived job.
 *
 * #78, #96, and #99 are older rows. Their source is GQL_API or QUOTE_CONVERT.
 * Match them on id plus data_source = 'jobber_import', not source.
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
 *   UPDATE jobs SET status = 'action_required', updated_at = datetime('now')
 *    WHERE id IN (
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xMzM0Njk0Mjg=',
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xNDM4ODAxNjI='
 *    ) AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';
 *   UPDATE jobs SET status = 'unscheduled', updated_at = datetime('now')
 *    WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQwMTg='
 *      AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';
 *
 * Hidden jobs (#75, #91, #92, #93, #97) are a separate file. Each job is its
 * own block so any one can be deleted before Tony runs it. That file does not
 * include #78, #96, #99, #105, #106, #107, #109, #110, or #111.
 *
 *   npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status-hidden.sql
 *
 * Rollback for that file (do not delete the audit rows):
 *   UPDATE jobs SET status = 'requires_invoicing', updated_at = datetime('now')
 *    WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc='
 *      AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';
 *   UPDATE jobs SET status = 'late', updated_at = datetime('now')
 *    WHERE id IN (
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=',
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=',
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=',
 *      'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc='
 *    ) AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';
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

/**
 * Older imports whose source is not jobber_import. Complete only.
 * Match id + data_source, and only while status is still unscheduled or
 * action_required. A second run matches zero rows.
 */
export const OLDER_COMPLETIONS: StatusCorrection[] = [
  {
    jobNumber: 78,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xMzM0Njk0Mjg=",
    title: "HOU5-205 #7090",
    fromStatus: "action_required",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 96,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQwMTg=",
    title: "Deck refinishing",
    fromStatus: "unscheduled",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 99,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDM4ODAxNjI=",
    title: "Deck Railing",
    fromStatus: "action_required",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
];

/**
 * Hidden imports. Complete only while status is still late or requires_invoicing.
 * One block per job. A second run matches zero rows.
 */
export const HIDDEN_COMPLETIONS: StatusCorrection[] = [
  {
    jobNumber: 75,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc=",
    title: "Property Management and Maintenance",
    fromStatus: "requires_invoicing",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 91,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=",
    title: "Georgetown Apartments",
    fromStatus: "late",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 92,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=",
    title: "Masonry",
    fromStatus: "late",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 93,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=",
    title: "Johnson Siding",
    fromStatus: "late",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
  {
    jobNumber: 97,
    id: "Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc=",
    title: "Gate Repair",
    fromStatus: "late",
    toStatus: "complete",
    actualEndDate: null,
    startDate: null,
  },
];

export const REMOTE_APPLY_COMMAND =
  "npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status.sql";

const PREVIEW_IDS = [...CORRECTIONS, ...OLDER_COMPLETIONS].map((row) => `'${row.id}'`).join(", ");

export const PREVIEW_SQL = `
SELECT job_number, id, title, status, source, data_source, actual_end_date, start_date
  FROM jobs
 WHERE id IN (${PREVIEW_IDS})
 ORDER BY job_number;
`.trim();

const HIDDEN_PREVIEW_IDS = HIDDEN_COMPLETIONS.map((row) => `'${row.id}'`).join(", ");

export const HIDDEN_PREVIEW_SQL = `
SELECT job_number, id, title, status, source, data_source, actual_end_date, start_date
  FROM jobs
 WHERE id IN (${HIDDEN_PREVIEW_IDS})
 ORDER BY job_number;
`.trim();

export const HIDDEN_REMOTE_APPLY_COMMAND =
  "npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status-hidden.sql";

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
  for (const row of OLDER_COMPLETIONS) {
    const where =
      `id = '${row.id}' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required')`;
    statements.push(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE ${where};`,
    );
    statements.push(
      `UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE ${where};`,
    );
  }
  return statements;
}

/** Separate from correctionStatements(). Does not touch the other jobs. */
export function hiddenCompletionStatements(): string[] {
  const statements: string[] = [];
  for (const row of HIDDEN_COMPLETIONS) {
    const where =
      `id = '${row.id}' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing')`;
    statements.push(
      `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE ${where};`,
    );
    statements.push(
      `UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE ${where};`,
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
  console.log("");
  console.log("-- hidden jobs, one block each, in scripts/jobber-import/correct-imported-status-hidden.sql --");
  console.log(HIDDEN_PREVIEW_SQL);
  for (const sql of hiddenCompletionStatements()) console.log(sql);
  console.log("Not executed. After review, Tony runs:");
  console.log(HIDDEN_REMOTE_APPLY_COMMAND);
  if (args.includes("--apply")) {
    console.error("Refusing --apply. Dates stay null. Tony runs the wrangler command above himself.");
    process.exit(1);
  }
}

const isDirect = process.argv[1]?.includes("correct-imported-status");
if (isDirect) main();
