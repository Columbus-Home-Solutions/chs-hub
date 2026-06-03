import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

// ─── Audit-log viewer + CSV export ───────────────────────────────────────────

interface AuditLog {
  id: string;
  user_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: unknown;
  created_at: string;
}

export function AuditLogTab() {
  const toast = useToast();
  const [filters, setFilters] = useState({ entity_type: "", user_email: "", action: "", from: "", to: "" });
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const query = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ logs: AuditLog[]; pagination: { total: number } }>(
        `/api/audit-logs?${query()}`,
      );
      setLogs(r.logs);
      setTotal(r.pagination.total);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const set = (k: keyof typeof filters, v: string) => setFilters({ ...filters, [k]: v });

  return (
    <Card
      title={`Audit Log (${total})`}
      actions={
        <a class="btn btn--secondary btn--sm" href={`/api/audit-logs/export?${query()}`} target="_blank" rel="noopener">
          Export CSV
        </a>
      }
    >
      <div class="form-row" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
        <FormField label="Entity type">
          <input class="form-input" value={filters.entity_type} onInput={(e) => set("entity_type", (e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="User email">
          <input class="form-input" value={filters.user_email} onInput={(e) => set("user_email", (e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Action">
          <input class="form-input" value={filters.action} onInput={(e) => set("action", (e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="From">
          <input class="form-input" type="date" value={filters.from} onInput={(e) => set("from", (e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="To">
          <input class="form-input" type="date" value={filters.to} onInput={(e) => set("to", (e.target as HTMLInputElement).value)} />
        </FormField>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <Button size="sm" variant="primary" onClick={() => void load()}>
            Apply
          </Button>
        </div>
      </div>

      {loading ? (
        <Spinner center />
      ) : logs.length === 0 ? (
        <div class="empty-state">No audit entries match.</div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td class="text--muted">{new Date(l.created_at + "Z").toLocaleString()}</td>
                <td class="text--mono">{l.user_email}</td>
                <td>{l.action}</td>
                <td class="text--mono">
                  {l.entity_type}:{l.entity_id}
                </td>
                <td class="text--mono" style={{ fontSize: "var(--text-xs)", maxWidth: "320px", overflow: "hidden" }}>
                  {l.details ? JSON.stringify(l.details) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ─── DLQ viewer + retry / dismiss / bulk dismiss ─────────────────────────────

interface DlqItem {
  id: number;
  job_name: string;
  entity_type: string;
  entity_id: string | null;
  error_message: string;
  attempts: number;
  last_seen_at: string;
  status: string;
  payload: unknown;
}

export function DlqTab() {
  const toast = useToast();
  const [items, setItems] = useState<DlqItem[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [status, setStatus] = useState("open");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [payload, setPayload] = useState<DlqItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: DlqItem[]; open_count: number }>(`/api/dlq?status=${status}`);
      setItems(r.items);
      setOpenCount(r.open_count);
      setSelected(new Set());
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [status]);

  const retry = async (id: number) => {
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/api/dlq/${id}/retry`);
      toast.push(r.ok ? "success" : "error", r.ok ? "Retried successfully" : `Retry failed: ${r.error}`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const dismiss = async (id: number) => {
    try {
      await api.post(`/api/dlq/${id}/dismiss`);
      toast.push("success", "Dismissed");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const bulkDismiss = async () => {
    try {
      const r = await api.post<{ dismissed: number }>(`/api/dlq/dismiss`, { ids: [...selected] });
      toast.push("success", `Dismissed ${r.dismissed} item(s)`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  return (
    <Card
      title={`Dead-Letter Queue (${openCount} open)`}
      actions={
        <div class="flex gap-sm items-center">
          <select class="form-select" value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          {selected.size > 0 && (
            <Button size="sm" variant="danger" onClick={bulkDismiss}>
              Dismiss {selected.size}
            </Button>
          )}
        </div>
      }
    >
      {loading ? (
        <Spinner center />
      ) : items.length === 0 ? (
        <div class="empty-state">Queue is clear. 🎉</div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th></th>
              <th>When</th>
              <th>Operation</th>
              <th>Error</th>
              <th>Attempts</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  {it.status === "open" && (
                    <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                  )}
                </td>
                <td class="text--muted">{new Date(it.last_seen_at).toLocaleString()}</td>
                <td class="text--mono">
                  {it.job_name} · {it.entity_type}
                  {it.entity_id ? `:${it.entity_id}` : ""}
                </td>
                <td style={{ maxWidth: "280px" }}>{it.error_message}</td>
                <td>{it.attempts}</td>
                <td>
                  {it.status === "open" ? (
                    <Badge tone="warning">open</Badge>
                  ) : (
                    <Badge tone="neutral">{it.status}</Badge>
                  )}
                </td>
                <td>
                  <div class="flex gap-sm">
                    <Button size="sm" variant="tertiary" onClick={() => setPayload(it)}>
                      Payload
                    </Button>
                    {it.status === "open" && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => retry(it.id)}>
                          Retry
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => dismiss(it.id)}>
                          Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {payload && (
        <Modal open title={`Payload — DLQ #${payload.id}`} onClose={() => setPayload(null)}>
          <pre class="code-block" style={{ maxHeight: "60vh", overflow: "auto" }}>
            {JSON.stringify(payload.payload, null, 2)}
          </pre>
        </Modal>
      )}
    </Card>
  );
}

// ─── Backup status + manual trigger ──────────────────────────────────────────

interface BackupStatus {
  status: string;
  last_backup: { key: string; uploaded_at: string; size_kb: number; age_hours: number } | null;
  retention_days: number;
  note?: string;
}

export function BackupTab() {
  const toast = useToast();
  const [data, setData] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.get<BackupStatus>("/api/backup/status"));
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const trigger = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; total_rows: number; size_kb: number }>("/api/backup/trigger");
      toast.push(r.ok ? "success" : "error", r.ok ? `Backup complete — ${r.total_rows} rows, ${r.size_kb} KB` : "Backup failed");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Backups"
      actions={
        <Button size="sm" variant="primary" disabled={busy} onClick={trigger}>
          {busy ? "Backing up…" : "Back up now"}
        </Button>
      }
    >
      {loading ? (
        <Spinner center />
      ) : !data?.last_backup ? (
        <div class="empty-state">{data?.note ?? "No backups yet."}</div>
      ) : (
        <div class="kv">
          <div class="kv__row">
            <span class="kv__label">Status</span>
            <span class="kv__value">
              <Badge tone={data.status === "healthy" ? "success" : "warning"}>{data.status}</Badge>
            </span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Last backup</span>
            <span class="kv__value">{new Date(data.last_backup.uploaded_at).toLocaleString()} ({data.last_backup.age_hours}h ago)</span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Object</span>
            <span class="kv__value text--mono">{data.last_backup.key}</span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Size</span>
            <span class="kv__value">{data.last_backup.size_kb} KB</span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Retention</span>
            <span class="kv__value">{data.retention_days} days</span>
          </div>
        </div>
      )}
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        Manual backup is a synchronous D1 → R2 export reusing the nightly routine — it adds no cron trigger.
      </p>
    </Card>
  );
}

// ─── System-health panel (read-only) ─────────────────────────────────────────

interface HealthData {
  ok: boolean;
  subsystems: Record<string, { status: string; latency_ms?: number; detail?: string }>;
  heartbeat: { healthy: boolean; last_success_at: string | null; age_ms: number | null } | null;
  cron_triggers: { cron: string; label: string; last_runs: { job: string; status: string; last_run_at: string | null }[] }[];
  cron_count: number;
  dlq: { open: number; resolved_24h: number } | null;
  backup: { uploaded_at: string; age_hours: number } | null;
  integrations: { service: string; status: string; last_sync: string | null; last_error: string | null }[];
}

function statusTone(s: string): "success" | "warning" | "error" | "neutral" {
  if (s === "connected" || s === "success" || s === "connected") return "success";
  if (s === "error" || s === "failed") return "error";
  if (s === "unknown") return "neutral";
  return "warning";
}

export function HealthTab() {
  const toast = useToast();
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.get<HealthData>("/api/health"));
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (loading) return <Spinner center />;
  if (!data) return <div class="empty-state">Couldn't load health.</div>;

  return (
    <div>
      <Card
        title="System Health"
        actions={
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        <div class="flex gap-sm items-center" style={{ flexWrap: "wrap" }}>
          <Badge tone={data.ok ? "success" : "error"}>{data.ok ? "All systems OK" : "Degraded"}</Badge>
          {Object.entries(data.subsystems).map(([k, v]) => (
            <Badge key={k} tone={statusTone(v.status)}>
              {k.toUpperCase()}: {v.status}
            </Badge>
          ))}
          {data.heartbeat && (
            <Badge tone={data.heartbeat.healthy ? "success" : "error"}>
              Sync heartbeat: {data.heartbeat.healthy ? "healthy" : "stale"}
            </Badge>
          )}
          {data.dlq && (
            <Badge tone={data.dlq.open > 0 ? "warning" : "success"}>DLQ open: {data.dlq.open}</Badge>
          )}
          {data.backup && (
            <Badge tone={data.backup.age_hours <= 26 ? "success" : "warning"}>
              Backup: {data.backup.age_hours}h ago
            </Badge>
          )}
        </div>
      </Card>

      <div class="mt-lg" />
      <Card title={`Cron triggers (${data.cron_count} of 5 — Free-plan cap)`}>
        <table class="table">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Jobs</th>
              <th>Last runs</th>
            </tr>
          </thead>
          <tbody>
            {data.cron_triggers.map((c) => (
              <tr key={c.cron}>
                <td class="text--mono">{c.cron}</td>
                <td>{c.label}</td>
                <td>
                  <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
                    {c.last_runs.map((r) => (
                      <Badge key={r.job} tone={statusTone(r.status)}>
                        {r.job}: {r.status}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div class="mt-lg" />
      <Card title="Integration sync status">
        {data.integrations.length === 0 ? (
          <div class="empty-state">No integrations configured.</div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Last sync</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.service}>
                  <td>{i.service}</td>
                  <td>
                    <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                  </td>
                  <td class="text--muted">{i.last_sync ? new Date(i.last_sync).toLocaleString() : "—"}</td>
                  <td class="text--muted" style={{ maxWidth: "260px" }}>{i.last_error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
