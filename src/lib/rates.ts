/**
 * Runtime accessor for rate-bearing system settings (Sprint 10).
 *
 * Labor rates, the IRS mileage rate, and fee rates all live in `system_settings`
 * and MUST be read at runtime — never hard-coded (business rule #3 / §11 rules
 * 5 & 9). These helpers snapshot the *current* value at the moment of an event
 * (clock-in, mileage entry) so historical rows retain the rate then in effect.
 */

import type { Env } from "../env.js";

const DEFAULTS: Record<string, number> = {
  labor_rate_general: 90.0,
  labor_rate_pm_skilled: 105.0,
  irs_mileage_rate: 0.7,
};

/** Read a numeric system setting, falling back to the seeded default if absent. */
export async function getNumericSetting(env: Env, key: string): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  const n = row?.value != null ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : (DEFAULTS[key] ?? 0);
}

/** Snapshot the hourly labor rate for a time-entry role at clock-in. */
export async function laborRateForRole(env: Env, role: string): Promise<number> {
  const key = role === "pm_skilled" ? "labor_rate_pm_skilled" : "labor_rate_general";
  return getNumericSetting(env, key);
}
