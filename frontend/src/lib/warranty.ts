/** Live warranty window check — mirrors src/lib/warranty.ts on the backend. */
export function isWithinWarrantyExpiration(
  warrantyExpiration: string | null | undefined,
  todayIso = new Date().toISOString().slice(0, 10),
): boolean {
  if (!warrantyExpiration) return false;
  const exp = new Date(`${warrantyExpiration.slice(0, 10)}T00:00:00Z`);
  const today = new Date(`${todayIso}T00:00:00Z`);
  if (isNaN(exp.getTime())) return false;
  return exp >= today;
}
