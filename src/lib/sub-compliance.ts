/**
 * Sub compliance expiration alerts (Sprint 38 Part A).
 *
 * Runs inside the nightly `15 7 * * *` tick — NOT a new cron trigger.
 * The 5-slot Free-plan cap is already full.
 *
 * Alerts the owner (in-app bell) when any active sub's COI or license
 * expiration date falls within 30, 15, or 0 days of today. Uses
 * notification_logs.dedupe_key to fire each threshold exactly once per
 * (sub × field × expiration-date) triplet — so a renewed doc generates
 * fresh alerts at the new expiration's thresholds.
 *
 * Each nightly run that fires at least one alert also sends a single
 * batched email to ALERT_EMAIL_TO — additive alongside the in-app bell,
 * not a replacement. See CHS-Task-SubCompliance-Cron-Email.
 */

import type { Env } from "../env.js";
import { createOwnerInApp, sendSubEmail } from "./notification-engine.js";

interface SubRow {
  id: string;
  company_name: string | null;
  company: string | null;
  coi_expiration_date: string | null;
  license_expiration_date: string | null;
}

export interface SubComplianceResult {
  scanned: number;
  alerted: number;
  errors: number;
  duration_ms: number;
}

const THRESHOLDS = [30, 15, 0] as const;

function formatDate(iso: string): string {
  // "YYYY-MM-DD" → "Month D, YYYY" for readable display
  try {
    const d = new Date(`${iso}T12:00:00Z`);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  } catch {
    return iso;
  }
}

function daysUntil(isoDate: string): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const exp = new Date(`${isoDate}T00:00:00Z`);
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

async function alertForField(
  env: Env,
  sub: SubRow,
  field: "coi" | "license",
  expirationDate: string,
  collectedAlerts: string[],
): Promise<number> {
  const days = daysUntil(expirationDate);
  const subName = (sub.company_name ?? sub.company ?? `Sub ${sub.id.slice(0, 8)}`).trim();
  const fieldLabel = field === "coi" ? "COI" : "License";
  let alerted = 0;

  for (const threshold of THRESHOLDS) {
    // Fire when we're AT or past the threshold but not more than 1 day below it.
    // E.g. threshold=30 fires on day 30 or 29 (cron can run 1 day late).
    if (days <= threshold && days >= threshold - 1) {
      const dedupe = `sub_${field}_expiring:${sub.id}:${threshold}d:${expirationDate}`;
      const daysLabel = days <= 0 ? "TODAY" : `in ${days} day${days === 1 ? "" : "s"}`;
      const msg = `Sub compliance: ${fieldLabel} for ${subName} expires ${daysLabel} (${formatDate(expirationDate)}).`;
      await createOwnerInApp(env, {
        message: msg,
        linkPath: `/app/subcontractors/${sub.id}`,
        dedupe,
      });
      collectedAlerts.push(msg);
      alerted++;
    }
  }
  return alerted;
}

export async function checkSubComplianceAlerts(env: Env): Promise<SubComplianceResult> {
  const t0 = Date.now();
  const result: SubComplianceResult = { scanned: 0, alerted: 0, errors: 0, duration_ms: 0 };
  const collectedAlerts: string[] = [];

  try {
    // Query active subs that have at least one expiration date set and within 31 days
    // (31 = 30-day threshold + 1 day safety margin for cron timing).
    const { results } = await env.DB.prepare(
      `SELECT id, company_name, company, coi_expiration_date, license_expiration_date
         FROM subcontractors
        WHERE is_active = 1
          AND (
            (coi_expiration_date IS NOT NULL AND date(coi_expiration_date) <= date('now', '+31 days'))
            OR
            (license_expiration_date IS NOT NULL AND date(license_expiration_date) <= date('now', '+31 days'))
          )`,
    ).all<SubRow>();

    const subs = results ?? [];
    result.scanned = subs.length;

    for (const sub of subs) {
      try {
        if (sub.coi_expiration_date) {
          result.alerted += await alertForField(env, sub, "coi", sub.coi_expiration_date, collectedAlerts);
        }
        if (sub.license_expiration_date) {
          result.alerted += await alertForField(env, sub, "license", sub.license_expiration_date, collectedAlerts);
        }
      } catch (err) {
        result.errors++;
        console.error(`[sub_compliance] alert failed for sub ${sub.id}:`, (err as Error).message);
      }
    }

    // Send a single batched email to the owner for every night that fires at least one alert.
    // Additive — in-app bell notifications above are unchanged.
    if (collectedAlerts.length > 0) {
      const emailTo = (env.ALERT_EMAIL_TO ?? "").trim();
      if (emailTo) {
        const origin = (env.APP_PUBLIC_ORIGIN ?? "https://app.homesolutionsar.com").replace(/\/$/, "");
        const subject =
          collectedAlerts.length === 1
            ? "Sub compliance alert"
            : `Sub compliance alerts (${collectedAlerts.length})`;
        const body =
          `Nightly compliance check — ${collectedAlerts.length} alert${collectedAlerts.length === 1 ? "" : "s"}:\n\n` +
          collectedAlerts.join("\n") +
          `\n\nView subs: ${origin}/subcontractors`;
        try {
          await sendSubEmail(env, emailTo, subject, body);
        } catch (emailErr) {
          // Non-fatal — in-app alerts already fired; log and continue.
          console.error("[sub_compliance] email send failed:", (emailErr as Error).message);
        }
      }
    }
  } catch (err) {
    result.errors++;
    console.error("[sub_compliance] query failed:", (err as Error).message);
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
