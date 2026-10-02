import { useState } from "preact/hooks";
import { route } from "preact-router";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Spinner";
import { formatCurrency, formatDate } from "../../lib/format";
import { to } from "../../lib/nav";
import { settlementText, type LaborSettlement, type LaborWorkerOption } from "./labor-shared";

interface HistoryEvent {
  id: string;
  action: string;
  user_email: string;
  details: string;
  created_at: string;
}

interface LedgerEntry {
  id: string;
  work_date: string;
  job_label: string;
  days: number;
  day_rate: number;
  amount: number;
  status: "unpaid" | "paid" | "removed";
  pay_date: string | null;
  method: string | null;
  settlement: LaborSettlement | null;
  entered_via: string;
  delete_reason: string | null;
  deleted_by: string | null;
  history: HistoryEvent[];
}

interface LedgerResponse {
  worker: { id: string; name: string; day_rate: number | null };
  totals: { earned: number; paid: number; unpaid: number };
  entries: LedgerEntry[];
}

export function LaborByWorker({
  subId,
  onWorker,
}: {
  subId: string;
  onWorker: (id: string) => void;
}) {
  const workers = useApi<{ workers: LaborWorkerOption[] }>("/api/labor/workers");
  const [from, setFrom] = useState("");
  const [toDate, setToDate] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [history, setHistory] = useState<LedgerEntry | null>(null);

  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (toDate) params.set("to", toDate);
  if (showRemoved) params.set("include_removed", "1");
  const ledger = useApi<LedgerResponse>(subId ? `/api/labor/workers/${subId}/ledger?${params.toString()}` : null);

  const print = () => {
    const q = new URLSearchParams();
    q.set("sub_id", subId);
    if (from) q.set("from", from);
    if (toDate) q.set("to", toDate);
    route(`${to("/financial/labor/statement")}?${q.toString()}`);
  };

  return (
    <div class="stack">
      <div class="labor-filters">
        <Select
          value={subId}
          placeholder="Choose worker"
          options={(workers.data?.workers ?? []).map((row) => ({ value: row.id, label: row.name }))}
          onChange={onWorker}
        />
        <input class="form-input" type="date" value={from} aria-label="From" onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
        <input class="form-input" type="date" value={toDate} aria-label="To" onInput={(e) => setToDate((e.target as HTMLInputElement).value)} />
        <label>
          <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved((e.target as HTMLInputElement).checked)} /> Show removed days
        </label>
        <Button variant="secondary" type="button" disabled={!subId} onClick={print}>
          Print settlement statement
        </Button>
      </div>
      {!subId && <p>Choose a worker to see every day logged for them.</p>}
      {ledger.loading && <Spinner />}
      {ledger.error && <p class="form-error">{ledger.error}</p>}
      {ledger.data && (
        <>
          <div class="labor-scroll">
            <table class="labor-grid">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Job</th>
                  <th class="labor-grid__num">Days</th>
                  <th class="labor-grid__num">Amount</th>
                  <th>Status</th>
                  <th>Paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ledger.data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.work_date)}</td>
                    <td>{entry.job_label}</td>
                    <td class="labor-grid__num">{entry.days}</td>
                    <td class="labor-grid__num">{formatCurrency(entry.amount)}</td>
                    <td>
                      {entry.status === "paid" && <Badge tone="success">Paid</Badge>}
                      {entry.status === "unpaid" && <Badge tone="warning">Unpaid</Badge>}
                      {entry.status === "removed" && <Badge tone="neutral">Removed</Badge>}
                      {entry.status === "removed" && entry.delete_reason && (
                        <div class="text--muted">{entry.delete_reason}</div>
                      )}
                    </td>
                    <td>
                      {entry.pay_date ? `${formatDate(entry.pay_date)}${entry.method ? ` · ${entry.method}` : ""}` : "—"}
                      {settlementText(entry.settlement) && <div class="text--muted">{settlementText(entry.settlement)}</div>}
                      <div class="text--muted">{entry.entered_via}</div>
                    </td>
                    <td>
                      <Button size="sm" variant="tertiary" type="button" onClick={() => setHistory(entry)}>
                        History
                      </Button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <strong>Earned {formatCurrency(ledger.data.totals.earned)}</strong>
                  </td>
                  <td colSpan={2}>
                    <strong>Paid {formatCurrency(ledger.data.totals.paid)}</strong>
                  </td>
                  <td colSpan={2}>
                    <strong>Owed {formatCurrency(ledger.data.totals.unpaid)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {ledger.data.entries.length === 0 && <p>No days in this range.</p>}
        </>
      )}
      <Modal open={Boolean(history)} title="Day history" onClose={() => setHistory(null)}>
        {history && history.history.length === 0 && <p>No edits recorded for this day.</p>}
        {history?.history.map((event) => (
          <p key={event.id}>
            <strong>{event.action.replace(/_/g, " ")}</strong>
            <span class="text--muted"> · {event.user_email} · {formatDate(event.created_at)}</span>
          </p>
        ))}
      </Modal>
    </div>
  );
}
