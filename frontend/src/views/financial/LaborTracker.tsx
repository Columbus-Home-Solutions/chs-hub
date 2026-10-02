import { useMemo, useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { route } from "preact-router";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Spinner";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { to } from "../../lib/nav";
import { formatCurrency } from "../../lib/format";
import {
  addDays,
  centralDate,
  datesInWeek,
  weekBounds,
} from "@chs/shared/labor-week";
import { jobChipColor, LogDayBar, type LaborJobOption, type LaborWorkerOption } from "./labor-shared";
import { LaborWeeks, type WeeksResponse } from "./LaborWeeks";
import { LaborByWorker } from "./LaborByWorker";
import { PayLaborDialog } from "./PayLaborDialog";
import { formatDate } from "../../lib/format";

interface GridEntry {
  id: string;
  job_id: string;
  work_date: string;
  days: number;
  day_rate: number;
  line_total: number;
  paid: boolean;
  job_number: number | null;
  job_title: string | null;
  job_label: string;
}

interface WeekWorker {
  sub_id: string;
  name: string;
  day_rate: number | null;
  days: number;
  total: number;
  accrued: number;
  entries: GridEntry[];
}

interface PayGroup {
  sub_id: string;
  job_id: string;
  name: string;
  job_label: string;
  days: number;
  total: number;
  possible_duplicate: boolean;
}

interface WeekResponse {
  week_start: string;
  week_end: string;
  closed: boolean;
  pay_date: string;
  batch: { id: string; pay_date: string; total: number; paid_at: string | null } | null;
  totals: { days: number; accrued_unpaid: number; workers: number };
  workers: WeekWorker[];
  groups: PayGroup[];
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function LaborTracker() {
  const [{ url }] = useRouter();
  const toast = useToast();
  const search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const requested = new URLSearchParams(search).get("week");
  const weekStart = weekBounds(requested || centralDate()).start;

  const week = useApi<WeekResponse>(`/api/labor/week?start=${weekStart}`);
  const workers = useApi<{ workers: LaborWorkerOption[] }>("/api/labor/workers");
  const jobs = useApi<{ jobs: LaborJobOption[] }>("/api/labor/jobs");

  const [date, setDate] = useState(centralDate());
  const [workerId, setWorkerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [days, setDays] = useState("1");
  const [editing, setEditing] = useState<GridEntry | null>(null);
  const [editDays, setEditDays] = useState("1");
  const [payOpen, setPayOpen] = useState(false);
  const [removeReason, setRemoveReason] = useState("");

  const dates = useMemo(() => datesInWeek(weekStart), [weekStart]);
  const params = new URLSearchParams(search);
  const view = params.get("view") || "week";
  const weekStatus = params.get("status") ?? "";
  const weekWorker = params.get("worker") ?? "";
  const ledgerWorker = params.get("sub_id") ?? "";
  const summary = useApi<WeeksResponse>("/api/labor/weeks");

  const setLaborQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    next.set("tab", "labor");
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    route(`${to("/financial")}?${next.toString()}`);
  };

  const goWeek = (start: string) => {
    setLaborQuery({ view: null, week: start });
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const res = await api.put<{ warnings: string[] }>(`/api/labor/entries/${editing.id}`, {
        days: Number(editDays),
      });
      for (const warning of res.warnings ?? []) toast.push("info", warning);
      setEditing(null);
      week.refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not update that day");
    }
  };

  const removeEdit = async () => {
    if (!editing) return;
    try {
      await api.del(`/api/labor/entries/${editing.id}`, { delete_reason: removeReason.trim() || null });
      setEditing(null);
      setRemoveReason("");
      week.refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not delete that day");
    }
  };

  const data = week.data;
  const canPay = Boolean(data && data.closed && data.groups.length > 0);
  let payReason = "";
  if (data && !data.closed) payReason = `Week closes after ${shortDate(data.week_end)}`;
  else if (data && data.groups.length === 0) {
    payReason = data.batch ? `Paid ${shortDate(data.batch.pay_date)}` : "No unpaid days this week";
  }
  const unpaid = summary.data?.unpaid_summary;

  return (
    <div class="stack">
      <div class="view-header">
        <div>
          <h2 class="view-title">Labor Tracker</h2>
          <p class="view-subtitle">
            {view === "week" && data
              ? `${shortDate(data.week_start)} – ${shortDate(data.week_end)}`
              : "Day-rate labor"}
          </p>
        </div>
        <div class="labor-actions labor-no-print">
          <Button variant={view === "week" ? "primary" : "secondary"} type="button" onClick={() => setLaborQuery({ view: null })}>
            This week
          </Button>
          <Button variant={view === "weeks" ? "primary" : "secondary"} type="button" onClick={() => setLaborQuery({ view: "weeks" })}>
            All weeks
          </Button>
          <Button variant={view === "worker" ? "primary" : "secondary"} type="button" onClick={() => setLaborQuery({ view: "worker" })}>
            By worker
          </Button>
        </div>
      </div>

      {unpaid && unpaid.weeks > 0 && (
        <div class="labor-banner labor-no-print">
          <span>
            {unpaid.weeks} {unpaid.weeks === 1 ? "week" : "weeks"} unpaid · {formatCurrency(unpaid.total)}
            {unpaid.oldest ? ` · oldest ${formatDate(unpaid.oldest)}` : ""}
          </span>
          <Button type="button" onClick={() => setLaborQuery({ view: "weeks", status: "unpaid" })}>
            Review
          </Button>
        </div>
      )}

      {view === "weeks" && (
        <LaborWeeks
          status={weekStatus}
          worker={weekWorker}
          onStatus={(value) => setLaborQuery({ view: "weeks", status: value || null })}
          onWorker={(value) => setLaborQuery({ view: "weeks", worker: value || null })}
          onOpenWeek={goWeek}
        />
      )}
      {view === "worker" && (
        <LaborByWorker subId={ledgerWorker} onWorker={(id) => setLaborQuery({ view: "worker", sub_id: id })} />
      )}

      {view === "week" && (
      <div class="labor-actions labor-no-print">
        <Button variant="secondary" type="button" onClick={() => goWeek(addDays(weekStart, -7))}>
          ‹
        </Button>
        <Button variant="secondary" type="button" onClick={() => goWeek(weekBounds(centralDate()).start)}>
          Today
        </Button>
        <Button variant="secondary" type="button" onClick={() => goWeek(addDays(weekStart, 7))}>
          ›
        </Button>
      </div>
      )}

      {view === "week" && <Card title="Log a day">
        <LogDayBar
          workers={workers.data?.workers ?? []}
          jobs={jobs.data?.jobs ?? []}
          date={date}
          workerId={workerId}
          jobId={jobId}
          days={days}
          onDate={setDate}
          onWorker={setWorkerId}
          onJob={setJobId}
          onDays={setDays}
          onAdded={(warnings) => {
            for (const warning of warnings) toast.push("info", warning);
            toast.push("success", "Day logged");
            week.refetch();
          }}
        />
      </Card>}

      {view === "week" && week.loading && <Spinner />}
      {view === "week" && week.error && <p class="form-error">{week.error}</p>}

      {view === "week" && data && (
        <>
          <div class="labor-summary">
            <Card>
              <div class="labor-stat__label">Days this week</div>
              <div class="labor-stat__value">{data.totals.days}</div>
            </Card>
            <Card>
              <div class="labor-stat__label">Accrued unpaid</div>
              <div class="labor-stat__value">{formatCurrency(data.totals.accrued_unpaid)}</div>
            </Card>
            <Card>
              <div class="labor-stat__label">Next payday</div>
              <div class="labor-stat__value">{shortDate(data.pay_date)}</div>
            </Card>
          </div>

          {data.workers.length === 0 ? (
            <Card>
              <p>Log your first day. Pick a worker and a job above — the week grid fills in as you go.</p>
            </Card>
          ) : (
            <Card>
              <div class="labor-scroll">
                <table class="labor-grid">
                  <thead>
                    <tr>
                      <th>Worker</th>
                      {dates.map((day, i) => (
                        <th key={day}>
                          {DAY_NAMES[i]}
                          <div class="text--muted">{shortDate(day)}</div>
                        </th>
                      ))}
                      <th class="labor-grid__num">Days</th>
                      <th class="labor-grid__num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workers.map((worker) => (
                      <tr key={worker.sub_id}>
                        <td>
                          <strong>{worker.name}</strong>
                          <div class="text--muted">
                            {worker.day_rate != null ? `${formatCurrency(worker.day_rate)}/day` : "No rate"}
                          </div>
                        </td>
                        {dates.map((day) => {
                          const cell = worker.entries.filter((entry) => entry.work_date === day);
                          return (
                            <td key={day}>
                              {cell.map((entry) => (
                                <button
                                  key={entry.id}
                                  type="button"
                                  class={`labor-chip${entry.paid ? " labor-chip--locked" : ""}`}
                                  style={{ background: jobChipColor(entry.job_id) }}
                                  onClick={() => {
                                    if (entry.paid) {
                                      toast.push("info", "This day is in a paid batch and can't be edited.");
                                      return;
                                    }
                                    setEditing(entry);
                                    setEditDays(String(entry.days));
                                    setRemoveReason("");
                                  }}
                                >
                                  {entry.job_number ?? entry.job_title ?? "Job"}
                                  {entry.days === 0.5 ? " ½" : ""}
                                  {entry.paid ? " 🔒" : ""}
                                </button>
                              ))}
                            </td>
                          );
                        })}
                        <td class="labor-grid__num">{worker.days}</td>
                        <td class="labor-grid__num">{formatCurrency(worker.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div class="labor-actions labor-no-print">
            <Button
              variant="secondary"
              type="button"
              onClick={() => route(`${to("/financial/labor/statement")}?week=${data.week_start}`)}
            >
              Print statements
            </Button>
            {canPay ? (
              <Button type="button" onClick={() => setPayOpen(true)}>
                Pay labor
              </Button>
            ) : (
              <span class="text--muted">{payReason}</span>
            )}
          </div>
        </>
      )}

      <Modal
        open={Boolean(editing)}
        title="Edit day"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="danger" type="button" onClick={removeEdit}>
              Remove
            </Button>
            <Button type="button" onClick={saveEdit}>
              Save
            </Button>
          </>
        }
      >
        <p>{editing?.job_label}</p>
        <FormField label="Days">
          <Select
            value={editDays}
            options={[
              { value: "1", label: "1" },
              { value: "0.5", label: "0.5" },
            ]}
            onChange={setEditDays}
          />
        </FormField>
        <FormField label="Reason for removing">
          <input class="form-input" value={removeReason} placeholder="Optional" onInput={(e) => setRemoveReason((e.target as HTMLInputElement).value)} />
        </FormField>
      </Modal>

      <PayLaborDialog
        open={payOpen}
        weekStart={data?.week_start ?? weekStart}
        onClose={() => setPayOpen(false)}
        onPaid={() => {
          week.refetch();
          summary.refetch();
        }}
      />
    </div>
  );
}
