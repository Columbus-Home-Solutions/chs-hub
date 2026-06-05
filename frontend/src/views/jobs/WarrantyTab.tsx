import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime, formatStatus } from "../../lib/format";
import { WarrantyFormModal } from "../warranty/WarrantyCalls";

interface WarrantyCall {
  id: string;
  job_id: string;
  job_number: number | null;
  title: string;
  status: string;
  assignee_name: string | null;
  scheduled_date: string | null;
}

interface Props {
  jobId: string;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function WarrantyTab({ jobId }: Props) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<{ warranty_calls: WarrantyCall[] }>(
    `/api/jobs/${jobId}/warranty-calls`,
  );
  const [creating, setCreating] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Warranty calls unavailable</div>
        <div>{error ?? "Could not load warranty calls."}</div>
      </div>
    );
  }

  const calls = data.warranty_calls;

  const complete = async (id: string) => {
    try {
      await api.patch(`/api/warranty-calls/${id}`, { status: "completed" });
      toast.push("success", "Marked completed");
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {calls.length} warranty call(s) · no billing
        </span>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          + Log Warranty Call
        </Button>
      </div>

      <Card title="Warranty Calls">
        {calls.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">🛡️</div>
            <div class="empty-state__title">No warranty calls</div>
            <div>Log callbacks and punch-list follow-ups here.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {calls.map((c) => (
              <div class="invoice-row" key={c.id}>
                <div class="invoice-row__main" style={{ cursor: "pointer" }} onClick={() => go(`/warranty-calls/${c.id}`)}>
                  <div class="invoice-row__title">
                    {c.title}
                    <Badge tone={c.status === "completed" ? "success" : c.status === "open" ? "warning" : "info"}>
                      {formatStatus(c.status)}
                    </Badge>
                  </div>
                  <div class="invoice-row__meta">
                    {c.assignee_name ?? "Unassigned"}
                    {c.scheduled_date ? ` · ${formatDateTime(c.scheduled_date)}` : " · Not scheduled"}
                  </div>
                </div>
                {c.status !== "completed" && c.status !== "cancelled" && (
                  <Button variant="tertiary" size="sm" onClick={() => void complete(c.id)}>
                    ✓
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {creating && (
        <WarrantyFormModal
          jobs={[]}
          presetJobId={jobId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
