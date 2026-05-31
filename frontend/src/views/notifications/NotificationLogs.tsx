import type { ComponentChildren } from "preact";
import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Select } from "../../components/ui/Select";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime, formatStatus } from "../../lib/format";
import { NOTIFICATION_LOG_STATUSES, type NotificationLog } from "../../types";

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  queued: "info",
  sent: "neutral",
  delivered: "success",
  failed: "error",
  bounced: "error",
};

const CHANNELS = ["sms", "email", "push", "in_app"];

export function NotificationLogs(_props: RoutableProps) {
  const toast = useToast();
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [detail, setDetail] = useState<NotificationLog | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (channel) qs.set("channel", channel);
    try {
      const r = await api.get<{ logs: NotificationLog[] }>(
        `/api/notification-logs${qs.toString() ? `?${qs}` : ""}`,
      );
      setLogs(r.logs);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [status, channel]);

  const retry = async (log: NotificationLog) => {
    try {
      await api.post(`/api/notification-logs/${log.id}/retry`, {});
      toast.push("success", "Re-queued — it will resend on the next cycle.");
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Notification Log</h1>
          <p class="view-subtitle">Every automated message — sent, delivered, queued, or failed.</p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/settings/notifications")}>
            ← Templates
          </Button>
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <div class="flex gap-md items-end mb-md" style={{ flexWrap: "wrap" }}>
          <div style={{ minWidth: "160px" }}>
            <label class="form-label">Status</label>
            <Select
              value={status}
              placeholder="All statuses"
              onChange={setStatus}
              options={NOTIFICATION_LOG_STATUSES.map((s) => ({ value: s, label: formatStatus(s) }))}
            />
          </div>
          <div style={{ minWidth: "160px" }}>
            <label class="form-label">Channel</label>
            <Select
              value={channel}
              placeholder="All channels"
              onChange={setChannel}
              options={CHANNELS.map((c) => ({ value: c, label: formatStatus(c) }))}
            />
          </div>
        </div>

        {loading && <Spinner center />}
        {error && <div class="empty-state"><div class="empty-state__title">{error}</div></div>}

        {!loading && !error && (
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Trigger</th>
                  <th>Recipient</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} class="text--muted" style={{ textAlign: "center", padding: "var(--space-lg)" }}>
                      No notifications match these filters.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id} style={{ cursor: "pointer" }} onClick={() => setDetail(log)}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(log.created_at)}</td>
                      <td class="text--mono" style={{ fontSize: "var(--text-xs)" }}>{log.trigger_event}</td>
                      <td>
                        <div>{log.recipient_name}</div>
                        <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>{log.recipient_contact}</div>
                      </td>
                      <td><Badge tone="neutral">{formatStatus(log.channel)}</Badge></td>
                      <td><Badge tone={STATUS_TONE[log.status] ?? "neutral"}>{formatStatus(log.status)}</Badge></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {(log.status === "failed" || log.status === "bounced") && (
                          <Button size="sm" variant="secondary" onClick={() => retry(log)}>
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail && (
        <Modal open title={`${formatStatus(detail.trigger_event)} — ${formatStatus(detail.channel)}`} onClose={() => setDetail(null)}>
          <dl class="detail-list">
            <Row label="Status"><Badge tone={STATUS_TONE[detail.status] ?? "neutral"}>{formatStatus(detail.status)}</Badge></Row>
            <Row label="Recipient">{detail.recipient_name} ({detail.recipient_contact})</Row>
            {detail.subject && <Row label="Subject">{detail.subject}</Row>}
            <Row label="Created">{formatDateTime(detail.created_at)}</Row>
            {detail.scheduled_for && <Row label="Scheduled">{formatDateTime(detail.scheduled_for)}</Row>}
            {detail.sent_at && <Row label="Sent">{formatDateTime(detail.sent_at)}</Row>}
            {detail.delivered_at && <Row label="Delivered">{formatDateTime(detail.delivered_at)}</Row>}
            {detail.retry_count > 0 && <Row label="Retries">{detail.retry_count}</Row>}
            {detail.external_id && <Row label="Provider ID">{detail.external_id}</Row>}
            {detail.error_message && <Row label="Error">{detail.error_message}</Row>}
          </dl>
          <div style={{ marginTop: "var(--space-md)" }}>
            <div class="form-label">Message</div>
            <div style={{ fontSize: "var(--text-sm)", whiteSpace: "pre-wrap", background: "var(--color-surface-2, #f7f7f8)", padding: "var(--space-sm)", borderRadius: "var(--radius-sm)" }}>
              {detail.body}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="detail-list__row" style={{ display: "flex", gap: "var(--space-sm)", padding: "4px 0" }}>
      <dt class="text--muted" style={{ minWidth: "110px", fontSize: "var(--text-sm)" }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: "var(--text-sm)" }}>{children}</dd>
    </div>
  );
}
