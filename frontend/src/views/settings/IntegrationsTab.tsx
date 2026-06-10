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
  google_calendar: { label: "Google Calendar", icon: "📆" },
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
  const [gcal, setGcal] = useState<{
    connected: boolean;
    status: string;
    last_sync: string | null;
    credentials_present: boolean;
    client_id_configured: boolean;
    client_secret_configured: boolean;
  } | null>(null);
  const [icalUrl, setIcalUrl] = useState<string | null>(null);
  const [gcalBusy, setGcalBusy] = useState(false);
  const [icalBusy, setIcalBusy] = useState(false);
  const [esig, setEsig] = useState<{
    mode: "sandbox" | "live";
    api_key_present: boolean;
    webhook_secret_present: boolean;
    webhook_url: string;
    setting_key: string;
  } | null>(null);
  const [esigModeBusy, setEsigModeBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        api.get<{ integrations: Connection[] }>("/api/integrations"),
        api.get<{ credentials_present: boolean; enabled: boolean }>("/api/integrations/image-gen/status"),
        api.get<{ connected: boolean; publish_mode: "live" | "simulate"; page_label: string }>(
          "/api/social/status",
        ),
        api.get<{ settings: Array<{ key: string; value: string; value_type: string }> }>("/api/settings"),
        api.get<{
          connected: boolean;
          status: string;
          last_sync: string | null;
          credentials_present: boolean;
          client_id_configured: boolean;
          client_secret_configured: boolean;
        }>("/api/google-calendar/status"),
        api.get<{ url: string }>("/api/calendar/ical/settings"),
        api.get<{
          mode: "sandbox" | "live";
          api_key_present: boolean;
          webhook_secret_present: boolean;
          webhook_url: string;
          setting_key: string;
        }>("/api/esignature/status"),
      ]);

      const pick = <T,>(i: number, fallback: T): T =>
        results[i]?.status === "fulfilled" ? (results[i] as PromiseFulfilledResult<T>).value : fallback;

      const integrations = pick(0, { integrations: [] as Connection[] });
      const status = pick(1, { credentials_present: false, enabled: false });
      const socialStatus = pick(2, { connected: false, publish_mode: "simulate" as const, page_label: "" });
      const settings = pick(3, { settings: [] as Array<{ key: string; value: string; value_type: string }> });
      const gcalStatus = pick(4, {
        connected: false,
        status: "disconnected",
        last_sync: null,
        credentials_present: false,
        client_id_configured: false,
        client_secret_configured: false,
      });
      const icalSettings = pick(5, { url: null as string | null });

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        toast.push("error", errMsg((failed[0] as PromiseRejectedResult).reason));
      }

      const esigStatus = pick(6, {
        mode: "sandbox" as const,
        api_key_present: false,
        webhook_secret_present: false,
        webhook_url: "https://dashboard.homesolutionsar.com/api/integrations/boldsign/webhook",
        setting_key: "esignature_mode",
      });

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
      setGcal(gcalStatus);
      setIcalUrl(icalSettings.url);
      setEsig(esigStatus);
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

  const connectGcal = async () => {
    setGcalBusy(true);
    try {
      const r = await api.post<{ authorize_url: string }>("/api/integrations/google-calendar/connect");
      window.open(r.authorize_url, "_blank", "noopener,noreferrer");
      toast.push("info", "Complete Google authorization in the new tab, then refresh this page.");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setGcalBusy(false);
    }
  };

  const syncGcal = async () => {
    setGcalBusy(true);
    try {
      const r = await api.post<{ ok: boolean; upserted?: number }>("/api/google-calendar/sync");
      toast.push("success", r.ok ? `Synced ${r.upserted ?? 0} Meet event(s)` : "Sync failed");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setGcalBusy(false);
    }
  };

  const copyIcal = async () => {
    if (!icalUrl) return;
    try {
      await navigator.clipboard.writeText(icalUrl);
      toast.push("success", "iCal URL copied");
    } catch {
      toast.push("error", "Could not copy — select and copy manually");
    }
  };

  const regenerateIcal = async () => {
    setIcalBusy(true);
    try {
      const r = await api.post<{ url: string }>("/api/calendar/ical/regenerate");
      setIcalUrl(r.url);
      toast.push("success", "New iCal URL generated — update Google Calendar subscription");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setIcalBusy(false);
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

      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
            <div class="flex items-center gap-sm">
              <span style={{ fontSize: "1.4rem" }}>📆</span>
              <strong>Google Calendar (Meet events)</strong>
            </div>
            <Badge tone={gcal?.connected ? "success" : "neutral"}>
              {gcal?.connected ? "Connected" : gcal?.credentials_present ? "Not connected" : "Not configured"}
            </Badge>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Read-only sync of Google Meet events into CHS. Uses the same Google OAuth Web client as dashboard
            sign-in.
          </p>
          {gcal && !gcal.credentials_present && (
            <div
              class="text--muted"
              style={{
                fontSize: "var(--text-sm)",
                marginBottom: "var(--space-sm)",
                padding: "var(--space-sm)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <strong style={{ color: "var(--color-text-primary)" }}>Setup required before Connect works:</strong>
              <ul style={{ margin: "var(--space-xs) 0 0", paddingLeft: "1.2rem" }}>
                <li>
                  Client ID ({gcal.client_id_configured ? "✓ set" : "✗ missing"}):{" "}
                  <code>DASHBOARD_OAUTH_CLIENT_ID</code> in wrangler.toml
                </li>
                <li>
                  Client secret ({gcal.client_secret_configured ? "✓ set" : "✗ missing or empty"}): run{" "}
                  <code>npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET</code> and paste the secret from Google
                  Cloud → Credentials → your Web client
                </li>
              </ul>
            </div>
          )}
          {gcal?.last_sync && (
            <p class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
              Last sync: {new Date(gcal.last_sync).toLocaleString()}
            </p>
          )}
          <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)" }}>
            {!gcal?.connected ? (
              <Button size="sm" variant="primary" disabled={gcalBusy || !gcal?.credentials_present} onClick={() => void connectGcal()}>
                Connect Google Calendar
              </Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" disabled={gcalBusy} onClick={() => void syncGcal()}>
                  Sync now
                </Button>
                <Button size="sm" variant="tertiary" disabled={busy === "google_calendar"} onClick={() => void disconnect("google_calendar")}>
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm">
            <span style={{ fontSize: "1.4rem" }}>🔗</span>
            <strong>iCal feed (CHS → Google Calendar)</strong>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Paste this URL into Google Calendar → Other calendars → From URL. Includes scheduled jobs, warranty
            calls, and estimate visits.
          </p>
          {icalUrl && (
            <input class="input" readOnly value={icalUrl} style={{ fontSize: "var(--text-xs)", marginBottom: "var(--space-sm)" }} />
          )}
          <div class="flex gap-sm">
            <Button size="sm" variant="secondary" disabled={!icalUrl} onClick={() => void copyIcal()}>
              Copy URL
            </Button>
            <Button size="sm" variant="tertiary" disabled={icalBusy} onClick={() => void regenerateIcal()}>
              Regenerate token
            </Button>
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

      {/* ── BoldSign / E-Signature (Sprint 21) ─────────────────────────── */}
      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
            <div class="flex items-center gap-sm">
              <span style={{ fontSize: "1.4rem" }}>✍️</span>
              <strong>BoldSign / E-Signature</strong>
            </div>
            <div class="flex gap-sm items-center">
              <Badge tone={esig?.api_key_present ? "success" : "neutral"}>
                {esig?.api_key_present ? "API key configured" : "Not configured"}
              </Badge>
              {esig && (
                <Badge tone={esig.mode === "live" ? "success" : "warning"}>
                  {esig.mode === "live" ? "LIVE" : "SANDBOX"}
                </Badge>
              )}
            </div>
          </div>

          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Send approved generated documents (service agreements, change orders, lien waivers, etc.) for e-signature via BoldSign. Clients sign in their browser — no account required.
          </p>

          {esig?.mode === "sandbox" && (
            <div style={{
              background: "var(--color-warning-light, #fff3cd)",
              border: "2px solid var(--color-warning, #f59e0b)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-sm) var(--space-md)",
              marginBottom: "var(--space-sm)",
              fontWeight: 600,
              color: "var(--color-warning-dark, #92400e)",
              fontSize: "var(--text-sm)",
            }}>
              ⚠️ SANDBOX MODE — signature requests are non-binding watermarked test documents. Flip to LIVE only when ready.
            </div>
          )}

          <div class="kv" style={{ marginTop: "var(--space-sm)" }}>
            <div class="kv__row">
              <span class="kv__label">Mode</span>
              <span class="kv__value">{esig?.mode ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">API Key</span>
              <span class="kv__value">{esig?.api_key_present ? "Configured (wrangler secret)" : "Not set — run: wrangler secret put BOLDSIGN_API_KEY"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Webhook Secret</span>
              <span class="kv__value">{esig?.webhook_secret_present ? "Configured" : "Not set — run: wrangler secret put BOLDSIGN_WEBHOOK_SECRET"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Webhook URL</span>
              <span class="kv__value" style={{ fontSize: "var(--text-xs)", fontFamily: "monospace", wordBreak: "break-all" }}>
                {esig?.webhook_url ?? "https://dashboard.homesolutionsar.com/api/integrations/boldsign/webhook"}
              </span>
            </div>
          </div>

          <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
            <Button
              size="sm"
              variant="tertiary"
              onClick={() => {
                const url = esig?.webhook_url ?? "https://dashboard.homesolutionsar.com/api/integrations/boldsign/webhook";
                navigator.clipboard?.writeText(url).then(() => toast.push("success", "Webhook URL copied")).catch(() => undefined);
              }}
            >
              Copy Webhook URL
            </Button>
            {esig?.mode === "sandbox" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={esigModeBusy}
                onClick={async () => {
                  if (!confirm("CAUTION: Switching to LIVE mode will send real, legally-binding signature requests. Are you sure you want to proceed?")) return;
                  setEsigModeBusy(true);
                  try {
                    await api.put(`/api/settings/${esig.setting_key}`, { value: "live" });
                    setEsig((e) => e ? { ...e, mode: "live" } : e);
                    toast.push("success", "E-signature mode set to LIVE. All new requests are legally binding.");
                  } catch (e) {
                    toast.push("error", errMsg(e));
                  } finally {
                    setEsigModeBusy(false);
                  }
                }}
              >
                {esigModeBusy ? "Saving…" : "Switch to LIVE ⚠️"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="tertiary"
                disabled={esigModeBusy}
                onClick={async () => {
                  setEsigModeBusy(true);
                  try {
                    await api.put(`/api/settings/${esig!.setting_key}`, { value: "sandbox" });
                    setEsig((e) => e ? { ...e, mode: "sandbox" } : e);
                    toast.push("success", "E-signature mode set to SANDBOX.");
                  } catch (e) {
                    toast.push("error", errMsg(e));
                  } finally {
                    setEsigModeBusy(false);
                  }
                }}
              >
                {esigModeBusy ? "Saving…" : "Switch to Sandbox"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
