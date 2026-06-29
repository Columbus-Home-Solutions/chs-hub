/**
 * PM (point-of-contact) merge-field resolution from jobs.assigned_to → users.
 */

import type { Env } from "../env.js";

export interface PmFields {
  pm_name: string;
  pm_phone: string;
  pm_email: string;
}

export const OWNER_PM_FALLBACK: PmFields = {
  pm_name: "Tony Columbus",
  pm_phone: "501-263-2050",
  pm_email: "tony@homesolutionsar.com",
};

/** Format a raw phone string for display (best-effort). */
export function formatPmPhone(raw: string | null | undefined): string {
  if (!raw?.trim()) return OWNER_PM_FALLBACK.pm_phone;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.trim();
}

/** Resolve PM contact fields from a job's assigned_to user id. */
export async function resolvePmFields(
  env: Env,
  assignedTo: string | null | undefined,
): Promise<PmFields> {
  if (!assignedTo) return { ...OWNER_PM_FALLBACK };

  const user = await env.DB.prepare(
    "SELECT first_name, last_name, business_phone, email FROM users WHERE id = ?",
  )
    .bind(assignedTo)
    .first<{ first_name: string | null; last_name: string | null; business_phone: string | null; email: string | null }>();

  if (!user) return { ...OWNER_PM_FALLBACK };

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return {
    pm_name: name || OWNER_PM_FALLBACK.pm_name,
    pm_phone: formatPmPhone(user.business_phone),
    pm_email: user.email?.trim() || OWNER_PM_FALLBACK.pm_email,
  };
}

/** Merge PM fields into a flat merge-field map. */
export function applyPmFields(
  fields: Record<string, string>,
  pm: PmFields,
): Record<string, string> {
  return {
    ...fields,
    pm_name: pm.pm_name,
    pm_phone: pm.pm_phone,
    pm_email: pm.pm_email,
  };
}
