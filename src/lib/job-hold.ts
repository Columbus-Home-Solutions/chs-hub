import type { Env } from "../env.js";
import { isHoldableJobStatus } from "../../shared/job-pipeline.js";

export { isHoldableJobStatus };

/**
 * Customer automations that must not send while a job is on_hold.
 * Staff-triggered sends pass manual: true and are not in this gate.
 * The late-fee notice is in this list. Adding or proposing the fee is not.
 * Worker texts and sub texts stay out.
 */
export const CUSTOMER_AUTOMATION_EVENTS = [
  "appointment_confirmed",
  "appointment_reminder",
  "work_starting",
  "invoice_due_reminder",
  "invoice_past_due",
  "invoice_late_fee_added",
  "google_review_request",
  "google_review_followup_1",
  "google_review_followup_2",
  "welcome_portal",
  "completion_package_sent",
] as const;

export function isCustomerAutomationEvent(event: string): boolean {
  return (CUSTOMER_AUTOMATION_EVENTS as readonly string[]).includes(event);
}

/**
 * Status string safe to show a customer. The staff list still says On Hold.
 * A held job keeps its real status in the database.
 */
export function customerFacingJobStatus(status: string | null | undefined): string | null {
  if ((status ?? "").trim() === "on_hold") return "in_progress";
  return status ?? null;
}

export async function jobIsOnHold(db: Env["DB"], jobId: string | null | undefined): Promise<boolean> {
  if (!jobId) return false;
  try {
    const row = await db.prepare("SELECT status FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ status: string | null }>();
    return (row?.status ?? "").trim() === "on_hold";
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/no such (table|column)/i.test(msg)) return false;
    throw err;
  }
}
