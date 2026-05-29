import type { RoutableProps } from "preact-router";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { useAuth } from "../../store/auth";

interface SettingShape {
  key: string;
  label: string;
  category: string;
  value: string;
  value_type: string;
  description: string | null;
}

interface SettingsResponse {
  settings: SettingShape[];
}

export function Settings(_props: RoutableProps) {
  const { user } = useAuth();
  const { data, loading, error } = useApi<SettingsResponse>("/api/settings");

  const grouped: Record<string, SettingShape[]> = {};
  for (const s of data?.settings ?? []) {
    (grouped[s.category] ??= []).push(s);
  }

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Settings</h1>
          <p class="view-subtitle">
            System settings (read-only here). Editing is owner-only via the settings API.
          </p>
        </div>
      </div>

      <Card title="Signed in as">
        <div class="kv">
          <div class="kv__row">
            <span class="kv__label">Email</span>
            <span class="kv__value">{user?.email ?? "not signed in"}</span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Role</span>
            <span class="kv__value">{user?.role ?? "—"}</span>
          </div>
        </div>
      </Card>

      <div class="mt-lg" />

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load settings: {error}</div>}

      {!loading &&
        !error &&
        Object.entries(grouped).map(([category, items]) => (
          <div key={category} class="mb-lg">
            <Card title={category.charAt(0).toUpperCase() + category.slice(1)}>
              <div class="kv">
                {items.map((s) => (
                  <div key={s.key} class="kv__row">
                    <span class="kv__label" title={s.description ?? undefined}>
                      {s.label}
                    </span>
                    <span class="kv__value text--mono">{s.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ))}
    </div>
  );
}
