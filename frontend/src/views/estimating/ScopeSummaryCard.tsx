import { useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { formatCurrency } from "../../lib/format";
import { api } from "../../api";
import { go } from "../../lib/nav";
import type { ScopeDraftItem } from "../../types";

function Icon({ name }: { name: string }) {
  return <i class={`ti ti-${name}`} aria-hidden="true" />;
}

interface ScopeSummaryCardProps {
  requestId: string;
  draft: ScopeDraftItem[];
  onDraftUpdate: (draft: ScopeDraftItem[]) => void;
}

export function ScopeSummaryCard({ requestId, draft, onDraftUpdate }: ScopeSummaryCardProps) {
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushSuccess, setPushSuccess] = useState<string | null>(null);

  const active = draft.filter((d) => d.status !== "discarded" && d.status !== "pushed");
  const accepted = active.filter((d) => d.status === "accepted");
  const pending = active.filter((d) => d.status === "pending");
  const unpushedAccepted = accepted;

  const pricedAccepted = accepted.filter((d) => d.unit_price != null);
  const estTotal =
    pricedAccepted.length > 0
      ? accepted.reduce((sum, d) => sum + d.quantity * (d.unit_price ?? 0), 0)
      : null;

  const handlePush = async () => {
    if (unpushedAccepted.length === 0 || pushing) return;
    setPushError(null);
    setPushSuccess(null);
    setPushing(true);
    try {
      const res = await api.post<{
        estimate_id: string;
        items_added: number;
        estimate_created: boolean;
      }>(`/api/estimate-requests/${requestId}/push-to-estimate`);

      const label =
        res.items_added === 1
          ? "1 item added to estimate"
          : `${res.items_added} items added to estimate`;
      setPushSuccess(label);

      const pushedIds = new Set(unpushedAccepted.map((d) => d.id));
      onDraftUpdate(
        draft.map((item) =>
          pushedIds.has(item.id) ? { ...item, status: "pushed" as const } : item,
        ),
      );

      window.setTimeout(() => {
        go(`/estimating/${requestId}/estimate`);
      }, 1500);
    } catch {
      setPushError("Push failed. Try again.");
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card title="Scope summary">
      <div class="scope-summary">
        <div class="scope-summary__row">
          <span class="scope-summary__label">Draft items</span>
          <span class="scope-summary__value">{active.length}</span>
        </div>
        <div class="scope-summary__row">
          <span class="scope-summary__label">Accepted</span>
          <span class="scope-summary__value text--success">{accepted.length}</span>
        </div>
        <div class="scope-summary__row">
          <span class="scope-summary__label">Pending review</span>
          <span class="scope-summary__value text--warning">{pending.length}</span>
        </div>
        <div class="scope-summary__row scope-summary__row--total">
          <span class="scope-summary__label">Est. total</span>
          <span class="scope-summary__value">
            {estTotal != null ? `~${formatCurrency(estTotal)}` : "—"}
          </span>
        </div>
        {pushSuccess && (
          <p class="scope-summary__success text--success">{pushSuccess}</p>
        )}
        {pushError && (
          <p class="scope-summary__error text--error">{pushError}</p>
        )}
        {unpushedAccepted.length > 0 && (
          <Button
            variant="primary"
            block
            disabled={pushing || !!pushSuccess}
            onClick={() => void handlePush()}
          >
            <Icon name="arrow-right" /> {pushing ? "Pushing…" : "Push accepted to estimate"}
          </Button>
        )}
      </div>
    </Card>
  );
}
