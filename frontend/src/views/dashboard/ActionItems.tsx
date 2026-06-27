import { useState } from "preact/hooks";
import { go } from "../../lib/nav";
import { api, ApiError } from "../../api";
import type { ActionItem } from "./types";

interface Props {
  items: ActionItem[];
  loading: boolean;
  error: string | null;
  mobile?: boolean;
  onDismiss?: (id: string) => void;
}

const DISMISS_DELAY_MS = 420;

const PRIORITY_ICON: Record<string, string> = {
  invoice_past_due: "💰",
  invoice_due_soon: "💰",
  cost_plus_cycle: "🏗️",
  new_lead: "📋",
  follow_up_due: "📋",
  job_budget_alert: "🏗️",
  social_approval: "📱",
  change_order_pending: "📄",
  warranty_checkin: "🏗️",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export function ActionItems({ items, loading, error, mobile, onDismiss }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const maxItems = mobile ? 5 : 8;
  const visible = showAll ? items : items.slice(0, maxItems);
  const overflow = items.length - maxItems;

  const dismiss = (e: Event, id: string) => {
    e.stopPropagation();
    if (checkedIds.has(id)) return;
    setCheckedIds((prev) => new Set(prev).add(id));
    setTimeout(async () => {
      try {
        await api.patch(`/api/dashboard/action-items/${encodeURIComponent(id)}/dismiss`, {});
      } catch (err) {
        console.error("Dismiss failed:", err instanceof ApiError ? err.message : err);
      }
      onDismiss?.(id);
    }, DISMISS_DELAY_MS);
  };

  if (loading) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Action Items</h2>
        </div>
        <div class="dash-card__body">
          {[...Array(3)].map((_, i) => (
            <div key={i} class="action-item action-item--skeleton" aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Action Items</h2>
        </div>
        <div class="dash-card__body dash-card__body--error">
          Unable to load action items.
        </div>
      </div>
    );
  }

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Action Items</h2>
        {items.length > 0 && (
          <span class="dash-card__badge">{items.length}</span>
        )}
      </div>
      <div class="dash-card__body">
        {items.length === 0 ? (
          <div class="action-items__empty">
            <span class="action-items__empty-icon">✅</span>
            <span>All clear — nothing needs your attention right now.</span>
          </div>
        ) : (
          <>
            {visible.map((item) => (
              <div
                key={item.id}
                class={`action-item-wrap${checkedIds.has(item.id) ? " action-item-wrap--dismissing" : ""}`}
              >
                <button
                  type="button"
                  class={`action-item__checkbox${checkedIds.has(item.id) ? " action-item__checkbox--checked" : ""}`}
                  title="Mark done"
                  aria-label="Dismiss"
                  onClick={(e) => dismiss(e, item.id)}
                >
                  {checkedIds.has(item.id) && <span class="action-item__checkmark">✓</span>}
                </button>
                <div class={`action-item action-item--${item.priority}`}>
                  <button
                    type="button"
                    class="action-item__main"
                    onClick={() => go(item.link)}
                  >
                    <span class="action-item__icon">{PRIORITY_ICON[item.type] ?? "🔔"}</span>
                    <span class="action-item__title">{item.title}</span>
                    <span class="action-item__time">{relativeTime(item.createdAt)}</span>
                  </button>
                </div>
              </div>
            ))}
            {!showAll && overflow > 0 && (
              <button
                class="action-items__view-all"
                onClick={() => setShowAll(true)}
              >
                View all ({items.length}) →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
