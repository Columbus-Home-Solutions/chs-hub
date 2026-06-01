import { useMemo, useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDateTime } from "../../lib/format";
import { uploadPhoto } from "../../lib/capture";
import {
  ExpenseFields,
  emptyDraft,
  draftToBody,
  type ExpenseDraft,
  type CostingLineLite,
} from "../financial/ExpenseForm";

export interface PhotoReceipt {
  id: string;
  processing_status: string;
  ai_vendor: string | null;
  ai_amount: number | null;
  ai_date: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
  expense_id: string | null;
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
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (from) qs.set("from", from);
  if (to) qs.set("to", `${to}T23:59:59Z`);
  const url = `/api/jobs/${jobId}/photos${qs.toString() ? `?${qs}` : ""}`;
  const { data, loading, error, refetch } = useApi<{ photos: PhotoItem[]; total: number }>(url);

  const photos = data?.photos ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, PhotoItem[]>();
    for (const p of photos) {
      const k = dayKey(p.taken_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return Array.from(m.entries());
  }, [photos]);

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
    <div class="stack">
      <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <Select
            value={type}
            placeholder="All types"
            options={PHOTO_TYPE_OPTIONS}
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
        <div>
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
                return (
                  <button key={p.id} class="photo-thumb" onClick={() => setOpenIdx(idx)}>
                    <img src={p.thumb_url} alt={p.caption ?? p.photo_type} loading="lazy" />
                    <span class="photo-thumb__type">{TYPE_LABEL[p.photo_type] ?? p.photo_type}</span>
                    {p.receipt && <span class="photo-thumb__badge">💵</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}

      {openIdx != null && photos[openIdx] && (
        <PhotoDetailModal
          photos={photos}
          index={openIdx}
          onIndex={setOpenIdx}
          onClose={() => setOpenIdx(null)}
          onChanged={refetch}
          toast={toast}
        />
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

  const prev = () => index > 0 && onIndex(index - 1);
  const next = () => index < photos.length - 1 && onIndex(index + 1);

  const saveMeta = async () => {
    setBusy(true);
    try {
      await api.put(`/api/photos/${p.id}`, { caption: caption.trim() || null, photo_type: ptype });
      toast.push("success", "Photo updated");
      onChanged();
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
          </div>
          <div class="flex gap-sm">
            <Button variant="danger" size="sm" disabled={busy} onClick={del}>Delete</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={saveMeta}>Save</Button>
          </div>
        </div>
      }
    >
      <div class="photo-detail">
        <img class="photo-detail__img" src={p.original_url} alt={p.caption ?? p.photo_type} />
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

          {p.receipt && <ReceiptConfirm receipt={p.receipt} jobId={p.job_id} onConfirmed={onChanged} toast={toast} />}

          {/* Deferred seams — rendered disabled so they're discoverable but not wired.
              Annotate = Sprint 18, Before/After = Sprint 18, Social = Sprint 16. */}
          <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
            <Button variant="tertiary" size="sm" disabled title="Coming soon (Sprint 18)">✏️ Annotate</Button>
            <Button variant="tertiary" size="sm" disabled title="Coming soon (Sprint 18)">↔️ Before/After</Button>
            <Button variant="tertiary" size="sm" disabled title="Coming soon (Sprint 16)">📣 Social</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function ReceiptConfirm({
  receipt,
  jobId,
  onConfirmed,
  toast,
}: {
  receipt: PhotoReceipt;
  jobId: string | null;
  onConfirmed: () => void;
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

  const [draft, setDraft] = useState<ExpenseDraft>(
    emptyDraft({
      vendor: receipt.ai_vendor ?? "",
      amount: receipt.ai_amount != null ? String(receipt.ai_amount) : "",
      incurred_date: receipt.ai_date ?? new Date().toISOString().slice(0, 10),
      tax_category: receipt.ai_category ?? "materials",
    }),
  );
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  if (receipt.expense_id || receipt.processing_status === "confirmed") {
    return (
      <div class="receipt-box">
        <Badge tone="success">Expense created</Badge>
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>This receipt has been confirmed.</span>
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
      onConfirmed();
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
      <ExpenseFields draft={draft} set={set} lines={lines} />
      <Button variant="primary" size="sm" disabled={busy} onClick={confirm}>
        {busy ? "Saving…" : "Confirm → Create Expense"}
      </Button>
    </div>
  );
}
