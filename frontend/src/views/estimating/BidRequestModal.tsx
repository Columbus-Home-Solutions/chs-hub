/**
 * BidRequestModal — Sprint 38 Run 3.
 *
 * Owner creates a bid request from an estimate sub-item or a job (change-order context).
 * Selects which active subs to invite, sets sealed/open mode, notify-losers toggle.
 * On submit: POST /api/bid-requests, then optional reference photo upload.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";
import { api } from "../../api";

interface Sub {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  trade: string | null;
  phone: string | null;
  is_active: number;
}

interface PendingPhoto {
  file: File;
  preview: string;
}

interface BidRequestModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (bidRequestId: string) => void;
  /** Pre-fill from estimate context */
  estimateId?: string;
  estimateSubItemId?: string;
  estimateLineItemId?: string;
  defaultTitle?: string;
  defaultScope?: string;
  defaultQuantitiesNotes?: string;
  /** Pre-fill from job context */
  jobId?: string;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function subLabel(s: Sub): string {
  return [s.company_name, s.contact_name || s.primary_contact].filter(Boolean).join(" — ");
}

function subMatchesQuery(s: Sub, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    subLabel(s).toLowerCase().includes(q) ||
    (s.trade ?? "").toLowerCase().includes(q)
  );
}

async function uploadBidPhotos(bidRequestId: string, photos: File[]): Promise<void> {
  const form = new FormData();
  for (const file of photos) {
    form.append("photos", file, file.name || "reference.jpg");
  }
  const res = await fetch(`/api/bid-requests/${bidRequestId}/photos`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Photo upload failed: ${res.status}`);
  }
}

export function BidRequestModal({
  open,
  onClose,
  onCreated,
  estimateId,
  estimateSubItemId,
  estimateLineItemId,
  defaultTitle = "",
  defaultScope = "",
  defaultQuantitiesNotes = "",
  jobId,
}: BidRequestModalProps) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subSearch, setSubSearch] = useState("");
  const [subDropdownOpen, setSubDropdownOpen] = useState(false);
  const subPickerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(defaultTitle);
  const [scopeDescription, setScopeDescription] = useState(defaultScope);
  const [quantitiesNotes, setQuantitiesNotes] = useState(defaultQuantitiesNotes);
  const [neededByDate, setNeededByDate] = useState("");
  const [bidMode, setBidMode] = useState<"sealed" | "open">("sealed");
  const [notifyLosers, setNotifyLosers] = useState(true);
  const [selectedSubIds, setSelectedSubIds] = useState<Set<string>>(new Set());
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setScopeDescription(defaultScope);
      setQuantitiesNotes(defaultQuantitiesNotes);
      setNeededByDate("");
      setBidMode("sealed");
      setNotifyLosers(true);
      setSelectedSubIds(new Set());
      setSubSearch("");
      setSubDropdownOpen(false);
      setPendingPhotos((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.preview);
        return [];
      });
      setPhotoError(null);
      setError(null);
    }
  }, [open, defaultTitle, defaultScope, defaultQuantitiesNotes]);

  useEffect(
    () => () => {
      for (const p of pendingPhotos) URL.revokeObjectURL(p.preview);
    },
    [pendingPhotos],
  );

  // Load active subs on open
  useEffect(() => {
    if (!open) return;
    setSubsLoading(true);
    api
      .get<{ subcontractors: Sub[] }>("/api/subcontractors?is_active=1&limit=200")
      .then((d) => setSubs((d.subcontractors ?? []).filter((s) => s.is_active !== 0)))
      .catch(() => setSubs([]))
      .finally(() => setSubsLoading(false));
  }, [open]);

  // Close browse dropdown when clicking outside the picker.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      if (!subPickerRef.current?.contains(ev.target as Node)) {
        setSubDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const addSub = (id: string) => {
    setSelectedSubIds((prev) => new Set(prev).add(id));
    setSubSearch("");
    setSubDropdownOpen(false);
  };

  const removeSub = (id: string) => {
    setSelectedSubIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const onPhotoSelected = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("Photo too large — please use a smaller image (under 10 MB)");
      return;
    }
    setPhotoError(null);
    setPendingPhotos((prev) => [
      ...prev,
      { file, preview: URL.createObjectURL(file) },
    ]);
  };

  const removePhoto = (index: number) => {
    setPendingPhotos((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.preview);
      return next;
    });
  };

  const selectedSubs = subs.filter((s) => selectedSubIds.has(s.id));
  const availableSubs = subs.filter((s) => !selectedSubIds.has(s.id));
  const subSuggestions = subSearch.trim()
    ? availableSubs.filter((s) => subMatchesQuery(s, subSearch))
    : availableSubs;

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required."); return; }
    if (!scopeDescription.trim()) { setError("Scope description is required."); return; }
    if (selectedSubIds.size === 0) { setError("Select at least one sub to invite."); return; }
    if (!estimateId && !jobId) { setError("Missing estimate or job context."); return; }

    setSubmitting(true);
    try {
      const result = await api.post<{ id: string }>("/api/bid-requests", {
        title: title.trim(),
        scope_description: scopeDescription.trim(),
        quantities_notes: quantitiesNotes.trim() || null,
        needed_by_date: neededByDate || null,
        estimate_id: estimateId ?? null,
        job_id: jobId ?? null,
        estimate_sub_item_id: estimateSubItemId ?? null,
        estimate_line_item_id: estimateLineItemId ?? null,
        bid_mode: bidMode,
        notify_losers: notifyLosers ? 1 : 0,
        sub_ids: Array.from(selectedSubIds),
      });

      if (pendingPhotos.length > 0) {
        await uploadBidPhotos(
          result.id,
          pendingPhotos.map((p) => p.file),
        );
      }

      onCreated(result.id);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Failed to create bid request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Request Bids from Subs"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={submitting || selectedSubIds.size === 0}
            onClick={handleSubmit}
          >
            {submitting ? "Sending invites…" : `Send to ${selectedSubIds.size} sub${selectedSubIds.size !== 1 ? "s" : ""}`}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}

        <FormField label="Bid request title" required>
          <input
            class="form-input"
            type="text"
            placeholder="e.g. Electrical rough-in — Unit 4"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Scope of work" required>
          <textarea
            class="form-input"
            rows={4}
            placeholder="Describe exactly what you need priced. Be specific so subs can give accurate quotes."
            value={scopeDescription}
            onInput={(e) => setScopeDescription((e.target as HTMLTextAreaElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Quantities / measurements (optional)">
          <textarea
            class="form-input"
            rows={2}
            placeholder="e.g. 1,200 sq ft, 14 fixtures, 3 circuits"
            value={quantitiesNotes}
            onInput={(e) => setQuantitiesNotes((e.target as HTMLTextAreaElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Reference photos (optional)">
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              onPhotoSelected((e.target as HTMLInputElement).files?.[0]);
              (e.target as HTMLInputElement).value = "";
            }}
          />
          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = (e.target as HTMLInputElement).files;
              if (files) {
                for (const file of files) onPhotoSelected(file);
              }
              (e.target as HTMLInputElement).value = "";
            }}
          />

          {pendingPhotos.length > 0 && (
            <div class="bid-ref-photos" style={{ marginBottom: "var(--space-sm)" }}>
              {pendingPhotos.map((p, i) => (
                <div key={p.preview} class="bid-ref-photos__item">
                  <img src={p.preview} alt={`Reference photo ${i + 1}`} />
                  <button
                    type="button"
                    class="bid-ref-photos__remove"
                    disabled={submitting}
                    onClick={() => removePhoto(i)}
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div class="punch-done-photo-pick">
            <button
              type="button"
              class="punch-done-photo-pick__btn"
              disabled={submitting}
              onClick={() => cameraRef.current?.click()}
            >
              Take photo
            </button>
            <span class="punch-done-photo-pick__or">or</span>
            <button
              type="button"
              class="punch-done-photo-pick__btn"
              disabled={submitting}
              onClick={() => libraryRef.current?.click()}
            >
              Choose from library
            </button>
          </div>
          {photoError && <p class="form-error" role="alert">{photoError}</p>}
        </FormField>

        <FormField label="Needed by date (optional)">
          <input
            class="form-input"
            type="date"
            value={neededByDate}
            onInput={(e) => setNeededByDate((e.target as HTMLInputElement).value)}
            disabled={submitting}
          />
        </FormField>

        {/* Sealed / Open toggle */}
        <div>
          <div class="form-label" style={{ marginBottom: "8px" }}>Bidding mode</div>
          <div class="radio-group">
            <label class="radio-option">
              <input
                type="radio"
                name="bid_mode"
                value="sealed"
                checked={bidMode === "sealed"}
                onChange={() => setBidMode("sealed")}
                disabled={submitting}
              />
              <span>
                Sealed — subs can't see each other's prices (default — recommended)
              </span>
            </label>
            <label class="radio-option">
              <input
                type="radio"
                name="bid_mode"
                value="open"
                checked={bidMode === "open"}
                onChange={() => setBidMode("open")}
                disabled={submitting}
              />
              <span>
                Open — subs see the current price list after submitting
              </span>
            </label>
          </div>
        </div>

        {/* Notify losers toggle */}
        <label class="checkbox-option">
          <input
            type="checkbox"
            checked={notifyLosers}
            onChange={(e) => setNotifyLosers((e.target as HTMLInputElement).checked)}
            disabled={submitting}
          />
          <span>
            Notify non-winning subs with a "thanks, went another direction" message
          </span>
        </label>

        {/* Sub selection — tag/chip autocomplete */}
        <div>
          <div class="form-label" style={{ marginBottom: "8px" }}>
            Invite subs{" "}
            {selectedSubIds.size > 0 && (
              <span class="badge badge--info" style={{ marginLeft: "6px" }}>
                {selectedSubIds.size} selected
              </span>
            )}
          </div>
          {subsLoading ? (
            <Spinner />
          ) : subs.length === 0 ? (
            <p class="form-hint">No active subs found.</p>
          ) : (
            <div class="bid-sub-picker" ref={subPickerRef}>
              {selectedSubs.length > 0 && (
                <div class="chip-row" style={{ marginBottom: "var(--space-sm)" }}>
                  {selectedSubs.map((s) => (
                    <span
                      key={s.id}
                      class="badge badge--brand bid-sub-chip"
                    >
                      <span class="bid-sub-chip__label">
                        {subLabel(s)}
                        {s.trade ? (
                          <span class="bid-sub-chip__trade badge badge--secondary">{s.trade}</span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        class="bid-sub-chip__remove"
                        onClick={() => removeSub(s.id)}
                        disabled={submitting}
                        title={`Remove ${subLabel(s)}`}
                        aria-label={`Remove ${subLabel(s)}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                class="form-input"
                type="text"
                placeholder="Type a sub's name or trade…"
                value={subSearch}
                onFocus={() => setSubDropdownOpen(true)}
                onInput={(e) => {
                  setSubSearch((e.target as HTMLInputElement).value);
                  setSubDropdownOpen(true);
                }}
                disabled={submitting}
                autoComplete="off"
              />
              {subDropdownOpen ? (
                <div class="catalog-ac bid-sub-picker__dropdown" role="listbox">
                  {subSuggestions.length === 0 ? (
                    <div class="catalog-ac__empty">
                      {subSearch.trim()
                        ? "No subs match"
                        : availableSubs.length === 0
                          ? "All subs invited"
                          : "No subs available"}
                    </div>
                  ) : (
                    subSuggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        class="catalog-ac__item bid-sub-picker__option"
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => addSub(s.id)}
                        disabled={submitting}
                      >
                        <div class="catalog-ac__item-top">
                          <span class="catalog-ac__item-name">{subLabel(s)}</span>
                          {s.trade ? (
                            <span class="badge badge--secondary" style={{ fontSize: "11px", flexShrink: 0 }}>
                              {s.trade}
                            </span>
                          ) : null}
                        </div>
                        {s.phone ? <div class="catalog-ac__item-desc">{s.phone}</div> : null}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
