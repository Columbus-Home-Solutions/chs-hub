import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { formatCurrency, formatDate } from "../../lib/format";
import type { LaborWorkerOption } from "./labor-shared";

export interface WeekRow {
  week_start: string;
  week_end: string;
  state: "open" | "closed_unpaid" | "partly_paid" | "paid";
  days: number;
  earned: number;
  paid: number;
  unpaid: number;
  workers: number;
}

export interface WeeksResponse {
  weeks: WeekRow[];
  unpaid_summary: { weeks: number; total: number; oldest: string | null };
}

const STATE_LABEL: Record<WeekRow["state"], string> = {
  open: "Open",
  closed_unpaid: "Unpaid",
  partly_paid: "Partly paid",
  paid: "Paid",
};

const STATE_TONE: Record<WeekRow["state"], "info" | "warning" | "brand" | "success"> = {
  open: "info",
  closed_unpaid: "warning",
  partly_paid: "brand",
  paid: "success",
};

export function LaborWeeks({
  status,
  worker,
  onStatus,
  onWorker,
  onOpenWeek,
}: {
  status: string;
  worker: string;
  onStatus: (value: string) => void;
  onWorker: (value: string) => void;
  onOpenWeek: (weekStart: string) => void;
}) {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (worker) query.set("worker", worker);
  const weeks = useApi<WeeksResponse>(`/api/labor/weeks?${query.toString()}`);
  const workers = useApi<{ workers: LaborWorkerOption[] }>("/api/labor/workers");

  return (
    <div class="stack">
      <div class="labor-filters">
        <Select
          value={status}
          placeholder="All states"
          options={[
            { value: "open", label: "Open" },
            { value: "unpaid", label: "Still owed" },
            { value: "closed_unpaid", label: "Unpaid" },
            { value: "partly_paid", label: "Partly paid" },
            { value: "paid", label: "Paid" },
          ]}
          onChange={onStatus}
        />
        <Select
          value={worker}
          placeholder="All workers"
          options={[
            ...(workers.data?.workers ?? []).map((row) => ({ value: row.id, label: row.name })),
          ]}
          onChange={onWorker}
        />
      </div>
      {weeks.loading && <Spinner />}
      {weeks.error && <p class="form-error">{weeks.error}</p>}
      {weeks.data && weeks.data.weeks.length === 0 && <p>No labor weeks match these filters.</p>}
      {weeks.data && weeks.data.weeks.length > 0 && (
        <div class="labor-scroll">
          <table class="labor-grid">
            <thead>
              <tr>
                <th>Week</th>
                <th>Status</th>
                <th class="labor-grid__num">Days</th>
                <th class="labor-grid__num">Earned</th>
                <th class="labor-grid__num">Paid</th>
                <th class="labor-grid__num">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {weeks.data.weeks.map((week) => (
                <tr
                  key={week.week_start}
                  class="labor-week-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenWeek(week.week_start)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenWeek(week.week_start);
                  }}
                >
                  <td>
                    {formatDate(week.week_start)} – {formatDate(week.week_end)}
                    <div class="text--muted">{week.workers} {week.workers === 1 ? "worker" : "workers"}</div>
                  </td>
                  <td>
                    <Badge tone={STATE_TONE[week.state]}>{STATE_LABEL[week.state]}</Badge>
                  </td>
                  <td class="labor-grid__num">{week.days}</td>
                  <td class="labor-grid__num">{formatCurrency(week.earned)}</td>
                  <td class="labor-grid__num">{formatCurrency(week.paid)}</td>
                  <td class="labor-grid__num">{formatCurrency(week.unpaid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
