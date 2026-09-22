/** More than 5 days in Building. Exactly 5 days stays neutral. */
export const BUILDING_STALE_MS = 5 * 24 * 60 * 60 * 1000;

const PLACEHOLDERS = new Set(["unknown", "n/a", "na", "none", "null", "-", "—", "tbd"]);

/** Drop blank and placeholder address bits so the widget never prints "Unknown". */
export function realText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  if (!t) return null;
  const key = t.toLowerCase();
  if (PLACEHOLDERS.has(key)) return null;
  if (/^0+$/.test(key)) return null;
  return t;
}

export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function daysInBuilding(buildingAt: string | null | undefined, now = Date.now()): number {
  const t = parseTimestamp(buildingAt);
  if (t == null) return 0;
  const elapsed = now - t;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / (24 * 60 * 60 * 1000));
}

export function buildingIsStale(buildingAt: string | null | undefined, now = Date.now()): boolean {
  // Match the floored "N days" label: amber only when that count is > 5.
  return daysInBuilding(buildingAt, now) > 5;
}

export function buildingPlace(parts: {
  property_address?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  phone?: string | null;
  contact_phone?: string | null;
}): string | null {
  const street = realText(parts.property_address);
  const city = realText(parts.property_city);
  const state = realText(parts.property_state);
  const zip = realText(parts.property_zip);
  if (street) {
    const cityLine = [city, state].filter(Boolean).join(", ");
    const tail = [cityLine, zip].filter(Boolean).join(" ");
    return tail ? `${street}, ${tail}` : street;
  }
  return realText(parts.phone) ?? realText(parts.contact_phone);
}

export function buildingClientName(parts: {
  first_name?: string | null;
  last_name?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  contact_phone?: string | null;
}): string {
  const named = realText(`${parts.first_name ?? ""} ${parts.last_name ?? ""}`.trim());
  if (named) return named;
  const contact = realText(parts.contact_name);
  if (contact) return contact;
  return realText(parts.phone) ?? realText(parts.contact_phone) ?? "Lead";
}
