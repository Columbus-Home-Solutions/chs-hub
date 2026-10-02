import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Modal } from "../../components/ui/Modal";
import { formatCurrency, formatDate } from "../../lib/format";
import { centralDate } from "@chs/shared/labor-week";
import { LogDayBar, type LaborJobOption, type LaborWorkerOption } from "../financial/labor-shared";

interface JobLaborEntry {
  id: string;
  work_date: string;
  days: number;
  day_rate: number;
  line_total: number;
  paid: boolean;
  worker_name: string;
}

interface JobLaborWorker {
  sub_id: string;
  name: string;
  days: number;
  cost: number;
  accrued: number;
  entries: JobLaborEntry[];
}

interface JobLaborResponse {
  accrued_total: number;
  workers: JobLaborWorker[];
}

export function JobLaborCard({ jobId, jobLabel }: { jobId: string; jobLabel?: string }) {
  const labor = useApi<JobLaborResponse>(`/api/labor/jobs/${jobId}/entries`);
  const workers = useApi<{ workers: LaborWorkerOption[] }>("/api/labor/workers");
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(centralDate());
  const [workerId, setWorkerId] = useState("");
  const [days, setDays] = useState("1");

  const jobs: LaborJobOption[] = [
    { id: jobId, job_number: null, title: jobLabel ?? "This job", address: null, label: jobLabel ?? "This job" },
  ];

  return (
    <Card
      title="Labor on this job"
      actions={
        <Button size="sm" type="button" onClick={() => setOpen(true)}>
          + Log days
        </Button>
      }
    >
      {labor.loading && <p class="text--muted">Loading labor…</p>}
      {labor.error && <p class="form-error">{labor.error}</p>}
      {labor.data && labor.data.workers.length === 0 && (
        <p class="text--muted">No day-rate labor logged on this job yet.</p>
      )}
      {labor.data && labor.data.workers.length > 0 && (
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Dates</th>
                <th class="num">Days</th>
                <th class="num">Rate</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {labor.data.workers.map((worker) => (
                <tr key={worker.sub_id}>
                  <td>
                    {worker.name}{" "}
                    {worker.accrued > 0 ? <Badge tone="warning">Unpaid</Badge> : <Badge tone="success">Paid</Badge>}
                  </td>
                  <td>{worker.entries.map((entry) => formatDate(entry.work_date)).join(", ")}</td>
                  <td class="num">{worker.days}</td>
                  <td class="num">{formatCurrency(worker.entries[0]?.day_rate ?? 0)}</td>
                  <td class="num">{formatCurrency(worker.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <strong>Accrued unpaid: {formatCurrency(labor.data.accrued_total)}</strong>
          </p>
        </div>
      )}

      <Modal open={open} title="Log days" size="wide" onClose={() => setOpen(false)}>
        <LogDayBar
          workers={workers.data?.workers ?? []}
          jobs={jobs}
          date={date}
          workerId={workerId}
          jobId={jobId}
          days={days}
          lockedJob
          onDate={setDate}
          onWorker={setWorkerId}
          onJob={() => {}}
          onDays={setDays}
          onAdded={() => {
            labor.refetch();
          }}
        />
      </Modal>
    </Card>
  );
}
