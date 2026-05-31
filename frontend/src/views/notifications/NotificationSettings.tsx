import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatStatus } from "../../lib/format";
import { NOTIFICATION_PHASES, type NotificationTemplate } from "../../types";

interface ListResponse {
  phases: Record<string, NotificationTemplate[]>;
  total: number;
}

function timingLabel(t: NotificationTemplate): string {
  if (t.send_time) return `${t.send_time}`;
  const d = t.delay_minutes ?? 0;
  if (d === 0) return "Immediate";
  const abs = Math.abs(d);
  const unit = abs % 1440 === 0 ? `${abs / 1440}d` : abs % 60 === 0 ? `${abs / 60}h` : `${abs}m`;
  return d < 0 ? `${unit} before` : `${unit} after`;
}

export function NotificationSettings(_props: RoutableProps) {
  const toast = useToast();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationTemplate | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<ListResponse>("/api/notification-templates"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (t: NotificationTemplate) => {
    try {
      await api.put(`/api/notification-templates/${t.id}`, { is_active: !t.is_active });
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const phaseKeys = data ? Object.keys(data.phases) : [];
  const orderedPhases = [
    ...NOTIFICATION_PHASES.filter((p) => phaseKeys.includes(p.key)),
    ...phaseKeys
      .filter((k) => !NOTIFICATION_PHASES.some((p) => p.key === k))
      .map((k) => ({ key: k, label: formatStatus(k) })),
  ];

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Notification Settings</h1>
          <p class="view-subtitle">
            Edit the automated messages clients receive. Toggle a template off to stop it firing.
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/settings")}>
            ← Settings
          </Button>
          <Button variant="secondary" onClick={() => go("/settings/notifications/logs")}>
            View Log
          </Button>
        </div>
      </div>

      {loading && <Spinner center />}
      {error && (
        <div class="empty-state">
          <div class="empty-state__title">Couldn't load templates</div>
          <div>{error}</div>
        </div>
      )}

      {!loading &&
        !error &&
        orderedPhases.map((phase) => (
          <div key={phase.key} class="mb-lg">
            <Card title={phase.label}>
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Trigger</th>
                      <th>Channel</th>
                      <th>Timing</th>
                      <th>Active</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data!.phases[phase.key] ?? []).map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td class="text--mono" style={{ fontSize: "var(--text-xs)" }}>
                          {t.trigger_event}
                        </td>
                        <td>
                          <Badge tone="neutral">{formatStatus(t.channel)}</Badge>
                        </td>
                        <td>{timingLabel(t)}</td>
                        <td>
                          {t.is_active ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <Badge tone="warning">Off</Badge>
                          )}
                        </td>
                        <td>
                          <div class="flex gap-sm">
                            <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="tertiary" onClick={() => toggle(t)}>
                              {t.is_active ? "Disable" : "Enable"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        ))}

      {editing && (
        <TemplateEditModal
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditModal({
  template,
  onClose,
  onSaved,
}: {
  template: NotificationTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body_template);
  const [channel, setChannel] = useState(template.channel);
  const [active, setActive] = useState(template.is_active);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ subject: string | null; body: string } | null>(null);

  const isEmail = channel === "email";

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/notification-templates/${template.id}`, {
        subject: isEmail ? subject : null,
        body_template: body,
        channel,
        is_active: active,
      });
      toast.push("success", "Template saved");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  const doPreview = async () => {
    try {
      const r = await api.post<{ preview: { subject: string | null; body: string } }>(
        `/api/notification-templates/${template.id}/preview`,
        {},
      );
      setPreview(r.preview);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const doTest = async () => {
    try {
      const r = await api.post<{ ok: boolean; simulated: boolean; detail: string }>(
        `/api/notification-templates/${template.id}/test`,
        {},
      );
      toast.push(r.ok ? "success" : "error", r.detail);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <Modal
      open
      title={`Edit — ${template.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" onClick={doPreview} disabled={busy}>
            Preview
          </Button>
          <Button variant="tertiary" onClick={doTest} disabled={busy}>
            Test to me
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Channel">
          <Select
            value={channel}
            onChange={setChannel}
            options={["sms", "email", "push", "in_app"].map((v) => ({ value: v, label: formatStatus(v) }))}
          />
        </FormField>
        <FormField label="Trigger">
          <input class="form-input" value={template.trigger_event} disabled />
        </FormField>
      </div>
      {isEmail && (
        <FormField label="Subject">
          <input
            class="form-input"
            value={subject}
            onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
          />
        </FormField>
      )}
      <FormField label="Message body" hint={`Merge fields: ${template.merge_fields.map((f) => `{{${f}}}`).join(", ") || "none"}`}>
        <textarea
          class="form-textarea"
          style={{ minHeight: "120px" }}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive((e.target as HTMLInputElement).checked)} />
        <span>Active (fires automatically)</span>
      </label>

      {preview && (
        <div class="mt-md" style={{ borderTop: "1px solid var(--color-border)", paddingTop: "var(--space-sm)" }}>
          <div class="text--muted" style={{ fontSize: "var(--text-xs)", marginBottom: "4px" }}>
            Preview (sample data)
          </div>
          {preview.subject && (
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>{preview.subject}</div>
          )}
          <div style={{ fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>{preview.body}</div>
        </div>
      )}
    </Modal>
  );
}
