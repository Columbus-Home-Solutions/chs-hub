/**
 * Public sub-facing punch list (Sprint 33).
 * Token in URL is the only credential — no Cloudflare Access, no login.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { formatDate } from "../../lib/format";
import {
  PunchPublicError,
  PunchPublicFooter,
  PunchPublicHeader,
  PunchPublicLoading,
} from "../public/punchPublicUi";

interface PunchPublicItem {
  id: string;
  description: string;
  status: string;
  scheduled_date: string | null;
  photo_urls: string[];
  completed_at: string | null;
}

interface PunchPublicPayload {
  job_title: string;
  job_address: string;
  sub_name: string;
  scheduled_date: string | null;
  items: PunchPublicItem[];
}

function punchToken(): string {
  const m = window.location.pathname.match(/\/punch\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function getPunch<T>(token: string): Promise<T> {
  const res = await fetch(`/api/punch/${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error((data?.message || data?.error || `Request failed: ${res.status}`) as string);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  return data as T;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

async function markDone(
  token: string,
  itemId: string,
  note: string | null,
  photo: File,
): Promise<void> {
  const form = new FormData();
  form.append("photo", photo, photo.name || "completion.jpg");
  if (note) form.append("note", note);

  const res = await fetch(
    `/api/punch/${encodeURIComponent(token)}/items/${encodeURIComponent(itemId)}/done`,
    {
      method: "PUT",
      headers: { Accept: "application/json" },
      body: form,
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data?.error as string | undefined;
    if (code === "photo_too_large") {
      throw new Error("Photo too large — please use a smaller image");
    }
    if (code === "upload_failed") {
      throw new Error("Upload failed — please try again");
    }
    throw new Error((data?.message || data?.error || `Request failed: ${res.status}`) as string);
  }
}

export function PunchPage() {
  const token = useMemo(punchToken, []);
  const [data, setData] = useState<PunchPublicPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [confirmItem, setConfirmItem] = useState<PunchPublicItem | null>(null);
  const [note, setNote] = useState("");
  const [completionPhoto, setCompletionPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [allDoneBanner, setAllDoneBanner] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const clearPhoto = useCallback(() => {
    setCompletionPhoto(null);
    setPhotoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPhotoError(null);
  }, []);

  const closeConfirm = useCallback(() => {
    if (busy) return;
    setConfirmItem(null);
    setNote("");
    clearPhoto();
  }, [busy, clearPhoto]);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const onPhotoSelected = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("Photo too large — please use a smaller image");
      setCompletionPhoto(null);
      setPhotoPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    setPhotoError(null);
    setCompletionPhoto(file);
    setPhotoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  const load = useCallback(async () => {
    if (!token) {
      setError("invalid_token");
      setErrorStatus(404);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = await getPunch<PunchPublicPayload>(token);
      setData(payload);
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message);
      setErrorStatus(err.status ?? null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const openItems = data?.items.filter((i) => i.status !== "done") ?? [];
  const doneItems = data?.items.filter((i) => i.status === "done") ?? [];

  const submitDone = async () => {
    if (!confirmItem || !token || !completionPhoto) return;
    setBusy(true);
    setPhotoError(null);
    try {
      await markDone(token, confirmItem.id, note.trim() || null, completionPhoto);
      closeConfirm();
      await load();
      const refreshed = await getPunch<PunchPublicPayload>(token);
      const stillOpen = refreshed.items.some((i) => i.status !== "done");
      if (!stillOpen && refreshed.items.length > 0) setAllDoneBanner(true);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("too large") || msg.includes("Upload failed")) {
        setPhotoError(msg);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <PunchPublicLoading label="Loading your punch list…" />;
  }

  if (error || !data) {
    const inactive = errorStatus === 404 || errorStatus === 410 || error === "invalid_token";
    return <PunchPublicError inactive={inactive} message={error} />;
  }

  const due =
    data.scheduled_date != null && data.scheduled_date !== ""
      ? formatDate(data.scheduled_date)
      : "No date set";

  return (
    <div class="portal">
      <PunchPublicHeader title={`Punch List — ${data.job_title}`} address={data.job_address} />

      <section class="portal-card">
        <div class="punch-page__greeting">
          <p>
            Hi {data.sub_name || "there"},
            <br />
            You have <strong>{openItems.length}</strong> item(s) to complete.
          </p>
          <p class="punch-page__due">Due: {due}</p>
        </div>
      </section>

      {allDoneBanner && (
        <div class="punch-page__banner" role="status">
          All items complete! Tony has been notified.
        </div>
      )}

      <section class="portal-card">
        <h2 class="portal-card__title">Items</h2>
        <div class="punch-items">
          {[...openItems, ...doneItems].map((item, idx) => {
            const done = item.status === "done";
            return (
              <div class={`punch-item${done ? " punch-item--done" : ""}`} key={item.id}>
                <span class="punch-item__num">{idx + 1}.</span>
                <div class="punch-item__body">
                  <div class="punch-item__desc">{item.description}</div>
                  {item.scheduled_date && (
                    <div class="punch-item__meta">Scheduled: {formatDate(item.scheduled_date)}</div>
                  )}
                  {item.photo_urls.length > 0 && (
                    <div class="punch-item__photos">
                      <div class="portal-photos__grid">
                        {item.photo_urls.map((url) => (
                          <button
                            type="button"
                            key={url}
                            class="portal-photo"
                            onClick={() => setLightbox(url)}
                          >
                            <img src={url} alt="" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {done && item.completed_at && (
                    <div class="punch-item__meta">Completed {formatDate(item.completed_at)}</div>
                  )}
                </div>
                <div class="punch-item__actions">
                  {!done ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setConfirmItem(item);
                        setNote("");
                        clearPhoto();
                      }}
                    >
                      Done ✓
                    </Button>
                  ) : (
                    <span class="badge badge--success">Done</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <PunchPublicFooter />

      {confirmItem && (
        <Modal
          open
          title="Mark Item Complete"
          onClose={closeConfirm}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={closeConfirm}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || !completionPhoto} onClick={submitDone}>
                {busy ? "Saving…" : "Mark Complete"}
              </Button>
            </>
          }
        >
          <div class="punch-done-sheet">
            <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              {confirmItem.description}
            </p>

            <FormField label="Completion photo" required>
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
                style={{ display: "none" }}
                onChange={(e) => {
                  onPhotoSelected((e.target as HTMLInputElement).files?.[0]);
                  (e.target as HTMLInputElement).value = "";
                }}
              />

              {photoPreview ? (
                <div class="punch-done-photo-preview">
                  <img src={photoPreview} alt="Completion photo preview" />
                  <Button variant="secondary" size="sm" disabled={busy} onClick={clearPhoto}>
                    Remove photo
                  </Button>
                </div>
              ) : (
                <div class="punch-done-photo-pick">
                  <button
                    type="button"
                    class="punch-done-photo-pick__btn"
                    disabled={busy}
                    onClick={() => cameraRef.current?.click()}
                  >
                    Tap to take photo
                  </button>
                  <span class="punch-done-photo-pick__or">or</span>
                  <button
                    type="button"
                    class="punch-done-photo-pick__btn"
                    disabled={busy}
                    onClick={() => libraryRef.current?.click()}
                  >
                    Choose from library
                  </button>
                </div>
              )}
              {photoError && (
                <p class="form-error" role="alert">
                  {photoError}
                </p>
              )}
            </FormField>

            <FormField label="Note (optional)">
              <textarea
                class="form-input"
                rows={3}
                value={note}
                onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
                placeholder="Optional completion note"
              />
            </FormField>
          </div>
        </Modal>
      )}

      {lightbox && (
        <div class="portal-photo-lightbox" onClick={() => setLightbox(null)}>
          <div class="portal-photo-lightbox__inner" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              class="portal-photo-lightbox__close"
              aria-label="Close"
              onClick={() => setLightbox(null)}
            >
              ×
            </button>
            <img src={lightbox} alt="Punch list photo" />
          </div>
        </div>
      )}
    </div>
  );
}
