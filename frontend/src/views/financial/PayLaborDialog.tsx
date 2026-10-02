import { useEffect, useMemo, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { formatCurrency, formatDate } from "../../lib/format";
import { centralDate, nextPayFriday, round2 } from "@chs/shared/labor-week";

interface PayableEntry {
  id: string;
  sub_id: string;
  worker_name: string;
  job_id: string;
  job_label: string;
  work_date: string;
  days: number;
  line_total: number;
  week_start: string;
}

interface OverlapMatch {
  expense_id: string;
  amount: number;
  expense_type: string | null;
  incurred_date: string | null;
  vendor: string | null;
  description: string | null;
  difference: number;
}

interface Overlap {
  sub_id: string;
  job_id: string;
  earned: number;
  days: number;
  matches: OverlapMatch[];
}

interface PayableResponse {
  pay_date: string;
  owed_total: number;
  entries: PayableEntry[];
  overlaps: Overlap[];
}

interface MatchChoice {
  mode: "create" | "link";
  expenseId: string | null;
  decision: "add_difference" | "accept_as_paid";
}

function groupKey(subId: string, jobId: string): string {
  return `${subId}|${jobId}`;
}

function daysPhrase(days: number): string {
  const n = round2(days);
  const label = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${label} ${n === 1 ? "day" : "days"}`;
}

function defaultChoices(overlaps: Overlap[]): Record<string, MatchChoice> {
  const next: Record<string, MatchChoice> = {};
  for (const overlap of overlaps) {
    const newest = overlap.matches[0];
    if (!newest) continue;
    next[groupKey(overlap.sub_id, overlap.job_id)] = {
      mode: "link",
      expenseId: newest.expense_id,
      decision: "add_difference",
    };
  }
  return next;
}

export function PayLaborDialog({
  open,
  weekStart,
  onClose,
  onPaid,
}: {
  open: boolean;
  weekStart: string;
  onClose: () => void;
  onPaid: () => void;
}) {
  const toast = useToast();
  const [payDate, setPayDate] = useState(nextPayFriday(centralDate()));
  const [method, setMethod] = useState("check");
  const [note, setNote] = useState("");
  const [includeEarlier, setIncludeEarlier] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, MatchChoice>>({});
  const [data, setData] = useState<PayableResponse | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIncludeEarlier(false);
    setNote("");
    const date = nextPayFriday(centralDate());
    setPayDate(date);
    api
      .get<PayableResponse>(`/api/labor/payable?pay_date=${date}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        const next: Record<string, boolean> = {};
        for (const entry of res.entries) {
          if (entry.week_start === weekStart) next[entry.id] = true;
        }
        setSelected(next);
        setChoices(defaultChoices(res.overlaps));
      })
      .catch((e) => toast.push("error", e instanceof ApiError ? e.message : "Could not load unpaid days"));
    return () => {
      cancelled = true;
    };
  }, [open, weekStart]);

  const refreshPayDate = (date: string) => {
    setPayDate(date);
    api
      .get<PayableResponse>(`/api/labor/payable?pay_date=${date}`)
      .then((res) => {
        setData(res);
        setChoices((prev) => {
          const next = defaultChoices(res.overlaps);
          for (const [key, choice] of Object.entries(prev)) {
            const overlap = res.overlaps.find((row) => groupKey(row.sub_id, row.job_id) === key);
            if (!overlap) continue;
            if (choice.mode === "create") next[key] = choice;
            else if (overlap.matches.some((match) => match.expense_id === choice.expenseId)) next[key] = choice;
          }
          return next;
        });
      })
      .catch(() => {});
  };

  const visible = useMemo(() => {
    const entries = data?.entries ?? [];
    return includeEarlier ? entries : entries.filter((entry) => entry.week_start === weekStart);
  }, [data, includeEarlier, weekStart]);

  const byWorker = useMemo(() => {
    const map = new Map<string, { name: string; entries: PayableEntry[] }>();
    for (const entry of visible) {
      const bucket = map.get(entry.sub_id) ?? { name: entry.worker_name, entries: [] };
      bucket.entries.push(entry);
      map.set(entry.sub_id, bucket);
    }
    return [...map.entries()];
  }, [visible]);

  const selectedEntries = visible.filter((entry) => selected[entry.id]);

  const matchesFor = (subId: string, jobId: string, days: PayableEntry[]) => {
    const picked = days.filter((entry) => selected[entry.id]);
    if (!picked.length) return [];
    const minDate = [...picked.map((entry) => entry.work_date)].sort()[0];
    const overlap = data?.overlaps.find((row) => row.sub_id === subId && row.job_id === jobId);
    return (overlap?.matches ?? []).filter(
      (match) => match.incurred_date != null && match.incurred_date >= minDate && match.incurred_date <= payDate,
    );
  };

  const choiceFor = (key: string, matches: OverlapMatch[]): MatchChoice => {
    const stored = choices[key];
    if (!matches.length) return { mode: "create", expenseId: null, decision: "add_difference" };
    if (stored?.mode === "create") return stored;
    if (stored?.mode === "link" && stored.expenseId && matches.some((match) => match.expense_id === stored.expenseId)) {
      return stored;
    }
    return { mode: "link", expenseId: matches[0].expense_id, decision: stored?.decision ?? "add_difference" };
  };

  const plan = (() => {
    const groups = new Map<string, PayableEntry[]>();
    for (const entry of selectedEntries) {
      const key = groupKey(entry.sub_id, entry.job_id);
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    let payingNow = 0;
    let blocked = false;
    const payload: {
      sub_id: string;
      job_id: string;
      action: "create" | "link";
      expense_id?: string;
      difference_decision?: "add_difference" | "accept_as_paid";
    }[] = [];
    for (const [key, days] of groups) {
      const [sub_id, job_id] = key.split("|");
      const earned = round2(days.reduce((sum, entry) => sum + entry.line_total, 0));
      const matches = matchesFor(sub_id, job_id, days);
      const choice = choiceFor(key, matches);
      if (choice.mode === "create" || !choice.expenseId) {
        payingNow = round2(payingNow + earned);
        payload.push({ sub_id, job_id, action: "create" });
        continue;
      }
      const match = matches.find((row) => row.expense_id === choice.expenseId);
      const difference = round2(earned - (match?.amount ?? 0));
      if (difference > 0) {
        if (choice.decision !== "add_difference" && choice.decision !== "accept_as_paid") blocked = true;
        if (choice.decision === "add_difference") payingNow = round2(payingNow + difference);
        payload.push({
          sub_id,
          job_id,
          action: "link",
          expense_id: choice.expenseId,
          difference_decision: choice.decision,
        });
      } else {
        payload.push({ sub_id, job_id, action: "link", expense_id: choice.expenseId });
      }
    }
    return { payingNow, blocked, payload };
  })();

  const covering = round2(selectedEntries.reduce((sum, entry) => sum + entry.line_total, 0));
  const owedAfter = round2((data?.owed_total ?? 0) - covering);

  const toggleWorker = (entries: PayableEntry[], on: boolean) => {
    setSelected((prev) => {
      const next = { ...prev };
      for (const entry of entries) next[entry.id] = on;
      return next;
    });
  };

  const setChoice = (key: string, choice: MatchChoice) => {
    setChoices((prev) => ({ ...prev, [key]: choice }));
  };

  const submit = async () => {
    if (selectedEntries.length === 0 || plan.blocked) return;
    setPaying(true);
    try {
      const res = await api.post<{ created: boolean }>(`/api/labor/batches/pay`, {
        pay_date: payDate,
        method,
        note: note.trim() || null,
        entry_ids: selectedEntries.map((entry) => entry.id),
        groups: plan.payload,
      });
      toast.push("info", res.created ? "Payment recorded" : "Those days were already paid");
      onPaid();
      onClose();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not record the payment");
    } finally {
      setPaying(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Pay labor"
      size="wide"
      onClose={onClose}
      footer={
        selectedEntries.length === 0 ? (
          <span class="text--muted">Select at least one day</span>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={paying || plan.blocked}>
              {paying ? "Saving…" : `Pay ${formatCurrency(plan.payingNow)}`}
            </Button>
          </>
        )
      }
    >
      <div class="labor-pay-fields">
        <FormField label="Pay date">
          <input class="form-input" type="date" value={payDate} onInput={(e) => refreshPayDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Method">
          <Select
            value={method}
            options={[
              { value: "cash", label: "Cash" },
              { value: "check", label: "Check" },
              { value: "zelle", label: "Zelle" },
              { value: "other", label: "Other" },
            ]}
            onChange={setMethod}
          />
        </FormField>
        <FormField label="Note">
          <input class="form-input" value={note} placeholder="Optional" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <label class="labor-pay-row">
        <span>
          <input
            type="checkbox"
            checked={includeEarlier}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              setIncludeEarlier(on);
              if (on && data) {
                setSelected((prev) => {
                  const next = { ...prev };
                  for (const entry of data.entries) next[entry.id] = true;
                  return next;
                });
              }
            }}
          />{" "}
          Include earlier unpaid weeks
        </span>
        <span class="text--muted">
          Paying now {formatCurrency(plan.payingNow)} · still owed after {formatCurrency(owedAfter)}
        </span>
      </label>
      {byWorker.length === 0 && <p class="text--muted">No unpaid days in a closed week.</p>}
      {byWorker.map(([subId, worker]) => {
        const allOn = worker.entries.every((entry) => selected[entry.id]);
        const jobs = new Map<string, PayableEntry[]>();
        for (const entry of worker.entries) {
          const list = jobs.get(entry.job_id) ?? [];
          list.push(entry);
          jobs.set(entry.job_id, list);
        }
        return (
          <div key={subId} class="labor-pay-worker">
            <label>
              <input type="checkbox" checked={allOn} onChange={(e) => toggleWorker(worker.entries, (e.target as HTMLInputElement).checked)} />{" "}
              <strong>{worker.name}</strong>
            </label>
            {[...jobs.entries()].map(([jobId, days]) => {
              const key = groupKey(subId, jobId);
              const picked = days.filter((entry) => selected[entry.id]);
              const matches = matchesFor(subId, jobId, days);
              const choice = choiceFor(key, matches);
              const earned = round2(picked.reduce((sum, entry) => sum + entry.line_total, 0));
              const dayCount = round2(picked.reduce((sum, entry) => sum + entry.days, 0));
              const linked = matches.find((match) => match.expense_id === choice.expenseId) ?? null;
              const difference = linked ? round2(earned - linked.amount) : 0;
              return (
                <div key={jobId} class="labor-pay-job">
                  <div class="text--muted">{days[0].job_label}</div>
                  {days.map((entry) => (
                    <label key={entry.id} class="labor-pay-row">
                      <span>
                        <input
                          type="checkbox"
                          checked={Boolean(selected[entry.id])}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [entry.id]: (e.target as HTMLInputElement).checked }))
                          }
                        />{" "}
                        {formatDate(entry.work_date)} · {entry.days === 0.5 ? "½" : entry.days} day
                      </span>
                      <span>{formatCurrency(entry.line_total)}</span>
                    </label>
                  ))}
                  {picked.length > 0 && matches.length > 0 && (
                    <div class="labor-pay-matches">
                      {matches.map((match) => (
                        <label key={match.expense_id} class="labor-pay-choice">
                          <input
                            type="radio"
                            name={`labor-match-${key}`}
                            checked={choice.mode === "link" && choice.expenseId === match.expense_id}
                            onChange={() => setChoice(key, { mode: "link", expenseId: match.expense_id, decision: choice.decision })}
                          />
                          <span>
                            {match.incurred_date ? formatDate(match.incurred_date) : "—"} · {match.expense_type ?? "expense"} ·{" "}
                            {match.vendor || match.description || "Expense"} · {formatCurrency(match.amount)}
                          </span>
                        </label>
                      ))}
                      <label class="labor-pay-choice">
                        <input
                          type="radio"
                          name={`labor-match-${key}`}
                          checked={choice.mode === "create"}
                          onChange={() => setChoice(key, { mode: "create", expenseId: null, decision: "add_difference" })}
                        />
                        <span>None of these, create a new expense</span>
                      </label>
                      {choice.mode === "link" && linked && (
                        <p class="labor-pay-reconcile">
                          Earned {formatCurrency(earned)} for {daysPhrase(dayCount)} · logged expense {formatCurrency(linked.amount)}
                          {difference > 0 ? ` · ${formatCurrency(difference)} not recorded` : ""}
                          {difference < 0 ? ` · Logged amount is ${formatCurrency(-difference)} more than these days.` : ""}
                        </p>
                      )}
                      {choice.mode === "link" && difference > 0 && linked && (
                        <div>
                          <label class="labor-pay-choice">
                            <input
                              type="radio"
                              name={`labor-diff-${key}`}
                              checked={choice.decision === "add_difference"}
                              onChange={() => setChoice(key, { ...choice, decision: "add_difference" })}
                            />
                            <span>Add a {formatCurrency(difference)} expense for the difference</span>
                          </label>
                          <label class="labor-pay-choice">
                            <input
                              type="radio"
                              name={`labor-diff-${key}`}
                              checked={choice.decision === "accept_as_paid"}
                              onChange={() => setChoice(key, { ...choice, decision: "accept_as_paid" })}
                            />
                            <span>Treat the logged {formatCurrency(linked.amount)} as the full payment</span>
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </Modal>
  );
}
