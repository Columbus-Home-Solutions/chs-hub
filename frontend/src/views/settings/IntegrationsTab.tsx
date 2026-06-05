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
  const [imageGen, setImageGen] = useState<{
    credentials_present: boolean;
    enabled: boolean;
  } | null>(null);
  const [social, setSocial] = useState<{
    connected: boolean;
    publish_mode: "live" | "simulate";
    page_label: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [imageGenBusy, setImageGenBusy] = useState(false);
  const [socialTestBusy, setSocialTestBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [integrations, status, socialStatus, settings] = await Promise.all([
        api.get<{ integrations: Connection[] }>("/api/integrations"),
        api.get<{ credentials_present: boolean; enabled: boolean }>("/api/integrations/image-gen/status"),
        api.get<{ connected: boolean; publish_mode: "live" | "simulate"; page_label: string }>(
          "/api/social/status",
        ),
        api.get<{ settings: Array<{ key: string; value: string; value_type: string }> }>("/api/settings"),
      ]);
      setConnections(integrations.integrations);
      const setting = settings.settings.find((s) => s.key === "image_gen_enabled");
      setImageGen({
        credentials_present: status.credentials_present,
        enabled: setting ? setting.value === "true" || setting.value === "1" : status.enabled,
      });
      setSocial({
        connected: socialStatus.connected,
        publish_mode: socialStatus.publish_mode,
        page_label: socialStatus.page_label,
      });
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

  const testSocial = async () => {
    setSocialTestBusy(true);
    try {
      const r = await api.get<{ ok: boolean; page_name?: string; error?: string }>(
        "/api/social/test-connection",
      );
      if (r.ok) {
        toast.push("success", r.page_name ? `Connected: ${r.page_name}` : "Facebook connection OK");
      } else {
        toast.push("error", r.error ?? "Connection test failed");
      }
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSocialTestBusy(false);
    }
  };

  const toggleImageGen = async () => {
    if (!imageGen) return;
    setImageGenBusy(true);
    const next = !imageGen.enabled;
    try {
      await api.put("/api/settings/image_gen_enabled", { value: next });
      setImageGen({ ...imageGen, enabled: next });
      toast.push("success", `AI image generation ${next ? "enabled" : "disabled"}`);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setImageGenBusy(false);
    }
  };

  if (loading) return <Spinner center />;

  return (
    <div>
      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
            <div class="flex items-center gap-sm">
              <span style={{ fontSize: "1.4rem" }}>📘</span>
              <strong>Facebook &amp; Instagram</strong>
            </div>
            <Badge tone={social?.connected ? "success" : "neutral"}>
              {social?.connected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Publish job completion posts and manage social content. Page tokens are configured via system
            settings (not in the browser).
          </p>
          <div class="kv" style={{ marginTop: "var(--space-sm)" }}>
            <div class="kv__row">
              <span class="kv__label">Page</span>
              <span class="kv__value">{social?.page_label ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Publish mode</span>
              <span class="kv__value">
                <Badge tone={social?.publish_mode === "live" ? "success" : "warning"}>
                  {social?.publish_mode === "live" ? "LIVE" : "SIMULATE"}
                </Badge>
              </span>
            </div>
          </div>
          <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)" }}>
            <Button size="sm" variant="secondary" disabled={socialTestBusy} onClick={() => void testSocial()}>
              Test Connection
            </Button>
            <Button size="sm" variant="tertiary" onClick={() => go("/social")}>
              View Posts
            </Button>
          </div>
        </div>
      </div>

      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
            <div class="flex items-center gap-sm">
              <span style={{ fontSize: "1.4rem" }}>🖼️</span>
              <strong>AI Image Generation (Imagen)</strong>
            </div>
            <Badge tone={imageGen?.credentials_present ? "success" : "neutral"}>
              {imageGen?.credentials_present ? "Connected" : "Not configured"}
            </Badge>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Generate lifestyle images for social media posts via Google Vertex AI.
          </p>
          <div class="flex items-center gap-sm">
            <label class="form-label" style={{ margin: 0 }}>
              Enabled
            </label>
            <input
              type="checkbox"
              checked={imageGen?.enabled ?? false}
              disabled={imageGenBusy || !imageGen}
              onChange={() => void toggleImageGen()}
            />
            {imageGenBusy && <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>Saving…</span>}
          </div>
        </div>
      </div>

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
