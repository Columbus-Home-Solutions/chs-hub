import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { go } from "../../lib/nav";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

interface Connection {
  service: string;
  status: string;
  last_sync: string | null;
  last_error: string | null;
  connected_at: string | null;
}

const SERVICE_META: Record<string, { label: string; icon: string }> = {
  quickbooks: { label: "QuickBooks Online", icon: "📚" },
  stripe: { label: "Stripe", icon: "💳" },
  twilio: { label: "Twilio (SMS)", icon: "💬" },
  resend: { label: "Resend (Email)", icon: "✉️" },
  facebook: { label: "Facebook", icon: "📘" },
  instagram: { label: "Instagram", icon: "📸" },
  wc_spreadsheet: { label: "WC Spreadsheet", icon: "📊" },
  google_drive: { label: "Google Drive", icon: "🗂️" },
};

function statusTone(s: string): "success" | "warning" | "error" | "neutral" {
  if (s === "connected") return "success";
  if (s === "error") return "error";
  if (s === "disconnected") return "neutral";
  return "warning";
}

export function IntegrationsTab() {
  const toast = useToast();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ integrations: Connection[] }>("/api/integrations");
      setConnections(r.integrations);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const test = async (service: string) => {
    setBusy(service);
    try {
      const r = await api.post<{ ok: boolean; note?: string; status?: string }>(`/api/integrations/${service}/test`);
      toast.push(r.ok ? "success" : "info", r.note ?? (r.ok ? "Connection OK" : `Status: ${r.status}`));
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async (service: string) => {
    setBusy(service);
    try {
      await api.post(`/api/integrations/${service}/disconnect`);
      toast.push("success", `${service} disconnected`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner center />;

  return (
    <div>
      <Card
        title="Integrations"
        actions={
          <Button size="sm" variant="secondary" onClick={() => go("/settings/integrations")}>
            QuickBooks setup
          </Button>
        }
      >
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
          Manage existing connections. No new live service is wired this sprint — Stripe stays test mode, QBO sandbox,
          WC test sheet, social SIMULATE. Tokens are never displayed.
        </p>
        {connections.length === 0 ? (
          <div class="empty-state">No connections recorded yet.</div>
        ) : (
          <div class="integration-cards">
            {connections.map((c) => {
              const meta = SERVICE_META[c.service] ?? { label: c.service, icon: "🔌" };
              return (
                <div class="card" key={c.service} style={{ marginBottom: "var(--space-md)" }}>
                  <div class="card__body">
                    <div class="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
                      <div class="flex items-center gap-sm">
                        <span style={{ fontSize: "1.4rem" }}>{meta.icon}</span>
                        <strong>{meta.label}</strong>
                      </div>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </div>
                    <div class="kv" style={{ marginTop: "var(--space-sm)" }}>
                      <div class="kv__row">
                        <span class="kv__label">Last sync</span>
                        <span class="kv__value">{c.last_sync ? new Date(c.last_sync).toLocaleString() : "—"}</span>
                      </div>
                      {c.last_error && (
                        <div class="kv__row">
                          <span class="kv__label">Last error</span>
                          <span class="kv__value text--mono" style={{ fontSize: "var(--text-xs)" }}>{c.last_error}</span>
                        </div>
                      )}
                    </div>
                    <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)" }}>
                      <Button size="sm" variant="secondary" disabled={busy === c.service} onClick={() => test(c.service)}>
                        Test
                      </Button>
                      {c.service === "quickbooks" ? (
                        <Button size="sm" variant="tertiary" onClick={() => go("/settings/integrations")}>
                          Manage
                        </Button>
                      ) : (
                        c.status !== "disconnected" && (
                          <Button size="sm" variant="danger" disabled={busy === c.service} onClick={() => disconnect(c.service)}>
                            Disconnect
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
