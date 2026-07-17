import { formatDate } from "../lib/format";
import { isWithinWarrantyExpiration } from "../lib/warranty";

interface Props {
  expiration: string | null | undefined;
  /** Tighter padding for inline use inside cards (e.g. Overview Status). */
  compact?: boolean;
}

export function WarrantyExpirationCallout({ expiration, compact = false }: Props) {
  const style = compact
    ? { padding: "var(--space-xs) var(--space-sm)", fontSize: "var(--text-sm)" }
    : undefined;

  if (!expiration) {
    return (
      <div class="callout text--muted" style={style} role="status">
        {compact
          ? "Warranty expiration not yet set"
          : "Warranty expiration not set — closes when the job is marked closed."}
      </div>
    );
  }

  const active = isWithinWarrantyExpiration(expiration);
  const formatted = formatDate(expiration);

  if (active) {
    return (
      <div class="callout callout--success" style={style} role="status">
        <strong>Warranty active through {formatted}</strong>
      </div>
    );
  }

  return (
    <div class="callout callout--error" style={style} role="status">
      <strong>Warranty expired {formatted}</strong>
    </div>
  );
}
