import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { go } from "../../lib/nav";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

interface SettingShape {
  key: string;
  label: string;
  category: string;
  value: string;
  value_type: string;
  description: string | null;
}

/**
 * Generic category editor over /api/settings. Each field PUTs to
 * /api/settings/:key, which audit-logs old→new (business rule 4). The owner is
 * the only role that reaches this (RBAC gate + UI gate).
 */
function CategoryEditor({ category, blurb }: { category: string; blurb: string }) {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingShape[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ settings: SettingShape[] }>("/api/settings");
      const items = r.settings.filter((s) => s.category === category);
      setSettings(items);
      setDrafts(Object.fromEntries(items.map((s) => [s.key, s.value])));
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [category]);

  const save = async (s: SettingShape) => {
    setSavingKey(s.key);
    try {
      let value: unknown = drafts[s.key];
      if (s.value_type === "number") value = Number(drafts[s.key]);
      else if (s.value_type === "boolean") value = drafts[s.key] === "true";
      await api.put(`/api/settings/${encodeURIComponent(s.key)}`, { value });
      toast.push("success", `${s.label} saved`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return <Spinner center />;

  return (
    <Card title={category.charAt(0).toUpperCase() + category.slice(1)}>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>{blurb}</p>
      {settings.length === 0 ? (
        <div class="empty-state">No {category} settings found.</div>
      ) : (
        settings.map((s) => (
          <div key={s.key} class="form-group">
            <label class="form-label" title={s.description ?? undefined}>
              {s.label} <span class="text--muted text--mono" style={{ fontSize: "var(--text-xs)" }}>({s.key})</span>
            </label>
            <div class="flex gap-sm items-center">
              {s.value_type === "boolean" ? (
                <select
                  class="form-select"
                  value={drafts[s.key]}
                  onChange={(e) => setDrafts({ ...drafts, [s.key]: (e.target as HTMLSelectElement).value })}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              ) : (
                <input
                  class="form-input"
                  type={s.value_type === "number" ? "number" : "text"}
                  value={drafts[s.key]}
                  onInput={(e) => setDrafts({ ...drafts, [s.key]: (e.target as HTMLInputElement).value })}
                />
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={savingKey === s.key || drafts[s.key] === s.value}
                onClick={() => save(s)}
              >
                Save
              </Button>
            </div>
            {s.description && <div class="form-hint">{s.description}</div>}
          </div>
        ))
      )}
    </Card>
  );
}

export function CompanyTab() {
  return (
    <CategoryEditor
      category="company"
      blurb="Company identity and branding. Logo and brand color feed client-facing pages (quotes, portal, completion packages)."
    />
  );
}

export function FinancialSettingsTab() {
  return (
    <CategoryEditor
      category="financial"
      blurb="Labor rates, fee percentages, late-fee + convenience-fee settings, default deposit, IRS mileage rate, quote validity. Every change is audit-logged old→new."
    />
  );
}

export function NotificationsTab() {
  return (
    <div>
      <Card
        title="Notification Templates"
        actions={
          <div class="flex gap-sm">
            <Button size="sm" variant="secondary" onClick={() => go("/settings/notifications/logs")}>
              Delivery Log
            </Button>
            <Button size="sm" variant="primary" onClick={() => go("/settings/notifications")}>
              Manage Templates
            </Button>
          </div>
        }
      >
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          Edit the automated emails and texts clients receive, toggle templates active/inactive, and review the
          delivery log. Notifications stay in <strong>SIMULATE</strong> mode this sprint.
        </p>
      </Card>
      <div class="mt-lg" />
      <Card title="Per-user preferences">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          Per-channel preferences (email / SMS / push / in-app) are edited per user from the{" "}
          <strong>Users</strong> tab → <em>Notifications</em>. The completion-package template is keyed{" "}
          <code>completion_package_sent</code> (Sprint 17 naming reconcile).
        </p>
      </Card>
    </div>
  );
}
