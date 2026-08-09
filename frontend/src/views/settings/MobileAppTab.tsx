import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";

const LAYOUT_KEY = "visit_capture_layout";

type LayoutValue = "redesigned" | "legacy";

/**
 * Owner Settings → Mobile App — layout toggles that apply without redeploy.
 */
export function MobileAppTab() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<LayoutValue>("redesigned");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get<{ setting: { value: string } }>(
          `/api/settings/${encodeURIComponent(LAYOUT_KEY)}`,
        );
        if (cancelled) return;
        const v = (res.setting?.value ?? "redesigned").toLowerCase();
        setLayout(v === "legacy" ? "legacy" : "redesigned");
      } catch {
        if (!cancelled) setLayout("redesigned");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLayoutValue = async (next: LayoutValue) => {
    if (busy || next === layout) return;
    setBusy(true);
    const prev = layout;
    setLayout(next);
    try {
      await api.put(`/api/settings/${encodeURIComponent(LAYOUT_KEY)}`, { value: next });
      toast.push(
        "success",
        next === "redesigned"
          ? "Visit Capture redesign on (phone/tablet)"
          : "Visit Capture legacy layout restored",
      );
    } catch (err) {
      setLayout(prev);
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner center />;

  return (
    <Card title="Mobile App">
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
        These options apply on phone and tablet immediately — no app rebuild or deploy needed.
        Desktop Estimate Request layout is unchanged.
      </p>

      <div
        style={{
          marginTop: "var(--space-md)",
          paddingTop: "var(--space-md)",
          borderTop: "1px solid var(--color-border)",
        }}
      >
        <strong>Visit Capture layout</strong>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-xs) 0 var(--space-sm)" }}>
          On Estimate Request detail: hero Record / Draw / Photos tiles with a dedicated Record
          panel, or the original stacked card layout.
        </p>
        <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
          <label class="flex items-center gap-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
            <input
              type="radio"
              name="visit_capture_layout"
              checked={layout === "redesigned"}
              disabled={busy}
              onChange={() => void setLayoutValue("redesigned")}
            />
            <span>Redesigned (recommended)</span>
          </label>
          <label class="flex items-center gap-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
            <input
              type="radio"
              name="visit_capture_layout"
              checked={layout === "legacy"}
              disabled={busy}
              onChange={() => void setLayoutValue("legacy")}
            />
            <span>Legacy</span>
          </label>
        </div>
      </div>
    </Card>
  );
}
