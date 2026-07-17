/**
 * "Manage Lists" settings tab — Tags and Referral Sources.
 * Both lists follow the same add/archive pattern (no renames in v1).
 */
import { useState, useEffect } from "preact/hooks";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import type { TagDefinition, ReferralSource, PunchListNamePreset } from "../../types";

type ListTab = "tags" | "referral_sources" | "punch_list_names";

// ─── Tags sub-panel ──────────────────────────────────────────────────────────

function TagsPanel() {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ tags: TagDefinition[] }>("/api/tags");
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const create = async () => {
    if (!newText.trim()) return;
    setBusy("create");
    try {
      await api.post("/api/tags", { tag_text: newText.trim() });
      setNewText("");
      setAdding(false);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleArchive = async (tag: TagDefinition) => {
    setBusy(tag.id);
    try {
      await api.put(`/api/tags/${tag.id}/archive`, {});
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner />;

  const tags = data?.tags ?? [];
  const active = tags.filter((t) => !t.archived);
  const archived = tags.filter((t) => t.archived);

  return (
    <div>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-md)" }}>
        Tags let you label clients for tracking referral partners, VIPs, and priority scheduling.
        Archived tags no longer appear for new assignments but remain visible on clients already tagged.
      </p>

      <div class="stack" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
        {active.length === 0 && (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No active tags yet.</p>
        )}
        {active.map((tag) => (
          <div key={tag.id} class="flex items-center justify-between gap-sm" style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
            <span style={{ fontWeight: 500 }}>{tag.tag_text}</span>
            <Button
              size="sm"
              variant="tertiary"
              disabled={busy === tag.id}
              onClick={() => void toggleArchive(tag)}
            >
              Archive
            </Button>
          </div>
        ))}
      </div>

      {adding ? (
        <div class="flex gap-xs items-end" style={{ marginBottom: "var(--space-md)" }}>
          <FormField label="New tag" style={{ flex: 1 }}>
            <input
              class="form-input"
              value={newText}
              placeholder="e.g. VIP / Repeat Client"
              onInput={(e) => setNewText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            />
          </FormField>
          <Button variant="primary" disabled={busy === "create" || !newText.trim()} onClick={() => void create()}>
            Add
          </Button>
          <Button variant="tertiary" onClick={() => { setAdding(false); setNewText(""); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)} style={{ marginBottom: "var(--space-md)" }}>
          + Add tag
        </Button>
      )}

      {archived.length > 0 && (
        <div>
          <p style={{ fontSize: "var(--text-sm)", fontWeight: 500, margin: "0 0 var(--space-xs)", color: "var(--color-text-muted)" }}>
            Archived
          </p>
          <div class="stack" style={{ gap: "var(--space-xs)" }}>
            {archived.map((tag) => (
              <div key={tag.id} class="flex items-center justify-between gap-sm" style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", opacity: 0.6 }}>
                <span>{tag.tag_text}</span>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy === tag.id}
                  onClick={() => void toggleArchive(tag)}
                >
                  Unarchive
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Referral Sources sub-panel ──────────────────────────────────────────────

function ReferralSourcesPanel() {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ referral_sources: ReferralSource[] }>("/api/referral-sources");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const create = async () => {
    if (!newLabel.trim()) return;
    setBusy("create");
    try {
      await api.post("/api/referral-sources", { label: newLabel.trim() });
      setNewLabel("");
      setAdding(false);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleArchive = async (source: ReferralSource) => {
    setBusy(source.id);
    try {
      await api.put(`/api/referral-sources/${source.id}/archive`, {});
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner />;

  const sources = data?.referral_sources ?? [];
  const active = sources.filter((s) => !s.archived);
  const archived = sources.filter((s) => s.archived);

  return (
    <div>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-md)" }}>
        Track where clients are coming from for ROI analysis. Each client can have one referral source.
        Archived sources no longer appear for new selections but remain on clients already assigned one.
      </p>

      <div class="stack" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
        {active.length === 0 && (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No active referral sources yet.</p>
        )}
        {active.map((s) => (
          <div key={s.id} class="flex items-center justify-between gap-sm" style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
            <span style={{ fontWeight: 500 }}>{s.label}</span>
            <Button
              size="sm"
              variant="tertiary"
              disabled={busy === s.id}
              onClick={() => void toggleArchive(s)}
            >
              Archive
            </Button>
          </div>
        ))}
      </div>

      {adding ? (
        <div class="flex gap-xs items-end" style={{ marginBottom: "var(--space-md)" }}>
          <FormField label="New source" style={{ flex: 1 }}>
            <input
              class="form-input"
              value={newLabel}
              placeholder="e.g. Google, Yard Sign"
              onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            />
          </FormField>
          <Button variant="primary" disabled={busy === "create" || !newLabel.trim()} onClick={() => void create()}>
            Add
          </Button>
          <Button variant="tertiary" onClick={() => { setAdding(false); setNewLabel(""); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)} style={{ marginBottom: "var(--space-md)" }}>
          + Add source
        </Button>
      )}

      {archived.length > 0 && (
        <div>
          <p style={{ fontSize: "var(--text-sm)", fontWeight: 500, margin: "0 0 var(--space-xs)", color: "var(--color-text-muted)" }}>
            Archived
          </p>
          <div class="stack" style={{ gap: "var(--space-xs)" }}>
            {archived.map((s) => (
              <div key={s.id} class="flex items-center justify-between gap-sm" style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", opacity: 0.6 }}>
                <span>{s.label}</span>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy === s.id}
                  onClick={() => void toggleArchive(s)}
                >
                  Unarchive
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Punch list name presets ─────────────────────────────────────────────────

function PunchListNamesPanel() {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ presets: PunchListNamePreset[] }>(
    "/api/punch-list-name-presets",
  );
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy("create");
    try {
      await api.post("/api/punch-list-name-presets", { name: newName.trim() });
      setNewName("");
      setAdding(false);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (preset: PunchListNamePreset) => {
    if (!confirm(`Remove "${preset.name}" from presets? Existing punch lists keep that name.`)) return;
    setBusy(preset.id);
    try {
      await api.del(`/api/punch-list-name-presets/${preset.id}`);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const presets = data?.presets ?? [];
    const target = index + direction;
    if (target < 0 || target >= presets.length) return;
    const ordered = [...presets];
    const [item] = ordered.splice(index, 1);
    ordered.splice(target, 0, item);
    setBusy("reorder");
    try {
      await api.put("/api/punch-list-name-presets/reorder", {
        ordered_ids: ordered.map((p) => p.id),
      });
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner />;

  const presets = data?.presets ?? [];

  return (
    <div>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-md)" }}>
        Preset names appear when creating a new punch list on a job. Removing a preset does not
        rename punch lists already using that name.
      </p>

      <div class="stack" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
        {presets.length === 0 && (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No presets yet.</p>
        )}
        {presets.map((preset, index) => (
          <div
            key={preset.id}
            class="flex items-center justify-between gap-sm"
            style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}
          >
            <span style={{ fontWeight: 500 }}>{preset.name}</span>
            <div class="flex gap-xs">
              <Button size="sm" variant="tertiary" disabled={busy != null || index === 0} onClick={() => void move(index, -1)}>
                ↑
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy != null || index === presets.length - 1}
                onClick={() => void move(index, 1)}
              >
                ↓
              </Button>
              <Button size="sm" variant="tertiary" disabled={busy === preset.id} onClick={() => void remove(preset)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div class="flex gap-xs items-end" style={{ marginBottom: "var(--space-md)" }}>
          <FormField label="New preset name" style={{ flex: 1 }}>
            <input
              class="form-input"
              value={newName}
              placeholder="e.g. Tile / Flooring"
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            />
          </FormField>
          <Button variant="primary" disabled={busy === "create" || !newName.trim()} onClick={() => void create()}>
            Add
          </Button>
          <Button variant="tertiary" onClick={() => { setAdding(false); setNewName(""); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          + Add preset
        </Button>
      )}
    </div>
  );
}

// ─── Exported tab ─────────────────────────────────────────────────────────────

export function ManageListsTab() {
  const [tab, setTab] = useUrlTab(
    ["tags", "referral_sources", "punch_list_names"] as const,
    "tags",
    "list",
  );

  return (
    <Card title="Manage Lists">
      <div class="tab-bar" style={{ marginBottom: "var(--space-lg)" }}>
        <button
          type="button"
          class={`tab-bar__tab${tab === "tags" ? " tab-bar__tab--active" : ""}`}
          onClick={() => setTab("tags")}
        >
          Tags
        </button>
        <button
          type="button"
          class={`tab-bar__tab${tab === "referral_sources" ? " tab-bar__tab--active" : ""}`}
          onClick={() => setTab("referral_sources")}
        >
          Referral Sources
        </button>
        <button
          type="button"
          class={`tab-bar__tab${tab === "punch_list_names" ? " tab-bar__tab--active" : ""}`}
          onClick={() => setTab("punch_list_names")}
        >
          Punch List Names
        </button>
      </div>

      {tab === "tags" ? (
        <TagsPanel />
      ) : tab === "referral_sources" ? (
        <ReferralSourcesPanel />
      ) : (
        <PunchListNamesPanel />
      )}
    </Card>
  );
}
