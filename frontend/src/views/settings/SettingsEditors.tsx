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

// ─── Quote Follow-Ups Tab (Sprint 26) ─────────────────────────────────────────

const FOLLOW_UP_TOUCHES = [
  { day: 3,  smsKey: "follow_up_day3_sms",  emailKey: "follow_up_day3_email"  },
  { day: 5,  smsKey: "follow_up_day5_sms",  emailKey: "follow_up_day5_email"  },
  { day: 7,  smsKey: "follow_up_day7_sms",  emailKey: "follow_up_day7_email"  },
  { day: 10, smsKey: "follow_up_day10_sms", emailKey: "follow_up_day10_email" },
] as const;

const MERGE_TAGS = [
  "{{client_first_name}}",
  "{{job_type}}",
  "{{property_address}}",
  "{{expiration_date}}",
  "{{estimate_link}}",
];

interface EmailTemplate { subject: string; body: string; }

function TouchPanel({
  day,
  smsKey,
  emailKey,
  smsValue,
  emailValue,
  onSaved,
}: {
  day: number;
  smsKey: string;
  emailKey: string;
  smsValue: string;
  emailValue: string;
  onSaved: () => void;
}) {
  const toast = useToast();

  const parseEmail = (val: string): EmailTemplate => {
    try { return JSON.parse(val) as EmailTemplate; }
    catch { return { subject: "", body: val }; }
  };

  const [sms, setSms] = useState(smsValue);
  const [emailSubject, setEmailSubject] = useState(parseEmail(emailValue).subject);
  const [emailBody, setEmailBody] = useState(parseEmail(emailValue).body);
  const [saving, setSaving] = useState(false);
  const [showMergeTags, setShowMergeTags] = useState(false);

  useEffect(() => {
    setSms(smsValue);
    const e = parseEmail(emailValue);
    setEmailSubject(e.subject);
    setEmailBody(e.body);
  }, [smsValue, emailValue]);

  const save = async () => {
    setSaving(true);
    try {
      await Promise.all([
        api.put(`/api/settings/${encodeURIComponent(smsKey)}`, { value: sms }),
        api.put(`/api/settings/${encodeURIComponent(emailKey)}`, {
          value: JSON.stringify({ subject: emailSubject, body: emailBody }),
        }),
      ]);
      toast.push("success", `Day ${day} templates saved.`);
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const smsLen = sms.length;

  return (
    <div class="card" style={{ marginBottom: "var(--space-lg)" }}>
      <div class="card__header">
        <span class="card__title">Day {day} Follow-Up</span>
        <span class="badge badge--info" style={{ fontSize: "var(--text-xs)" }}>SMS + Email</span>
      </div>
      <div class="card__body">
        <div class="form-group">
          <label class="form-label">SMS Message</label>
          <div style={{ position: "relative" }}>
            <textarea
              class="form-textarea"
              rows={3}
              value={sms}
              onInput={(e) => setSms((e.target as HTMLTextAreaElement).value)}
            />
            <span
              class="form-hint"
              style={{
                position: "absolute",
                bottom: "var(--space-xs)",
                right: "var(--space-sm)",
                fontSize: "var(--text-xs)",
                color: smsLen > 160 ? "var(--color-warning)" : "var(--color-text-muted)",
              }}
            >
              {smsLen}/160
            </span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Email Subject</label>
          <input
            class="form-input"
            type="text"
            value={emailSubject}
            onInput={(e) => setEmailSubject((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="form-group">
          <label class="form-label">Email Body</label>
          <textarea
            class="form-textarea"
            rows={6}
            value={emailBody}
            onInput={(e) => setEmailBody((e.target as HTMLTextAreaElement).value)}
          />
        </div>

        <div class="form-group" style={{ marginBottom: "var(--space-sm)" }}>
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => setShowMergeTags(!showMergeTags)}
            type="button"
          >
            {showMergeTags ? "▲" : "▼"} Merge Tags
          </button>
          {showMergeTags && (
            <div
              style={{
                marginTop: "var(--space-sm)",
                padding: "var(--space-sm)",
                background: "var(--color-surface-0)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-xs)",
              }}
            >
              {MERGE_TAGS.map((tag) => (
                <code
                  key={tag}
                  style={{
                    fontSize: "var(--text-xs)",
                    fontFamily: "var(--font-mono)",
                    padding: "2px var(--space-xs)",
                    background: "var(--color-surface-2)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--color-brand)",
                  }}
                >
                  {tag}
                </code>
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="card__footer" style={{ justifyContent: "flex-end" }}>
        <Button variant="primary" size="sm" disabled={saving} onClick={save}>
          {saving ? "Saving…" : `Save Day ${day} Templates`}
        </Button>
      </div>
    </div>
  );
}

export function QuoteFollowUpsTab() {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ settings: SettingShape[] }>("/api/settings/category/notifications");
      const map: Record<string, string> = {};
      for (const s of r.settings) {
        map[s.key] = s.value;
      }
      setDrafts(map);
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

  return (
    <div>
      <Card title="Quote Follow-Ups">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-lg)" }}>
          After an estimate is sent, the system automatically sends SMS and email follow-ups on Days 3, 5, 7, and 10 if
          the client hasn&apos;t responded. Edit the message templates below. Changes are saved immediately and
          audit-logged.
        </p>
        {FOLLOW_UP_TOUCHES.map(({ day, smsKey, emailKey }) => (
          <TouchPanel
            key={day}
            day={day}
            smsKey={smsKey}
            emailKey={emailKey}
            smsValue={drafts[smsKey] ?? ""}
            emailValue={drafts[emailKey] ?? ""}
            onSaved={load}
          />
        ))}
      </Card>
    </div>
  );
}
