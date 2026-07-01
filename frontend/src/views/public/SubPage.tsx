/**
 * Persistent Sub Link page (Sprint 34).
 * Token in URL is the only credential — no Cloudflare Access, no login.
 * Grouped by job; reuses the same photo-required completion flow as PunchPage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";

interface SubPublicItem {
  id: string;
  description: string;
  status: string;
  scheduled_date: string | null;
  photo_ids: string[];
  completed_at: string | null;
}

interface SubJobGroup {
  job_id: string;
  job_title: string;
  property_address: string | null;
  items: SubPublicItem[];
}

interface SubPublicPayload {
  sub: {
    company_name: string | null;
    contact_name: string | null;
  };
  jobs: SubJobGroup[];
}

function subToken(): string {
  const m = window.location.pathname.match(/\/sub\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function getSubData<T>(token: string): Promise<T> {
  const res = await fetch(`/api/sub/${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = new Error((data?.message || data?.error || `Request failed: ${res.status}`) as string);
    (e as Error & { status: number }).status = res.status;
    throw e;
  }
  return data as T;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

async function markItemDone(
  token: string,
  itemId: string,
  note: string | null,
  photo: File,
): Promise<void> {
  const form = new FormData();
  form.append("photo", photo, photo.name || "completion.jpg");
  if (note) form.append("note", note);

  const res = await fetch(
    `/api/sub/${encodeURIComponent(token)}/items/${encodeURIComponent(itemId)}/done`,
    { method: "PUT", headers: { Accept: "application/json" }, body: form },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data?.error as string | undefined;
    if (code === "photo_too_large") throw new Error("Photo too large — please use a smaller image");
    if (code === "upload_failed") throw new Error("Upload failed — please try again");
    throw new Error((data?.message || data?.error || `Request failed: ${res.status}`) as string);
  }
}

export function SubPage() {
  const token = useMemo(subToken, []);
  const [data, setData] = useState<SubPublicPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [confirmItem, setConfirmItem] = useState<SubPublicItem | null>(null);
  const [note, setNote] = useState("");
  const [completionPhoto, setCompletionPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      const payload = await getSubData<SubPublicPayload>(token);
      setData(payload);
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message);
      setErrorStatus(err.status ?? null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const submitDone = async () => {
    if (!confirmItem || !token || !completionPhoto) return;
    setBusy(true);
    setPhotoError(null);
    try {
      await markItemDone(token, confirmItem.id, note.trim() || null, completionPhoto);
      closeConfirm();
      await load();
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
    return (
      <div class="punch-page">
        <Spinner center />
      </div>
    );
  }

  if (error || !data) {
    const inactive = errorStatus === 404 || error === "invalid_token";
    return (
      <div class="punch-page">
        <div class="punch-page__error">
          <div class="portal-empty__icon">🔗</div>
          <h1 class="punch-page__title">
            {inactive ? "Link no longer active" : "Something went wrong"}
          </h1>
          <p>
            {inactive
              ? "This link is no longer active. Contact Tony at (501) 551-1814."
              : error ?? "Could not load your items."}
          </p>
        </div>
      </div>
    );
  }

  const subName = data.sub.contact_name || data.sub.company_name || "there";
  const totalOpen = data.jobs.reduce(
    (acc, g) => acc + g.items.filter((i) => i.status !== "done").length,
    0,
  );

  // Empty state: no open items across any job.
  if (data.jobs.length === 0 || totalOpen === 0) {
    return (
      <div class="punch-page">
        <header class="punch-page__brand">
          <div class="punch-page__company">Columbus Home Solutions LLC</div>
          <h1 class="punch-page__title">My Items</h1>
        </header>
        <div class="punch-page__greeting">
          <p>
            Hi {subName},<br />
            You're all caught up — no open items right now.
          </p>
        </div>
        <footer class="punch-page__footer">
          Questions? Call Tony: <a href="tel:+15015511814">(501) 551-1814</a>
        </footer>
      </div>
    );
  }

  return (
    <div class="punch-page">
      <header class="punch-page__brand">
        <div class="punch-page__company">Columbus Home Solutions LLC</div>
        <h1 class="punch-page__title">My Items</h1>
      </header>

      <div class="punch-page__greeting">
        <p>
          Hi {subName},<br />
          You have <strong>{totalOpen}</strong> open item{totalOpen !== 1 ? "s" : ""} to complete.
        </p>
      </div>

      {data.jobs.map((group) => {
        const openItems = group.items.filter((i) => i.status !== "done");
        const doneItems = group.items.filter((i) => i.status === "done");
        if (openItems.length === 0 && doneItems.length === 0) return null;
        return (
          <section key={group.job_id} class="sub-job-group">
            <h2 class="sub-job-group__title">{group.job_title}</h2>
            {group.property_address && (
              <div class="punch-page__addr">{group.property_address}</div>
            )}
            {[...openItems, ...doneItems].map((item, idx) => {
              const done = item.status === "done";
              return (
                <div class={`punch-item${done ? " punch-item--done" : ""}`} key={item.id}>
                  <span class="punch-item__num">{idx + 1}.</span>
                  <div class="punch-item__body">
                    <div class="punch-item__desc">{item.description}</div>
                    {done && item.completed_at && (
                      <div class="punch-item__meta">
                        Completed {new Date(item.completed_at).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  {!done ? (
                    <button
                      type="button"
                      class="punch-item__done-btn"
                      onClick={() => {
                        setConfirmItem(item);
                        setNote("");
                        clearPhoto();
                      }}
                    >
                      Done ✓
                    </button>
                  ) : (
                    <span class="punch-item__done-badge">DONE</span>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      <footer class="punch-page__footer">
        Questions? Call Tony: <a href="tel:+15015511814">(501) 551-1814</a>
      </footer>

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
    </div>
  );
}
