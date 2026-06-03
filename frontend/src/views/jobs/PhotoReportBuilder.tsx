import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { api, ApiError } from "../../api";
import type { useToast } from "../../store/toast";
import type { PhotoItem } from "./PhotosTab";

/**
 * Photo report builder (Sprint 18, deliverable C; §4.5). Select photos (manual
 * grid pick), toggle options (GPS / captions), generate. Owner/PM only — the
 * server enforces the O/PM gate. After generation, offers preview + share.
 */
export function PhotoReportBuilder({
  jobId,
  photos,
  onClose,
  toast,
}: {
  jobId: string;
  photos: PhotoItem[];
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const usable = photos.filter((p) => p.photo_type !== "receipt");
  const [selected, setSelected] = useState<Set<string>>(new Set(usable.map((p) => p.id)));
  const [includeGps, setIncludeGps] = useState(true);
  const [includeCaptions, setIncludeCaptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ document_id: string; preview_url: string } | null>(null);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const generate = async () => {
    if (selected.size === 0) {
      toast.push("error", "Select at least one photo");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ document_id: string; preview_url: string }>(
        `/api/jobs/${jobId}/photo-report`,
        { photo_ids: [...selected], include_gps: includeGps, include_captions: includeCaptions },
      );
      setResult(r);
      toast.push("success", "Photo report generated");
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!result) return;
    try {
      const r = await api.post<{ share_url: string }>(`/api/documents/${result.document_id}/share`, {});
      await navigator.clipboard?.writeText(r.share_url).catch(() => undefined);
      toast.push("success", "Share link copied to clipboard");
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Build photo report"
      footer={
        <div class="flex items-center justify-between" style={{ width: "100%" }}>
          <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>{selected.size} selected</span>
          <div class="flex gap-sm">
            {result ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => window.open(result.preview_url, "_blank")}>Preview / Save as PDF</Button>
                <Button variant="primary" size="sm" onClick={share}>Copy share link</Button>
              </>
            ) : (
              <Button variant="primary" size="sm" disabled={busy} onClick={generate}>{busy ? "Generating…" : "Generate"}</Button>
            )}
          </div>
        </div>
      }
    >
      {result ? (
        <div class="empty-state">
          <div class="empty-state__icon">📄</div>
          <div class="empty-state__title">Report ready</div>
          <div>Open the preview and use your browser's “Save as PDF”, or copy a share link for the client.</div>
        </div>
      ) : (
        <div class="stack">
          <div class="flex gap-md" style={{ flexWrap: "wrap" }}>
            <label class="flex items-center gap-sm" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={includeCaptions} onChange={(e) => setIncludeCaptions((e.target as HTMLInputElement).checked)} />
              Captions
            </label>
            <label class="flex items-center gap-sm" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={includeGps} onChange={(e) => setIncludeGps((e.target as HTMLInputElement).checked)} />
              GPS location
            </label>
            <div class="flex gap-sm" style={{ marginLeft: "auto" }}>
              <Button variant="tertiary" size="sm" onClick={() => setSelected(new Set(usable.map((p) => p.id)))}>All</Button>
              <Button variant="tertiary" size="sm" onClick={() => setSelected(new Set())}>None</Button>
            </div>
          </div>
          <div class="photo-grid">
            {usable.map((p) => (
              <button
                key={p.id}
                class={`photo-thumb${selected.has(p.id) ? " photo-thumb--picked" : ""}`}
                onClick={() => toggle(p.id)}
              >
                <img src={p.thumb_url} alt={p.caption ?? p.photo_type} loading="lazy" />
                {selected.has(p.id) && <span class="photo-thumb__check">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
