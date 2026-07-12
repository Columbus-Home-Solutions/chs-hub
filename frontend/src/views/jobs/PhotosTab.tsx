import { useMemo, useRef, useState, useEffect } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { useAuth } from "../../store/auth";
import { can } from "../../lib/rbac";
import { api, ApiError } from "../../api";
import { formatDateTime } from "../../lib/format";
import { uploadPhoto } from "../../lib/capture";
import { renderAnnotatedImageSvg, type AnnotationData } from "../../lib/annotation";
import { PhotoAnnotator } from "./PhotoAnnotator";
import { BeforeAfterSlider } from "./BeforeAfterSlider";
import { PhotoReportBuilder } from "./PhotoReportBuilder";
import {
  ExpenseFields,
  emptyDraft,
  draftToBody,
  type ExpenseDraft,
  type CostingLineLite,
} from "../financial/ExpenseForm";
import { ReceiptMatchReview } from "../financial/ReceiptMatchReview";

export interface PhotoReceipt {
  id: string;
  processing_status: string;
  ai_vendor: string | null;
  ai_amount: number | null;
  ai_date: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
  expense_id: string | null;
  extracted_items: string | null;
}

interface ExtractedItem {
  id?: string;
  description: string;
  amount: number;
  quantity?: number;
  unit_price?: number;
}

function parseExtractedItems(raw: string | null): ExtractedItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ExtractedItem[];
  } catch {
    return [];
  }
}
export interface PhotoItem {
  id: string;
  taken_at: string | null;
  job_id: string | null;
  photo_type: string;
  caption: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  uploaded_by: string | null;
  synced_from_offline: boolean;
  task_id: string | null;
  daily_log_id: string | null;
  is_annotated: boolean;
  is_social_ready: boolean;
  annotation_data: string | null;
  before_after_pair_id: string | null;
  thumb_url: string;
  original_url: string;
  receipt: PhotoReceipt | null;
}

const PHOTO_TYPE_OPTIONS = [
  { value: "job_progress", label: "Progress" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "receipt", label: "Receipt" },
  { value: "punch_list", label: "Punch List" },
  { value: "issue", label: "Issue" },
];
const FILTER_OPTIONS = [
  { value: "", label: "All types" },
  { value: "before_after", label: "Before/After" },
  ...PHOTO_TYPE_OPTIONS,
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  PHOTO_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

function dayKey(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Undated";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function PhotosTab({ jobId }: { jobId: string }) {
  const toast = useToast();
  const { user } = useAuth();
  const canReport = can(user, "manage_jobs"); // O/PM — photo report + project packet
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [packetBusy, setPacketBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Bulk-select state.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [optimisticTypes, setOptimisticTypes] = useState<Record<string, string>>({});

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (visiblePhotos: PhotoItem[]) => {
    setSelectedIds(new Set(visiblePhotos.map((p) => p.id)));
  };

  const bulkSetSocialReady = async (value: 1 | 0) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.put(`/api/photos/${id}`, { is_social_ready: value }),
        ),
      );
      toast.push("success", `${selectedIds.size} photo${selectedIds.size !== 1 ? "s" : ""} updated`);
      exitSelectMode();
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const qs = new URLSearchParams();
  if (type && type !== "before_after") qs.set("type", type);
  if (from) qs.set("from", from);
  if (to) qs.set("to", `${to}T23:59:59Z`);
  const url = `/api/jobs/${jobId}/photos${qs.toString() ? `?${qs}` : ""}`;
  const { data, loading, error, refetch } = useApi<{ photos: PhotoItem[]; total: number }>(url);

  const photosRaw = data?.photos ?? [];
  const photos = useMemo(() => {
    let list = photosRaw.map((p) => ({
      ...p,
      photo_type: optimisticTypes[p.id] ?? p.photo_type,
    }));
    if (type === "before_after") {
      list = list.filter((p) => p.photo_type === "before" || p.photo_type === "after");
    }
    return list;
  }, [photosRaw, optimisticTypes, type]);

  const updatePhotoTag = async (
    photo: PhotoItem,
    tag: "before" | "after" | "job_progress" | "remove",
  ) => {
    const body =
      tag === "before"
        ? { photo_type: "before", is_before_photo: 1, is_after_photo: 0 }
        : tag === "after"
          ? { photo_type: "after", is_before_photo: 0, is_after_photo: 1 }
          : tag === "job_progress"
            ? { photo_type: "job_progress", is_before_photo: 0, is_after_photo: 0 }
            : { photo_type: "general", is_before_photo: 0, is_after_photo: 0 };

    const prevType = photo.photo_type;
    setOptimisticTypes((o) => ({ ...o, [photo.id]: body.photo_type }));
    try {
      await api.put(`/api/photos/${photo.id}`, body);
      refetch();
      setOptimisticTypes((o) => {
        const next = { ...o };
        delete next[photo.id];
        return next;
      });
    } catch (err) {
      setOptimisticTypes((o) => ({ ...o, [photo.id]: prevType }));
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, PhotoItem[]>();
    for (const p of photos) {
      const k = dayKey(p.taken_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return Array.from(m.entries());
  }, [photos]);

  const generatePacket = async () => {
    setPacketBusy(true);
    try {
      const r = await api.post<{ preview_url: string }>(`/api/jobs/${jobId}/project-packet`, {});
      toast.push("success", "Project packet generated");
      window.open(r.preview_url, "_blank");
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPacketBusy(false);
    }
  };

  const onPick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        await uploadPhoto(f, { job_id: jobId, photo_type: type || "job_progress" }, { withGps: true });
      }
      toast.push("success", `${files.length} photo${files.length > 1 ? "s" : ""} uploaded`);
      refetch();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div class="stack" style={{ position: "relative" }}>
      <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <Select
            value={type}
            placeholder="All types"
            options={FILTER_OPTIONS}
            onChange={setType}
          />
          <input class="form-input" type="date" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} aria-label="From date" />
          <input class="form-input" type="date" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} aria-label="To date" />
          {(type || from || to) && (
            <Button variant="tertiary" size="sm" onClick={() => { setType(""); setFrom(""); setTo(""); }}>
              Clear
            </Button>
          )}
        </div>
        <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
          {canReport && !selectMode && (
            <>
              <Button variant="secondary" size="sm" disabled={photos.length === 0} onClick={() => setShowReport(true)}>
                📄 Photo Report
              </Button>
              <Button variant="secondary" size="sm" disabled={packetBusy || photos.length === 0} onClick={generatePacket}>
                {packetBusy ? "Building…" : "🎁 Project Packet"}
              </Button>
            </>
          )}
          {photos.length > 0 && (
            <Button
              variant={selectMode ? "primary" : "secondary"}
              size="sm"
              onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            >
              {selectMode ? "✕ Cancel Select" : "☑ Select"}
            </Button>
          )}
          {!selectMode && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                style={{ display: "none" }}
                onChange={onPick}
              />
              <Button variant="primary" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? "Uploading…" : "📷 Add Photo"}
              </Button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div class="empty-state"><div class="empty-state__title">Couldn't load photos</div><div>{error}</div></div>
      ) : photos.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📸</div>
          <div class="empty-state__title">No photos yet</div>
          <div>Capture progress, before/after, receipts and punch-list photos for this job.</div>
        </div>
      ) : (
        groups.map(([day, items]) => (
          <div key={day} class="photo-day">
            <div class="photo-day__header">{day} · {items.length}</div>
            <div class="photo-grid">
              {items.map((p) => {
                const idx = photos.indexOf(p);
                const selected = selectedIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    class={`photo-thumb${selected ? " photo-thumb--selected" : ""}`}
                    style={selected ? { outline: "2px solid var(--color-primary, var(--color-brand))" } : undefined}
                    onClick={() => {
                      if (selectMode) {
                        toggleSelect(p.id);
                      } else {
                        setOpenIdx(idx);
                      }
                    }}
                  >
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={selected}
                        tabIndex={-1}
                        class="photo-thumb__checkbox"
                        style={{
                          position: "absolute",
                          top: "4px",
                          left: "4px",
                          zIndex: 2,
                          pointerEvents: "none",
                        }}
                        readOnly
                      />
                    )}
                    <img src={p.thumb_url} alt={p.caption ?? p.photo_type} loading="lazy" />
                    {p.photo_type !== "receipt" && !selectMode && (
                      <PhotoTagBadge
                        photoType={p.photo_type}
                        onSelect={(tag) => void updatePhotoTag(p, tag)}
                      />
                    )}
                    {p.photo_type === "receipt" && (
                      <span class="photo-thumb__type">{TYPE_LABEL[p.photo_type] ?? p.photo_type}</span>
                    )}
                    {p.receipt && <span class="photo-thumb__badge">💵</span>}
                    {(p.is_annotated || !!p.annotation_data) && <span class="photo-thumb__badge photo-thumb__badge--annot">✏️</span>}
                    {p.before_after_pair_id && <span class="photo-thumb__badge photo-thumb__badge--pair">↔️</span>}
                    {p.is_social_ready && (
                      <span
                        class="photo-thumb__badge photo-thumb__badge--social"
                        style={{
                          position: "absolute",
                          bottom: "4px",
                          right: "4px",
                          background: "var(--color-warning)",
                          borderRadius: "50%",
                          width: "18px",
                          height: "18px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "11px",
                          lineHeight: 1,
                          zIndex: 2,
                        }}
                        title="Social-ready"
                      >
                        ★
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}

      {/* Bulk-select action bar */}
      {selectMode && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 200,
            background: "var(--color-surface-elevated, var(--color-surface-2))",
            borderTop: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-lg, 0 -4px 16px rgba(0,0,0,0.4))",
            padding: "var(--space-sm) var(--space-md)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-sm)",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, minWidth: "80px" }}>
            {selectedIds.size} selected
          </span>
          <Button variant="tertiary" size="sm" onClick={() => selectAll(photos)}>
            Select All
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={bulkBusy || selectedIds.size === 0}
            onClick={() => void bulkSetSocialReady(1)}
          >
            ★ Mark Social-Ready
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={bulkBusy || selectedIds.size === 0}
            onClick={() => void bulkSetSocialReady(0)}
          >
            ✕ Unmark Social-Ready
          </Button>
          <Button variant="tertiary" size="sm" onClick={exitSelectMode}>
            Cancel
          </Button>
        </div>
      )}

      {!selectMode && openIdx != null && photos[openIdx] && (
        <PhotoDetailModal
          photos={photos}
          index={openIdx}
          onIndex={setOpenIdx}
          onClose={() => setOpenIdx(null)}
          onChanged={refetch}
          toast={toast}
        />
      )}

      {showReport && (
        <PhotoReportBuilder jobId={jobId} photos={photos} onClose={() => setShowReport(false)} toast={toast} />
      )}
    </div>
  );
}

type PhotoTagChoice = "before" | "after" | "job_progress" | "remove";

function photoTagLabel(type: string): { label: string; className: string } {
  if (type === "before") return { label: "Before", className: "photo-tag photo-tag--before" };
  if (type === "after") return { label: "After", className: "photo-tag photo-tag--after" };
  if (type === "job_progress") return { label: "Progress", className: "photo-tag photo-tag--progress" };
  return { label: "+ Tag", className: "photo-tag photo-tag--untagged" };
}

function PhotoTagBadge({
  photoType,
  onSelect,
}: {
  photoType: string;
  onSelect: (tag: PhotoTagChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tagged = photoType === "before" || photoType === "after" || photoType === "job_progress";
  const display = photoTagLabel(tagged ? photoType : "general");

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div class="photo-tag-wrap" ref={wrapRef}>
      <button
        type="button"
        class={display.className}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {display.label}
      </button>
      {open && (
        <div class="photo-tag-popover" role="menu">
          <button type="button" class="photo-tag-popover__item" onClick={(e) => { e.stopPropagation(); onSelect("before"); setOpen(false); }}>
            Before
          </button>
          <button type="button" class="photo-tag-popover__item" onClick={(e) => { e.stopPropagation(); onSelect("after"); setOpen(false); }}>
            After
          </button>
          <button type="button" class="photo-tag-popover__item" onClick={(e) => { e.stopPropagation(); onSelect("job_progress"); setOpen(false); }}>
            Progress
          </button>
          {tagged && (
            <button type="button" class="photo-tag-popover__item photo-tag-popover__item--muted" onClick={(e) => { e.stopPropagation(); onSelect("remove"); setOpen(false); }}>
              Remove tag
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PhotoDetailModal({
  photos,
  index,
  onIndex,
  onClose,
  onChanged,
  toast,
}: {
  photos: PhotoItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const p = photos[index];
  const [caption, setCaption] = useState(p.caption ?? "");
  const [ptype, setPtype] = useState(p.photo_type);
  const [busy, setBusy] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [showAnnotated, setShowAnnotated] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const prev = () => { setZoomed(false); if (index > 0) onIndex(index - 1); };
  const next = () => { setZoomed(false); if (index < photos.length - 1) onIndex(index + 1); };

  // The paired "before" photo, if this one is an "after" in a pair.
  const pairedBefore = p.before_after_pair_id
    ? photos.find((x) => x.id === p.before_after_pair_id) ?? null
    : null;
  // The paired "after" photo, if this one is a "before" in someone else's pair.
  const pairedAfter = !pairedBefore
    ? photos.find((x) => x.before_after_pair_id === p.id) ?? null
    : null;

  const annotatedSvg = (() => {
    if (!p.is_annotated || !p.annotation_data) return null;
    try {
      const data = JSON.parse(p.annotation_data) as AnnotationData;
      if (!data?.shapes?.length) return null;
      return renderAnnotatedImageSvg(p.original_url, data);
    } catch {
      return null;
    }
  })();

  const pairWith = async (beforeId: string) => {
    setBusy(true);
    try {
      await api.post(`/api/photos/pair`, { before_id: beforeId, after_id: p.id });
      toast.push("success", "Before/after pair created");
      setPairing(false);
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    setBusy(true);
    try {
      await api.post(`/api/photos/unpair`, { after_id: p.id });
      toast.push("success", "Pair removed");
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = async () => {
    setBusy(true);
    try {
      await api.put(`/api/photos/${p.id}`, { caption: caption.trim() || null, photo_type: ptype });
      toast.push("success", "Photo updated");
      onChanged();
      onClose();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Remove this photo from the job? (kept in storage, soft delete)")) return;
    setBusy(true);
    try {
      await api.del(`/api/photos/${p.id}`);
      toast.push("success", "Photo removed");
      onChanged();
      onClose();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span class="flex items-center gap-sm">
          Photo {index + 1} / {photos.length}
          {p.synced_from_offline && <Badge tone="neutral">offline-synced</Badge>}
        </span>
      }
      footer={
        <div class="flex items-center justify-between" style={{ width: "100%" }}>
          <div class="flex gap-sm">
            <Button variant="secondary" size="sm" disabled={index === 0} onClick={prev}>← Prev</Button>
            <Button variant="secondary" size="sm" disabled={index === photos.length - 1} onClick={next}>Next →</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={del} title="Remove this photo from the job (kept in storage)">Delete</Button>
          </div>
          <Button variant="primary" size="sm" disabled={busy} onClick={saveMeta}>Save</Button>
        </div>
      }
    >
      <div class="photo-detail">
        {pairedBefore ? (
          <BeforeAfterSlider beforeUrl={pairedBefore.original_url} afterUrl={p.original_url} />
        ) : pairedAfter ? (
          <BeforeAfterSlider beforeUrl={p.original_url} afterUrl={pairedAfter.original_url} />
        ) : annotatedSvg && showAnnotated ? (
          <div
            class="photo-detail__img photo-detail__img--clickable"
            title="Click to enlarge"
            onClick={() => setZoomed(true)}
            dangerouslySetInnerHTML={{ __html: annotatedSvg }}
          />
        ) : (
          <img
            class="photo-detail__img photo-detail__img--clickable"
            src={p.original_url}
            alt={p.caption ?? p.photo_type}
            title="Click to enlarge"
            onClick={() => setZoomed(true)}
          />
        )}
        <div class="stack">
          <FormField label="Caption">
            <input class="form-input" value={caption} onInput={(e) => setCaption((e.target as HTMLInputElement).value)} placeholder="Add a caption…" />
          </FormField>
          <FormField label="Type">
            <Select value={ptype} options={PHOTO_TYPE_OPTIONS} onChange={setPtype} />
          </FormField>
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            {formatDateTime(p.taken_at)}
            {p.latitude != null && p.longitude != null
              ? ` · 📍 ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`
              : " · 📍 no GPS"}
            {p.uploaded_by ? ` · ${p.uploaded_by}` : ""}
          </div>

          {p.receipt && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid var(--color-border)", margin: "var(--space-sm) 0" }} />
              <ReceiptConfirm
                receipt={p.receipt}
                jobId={p.job_id}
                onConfirmed={onChanged}
                onDone={() => { onChanged(); onClose(); }}
                toast={toast}
              />
            </>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--color-border)", margin: "var(--space-sm) 0" }} />
          <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
            <Button variant="secondary" size="sm" onClick={() => setAnnotating(true)}>
              ✏️ {p.is_annotated ? "Edit markup" : "Annotate"}
            </Button>
            {annotatedSvg && (
              <Button variant="tertiary" size="sm" onClick={() => setShowAnnotated((v) => !v)}>
                {showAnnotated ? "Show original" : "Show annotated"}
              </Button>
            )}
            {pairedBefore || pairedAfter ? (
              <Button variant="tertiary" size="sm" disabled={busy} onClick={pairedBefore ? unpair : () => { void api.post(`/api/photos/unpair`, { after_id: pairedAfter!.id }).then(() => { toast.push("success", "Pair removed"); onChanged(); }).catch((err: unknown) => toast.push("error", (err as Error).message)); }}>↔️ Unpair</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setPairing((v) => !v)}>
                ↔️ Before/After
              </Button>
            )}
          </div>

          {pairing && !pairedBefore && !pairedAfter && (
            <div class="stack" style={{ marginTop: "var(--space-2)" }}>
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                Tap a photo below to set it as the <strong>Before</strong>. This photo becomes the <strong>After</strong>. The slider appears on both once paired.
              </div>
              <div class="photo-grid">
                {photos
                  .filter((x) => x.id !== p.id && x.photo_type !== "receipt")
                  .map((x) => (
                    <button key={x.id} class="photo-thumb" disabled={busy} onClick={() => pairWith(x.id)}>
                      <img src={x.thumb_url} alt={x.caption ?? x.photo_type} loading="lazy" />
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {annotating && (
        <PhotoAnnotator
          photoId={p.id}
          originalUrl={p.original_url}
          onClose={() => setAnnotating(false)}
          onSaved={onChanged}
          toast={toast}
        />
      )}

      {zoomed && (
        <PhotoZoomView
          key={p.id}
          src={p.original_url}
          alt={p.caption ?? p.photo_type}
          onClose={() => setZoomed(false)}
        />
      )}
    </Modal>
  );
}

export function ReceiptConfirm({
  receipt,
  jobId,
  onConfirmed,
  onDone,
  toast,
}: {
  receipt: PhotoReceipt;
  jobId: string | null;
  onConfirmed: () => void;
  onDone?: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  // Pull the job's costing lines so the receipt confirm lands in the SAME full
  // expense form (estimate-line-item alignment + tax category + sub/1099).
  const costing = useApi<{ costing: { lines: CostingLineLite[] } }>(
    jobId ? `/api/jobs/${jobId}/costing` : null,
  );
  const lines: CostingLineLite[] = (costing.data?.costing.lines ?? []).map((l) => ({
    line_item_id: l.line_item_id,
    name: l.name,
    sub_items: l.sub_items.map((s) => ({ id: s.id, description: s.description, category: s.category })),
  }));

  const extractedItems = parseExtractedItems(receipt.extracted_items);

  const [draft, setDraft] = useState<ExpenseDraft>(
    emptyDraft({
      vendor: receipt.ai_vendor ?? "",
      amount: receipt.ai_amount != null ? String(receipt.ai_amount) : "",
      incurred_date: receipt.ai_date ?? new Date().toISOString().slice(0, 10),
      tax_category: receipt.ai_category ?? "materials",
    }),
  );
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(
    Boolean(receipt.expense_id || receipt.processing_status === "confirmed"),
  );
  const [showMatchReview, setShowMatchReview] = useState(false);
  const set = <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  if (confirmed) {
    return (
      <div class="stack">
        <div class="receipt-box">
          <Badge tone="success">Expense created</Badge>
          <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            This receipt has been confirmed.
          </span>
        </div>
        {showMatchReview && jobId && (
          <ReceiptMatchReview
            receiptPhotoId={receipt.id}
            jobId={jobId}
            toast={toast}
            onComplete={() => {
              setShowMatchReview(false);
              onDone?.();
            }}
          />
        )}
      </div>
    );
  }

  const confirm = async () => {
    const amt = Number(draft.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.push("error", "Enter a valid amount");
      return;
    }
    setBusy(true);
    try {
      const body = draftToBody(draft, jobId);
      await api.post(`/api/receipt-photos/${receipt.id}/confirm`, {
        ...body,
        // The confirm seam keys on vendor/amount/date/category in addition to
        // the full field set, and persists the receipt_photo linkage.
        date: draft.incurred_date,
        category: draft.tax_category,
      });
      toast.push("success", "Expense created from receipt");
      setConfirmed(true);
      setShowMatchReview(true);
      // If there's no job, match review won't appear — close the modal now.
      if (!jobId) {
        onDone?.();
      }
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="receipt-box stack">
      <div class="flex items-center gap-sm">
        <strong>Receipt → Expense</strong>
        {receipt.processing_status === "failed" ? (
          <Badge tone="warning">AI unavailable — enter manually</Badge>
        ) : (
          <Badge tone="neutral">
            AI suggestion{receipt.ai_confidence != null ? ` · ${Math.round(receipt.ai_confidence * 100)}%` : ""}
          </Badge>
        )}
      </div>

      {extractedItems.length > 0 && (
        <div class="receipt-items">
          <div class="receipt-items__label">AI-extracted line items</div>
          <table class="table table--compact">
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Qty</th>
                <th class="num">Unit</th>
                <th class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {extractedItems.map((item, i) => (
                <tr key={item.id ?? i}>
                  <td>{item.description}</td>
                  <td class="num">{item.quantity ?? 1}</td>
                  <td class="num">{item.unit_price != null ? `$${item.unit_price.toFixed(2)}` : "—"}</td>
                  <td class="num">${item.amount.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="receipt-items__hint text--muted">
            These items will be matched to estimate lines after you confirm.
          </div>
        </div>
      )}

      <ExpenseFields draft={draft} set={set} lines={lines} />
      <Button variant="primary" size="sm" disabled={busy} onClick={confirm}>
        {busy ? "Saving…" : "Confirm → Create Expense"}
      </Button>
    </div>
  );
}

function PhotoZoomView({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const pinchDist = useRef<number | null>(null);

  // Mirror state in refs so non-passive event handlers always see current values.
  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);

  const MIN_SCALE = 1;
  const MAX_SCALE = 6;

  const applyScale = (s: number) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    scaleRef.current = clamped;
    setScale(clamped);
    if (clamped <= MIN_SCALE) {
      txRef.current = 0;
      tyRef.current = 0;
      setTx(0);
      setTy(0);
    }
  };

  const applyTranslate = (x: number, y: number) => {
    txRef.current = x;
    tyRef.current = y;
    setTx(x);
    setTy(y);
  };

  // Escape key closes the zoom view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Wheel zoom — must be non-passive to call preventDefault.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyScale(scaleRef.current + (e.deltaY < 0 ? 0.25 : -0.25));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Touch pinch-to-zoom + drag — must be non-passive to call preventDefault.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        isDragging.current = false;
        pinchDist.current = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
      } else if (e.touches.length === 1 && scaleRef.current > 1) {
        isDragging.current = true;
        dragStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          tx: txRef.current,
          ty: tyRef.current,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchDist.current !== null) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        applyScale(scaleRef.current * (d / pinchDist.current));
        pinchDist.current = d;
      } else if (e.touches.length === 1 && isDragging.current) {
        applyTranslate(
          dragStart.current.tx + (e.touches[0].clientX - dragStart.current.x),
          dragStart.current.ty + (e.touches[0].clientY - dragStart.current.y),
        );
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchDist.current = null;
      if (e.touches.length === 0) isDragging.current = false;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  const onMouseDown = (e: MouseEvent) => {
    if (scaleRef.current <= 1) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, tx: txRef.current, ty: tyRef.current };
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging.current) return;
    applyTranslate(
      dragStart.current.tx + (e.clientX - dragStart.current.x),
      dragStart.current.ty + (e.clientY - dragStart.current.y),
    );
  };

  const onMouseUp = () => { isDragging.current = false; };

  return (
    <div
      ref={containerRef}
      class="photo-zoom-overlay"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <button
        type="button"
        class="photo-zoom-overlay__close"
        aria-label="Close enlarged view"
        onClick={onClose}
      >
        ✕
      </button>

      <div class="photo-zoom-overlay__controls">
        <button
          type="button"
          class="photo-zoom-overlay__btn"
          aria-label="Zoom in"
          onClick={() => applyScale(scaleRef.current + 0.5)}
        >
          +
        </button>
        <button
          type="button"
          class="photo-zoom-overlay__btn"
          aria-label="Zoom out"
          onClick={() => applyScale(scaleRef.current - 0.5)}
        >
          −
        </button>
      </div>

      <div
        class="photo-zoom-overlay__stage"
        onMouseDown={onMouseDown}
      >
        <img
          class="photo-zoom-overlay__img"
          src={src}
          alt={alt}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            cursor: scale > 1 ? "grab" : "zoom-in",
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
