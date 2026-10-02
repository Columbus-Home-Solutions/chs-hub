import { useEffect, useMemo, useState } from "preact/hooks";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Button } from "../../components/ui/Button";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate } from "../../lib/format";

export interface LaborSettlement {
  expense_date: string | null;
  expense_amount: number;
  expense_type: string | null;
  decision: string | null;
  difference: number | null;
}

export function settlementText(settlement: LaborSettlement | null | undefined): string | null {
  if (!settlement) return null;
  const date = settlement.expense_date ? formatDate(settlement.expense_date) : "—";
  const type = settlement.expense_type || "expense";
  let text = `Paid via existing expense ${date}, ${formatCurrency(settlement.expense_amount)} (${type})`;
  if (settlement.decision === "add_difference" && (settlement.difference ?? 0) > 0) {
    text += `. Difference ${formatCurrency(settlement.difference)} added`;
  } else if (settlement.decision === "accept_as_paid") {
    text += ". Accepted as full payment";
  }
  return text;
}

const CHIP_COLORS = [
  "var(--color-info)",
  "var(--color-success)",
  "var(--color-brand)",
  "var(--color-error)",
];

export function jobChipColor(jobId: string): string {
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) hash = (hash * 33 + jobId.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[hash % CHIP_COLORS.length] ?? CHIP_COLORS[0];
}

export interface LaborWorkerOption {
  id: string;
  name: string;
  day_rate: number | null;
}

export interface LaborJobOption {
  id: string;
  job_number: number | null;
  title: string | null;
  address: string | null;
  label: string;
}

export function JobPicker({
  jobs,
  value,
  onChange,
}: {
  jobs: LaborJobOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = jobs.find((job) => job.id === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setQuery(selected?.label ?? "");
  }, [selected?.label]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? jobs.filter((job) => job.label.toLowerCase().includes(q)) : jobs;
    return list.slice(0, 12);
  }, [jobs, query]);

  return (
    <FormField label="Job">
      <div class="labor-picker">
        <input
          class="form-input"
          value={query}
          placeholder="Search jobs"
          onFocus={() => setOpen(true)}
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value);
            setOpen(true);
            if (value) onChange("");
          }}
        />
        {open && (
          <div class="labor-picker__list" role="listbox">
            {matches.length === 0 ? (
              <div class="catalog-ac__empty">No jobs match</div>
            ) : (
              matches.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  class="catalog-ac__item"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => {
                    onChange(job.id);
                    setQuery(job.label);
                    setOpen(false);
                  }}
                >
                  {job.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </FormField>
  );
}

export function LogDayBar({
  workers,
  jobs,
  date,
  workerId,
  jobId,
  days,
  lockedJob,
  onDate,
  onWorker,
  onJob,
  onDays,
  onAdded,
}: {
  workers: LaborWorkerOption[];
  jobs: LaborJobOption[];
  date: string;
  workerId: string;
  jobId: string;
  days: string;
  lockedJob?: boolean;
  onDate: (v: string) => void;
  onWorker: (v: string) => void;
  onJob: (v: string) => void;
  onDays: (v: string) => void;
  onAdded: (warnings: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!workerId || !jobId || !date) {
      setError("Choose a date, worker, and job.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ warnings: string[] }>("/api/labor/entries", {
        sub_id: workerId,
        entries: [{ job_id: jobId, work_date: date, days: Number(days) }],
      });
      onJob("");
      onAdded(res.warnings ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not log that day");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div class="labor-log">
        <FormField label="Date">
          <input class="form-input" type="date" value={date} onInput={(e) => onDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Worker">
          <Select
            value={workerId}
            placeholder="Choose worker"
            options={workers.map((worker) => ({
              value: worker.id,
              label: worker.day_rate != null ? `${worker.name} — $${Number(worker.day_rate)}/day` : worker.name,
            }))}
            onChange={onWorker}
          />
        </FormField>
        {lockedJob ? (
          <FormField label="Job">
            <input class="form-input" value={jobs.find((job) => job.id === jobId)?.label ?? "This job"} disabled />
          </FormField>
        ) : (
          <JobPicker jobs={jobs} value={jobId} onChange={onJob} />
        )}
        <FormField label="Days">
          <Select
            value={days}
            options={[
              { value: "1", label: "1" },
              { value: "0.5", label: "0.5" },
            ]}
            onChange={onDays}
          />
        </FormField>
        <Button type="button" onClick={submit} disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      {error && <p class="form-error">{error}</p>}
    </div>
  );
}
