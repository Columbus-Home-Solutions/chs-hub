import type { RoutableProps } from "preact-router";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime, formatStatus } from "../../lib/format";
import { jobTypeDisplayLabel } from "@chs/shared/job-type-label";
import { formatCurrency } from "../../lib/format";
import { ClientForm } from "../clients/ClientForm";
import { uploadPhoto } from "../../lib/capture";
import {
  cancelNativeAudioRecording,
  capturePhotoNative,
  isNativePlatform,
  nativeAudioRecorderAvailable,
  openAppSettings,
  startNativeAudioRecording,
  stopNativeAudioRecording,
} from "../../lib/native";
import { MarkWonModal } from "./MarkWonModal";
import { canDeleteEstimate, DeleteEstimateButton } from "./DeleteEstimateButton";
import { canDeleteRequest, DeleteRequestButton } from "./DeleteRequestButton";
import { ScopeDraftSection } from "./ScopeDraftSection";
import { ScopeSummaryCard } from "./ScopeSummaryCard";
import { SketchModal } from "./SketchModal";
import { VisitCaptureLegacy } from "./VisitCaptureLegacy";
import { VisitCaptureRedesign } from "./VisitCaptureRedesign";
import { useViewportTier } from "../../hooks/useViewportTier";
import {
  ESTIMATE_SENT_TOOLTIP,
  LEAD_SOURCES,
  LOST_REASONS,
  PIPELINE_STAGES,
  type ActivityEntry,
  type Client,
  type Estimate,
  type EstimateRequest,
  type EstimateRequestStatus,
  type ScopeDraftItem,
  type SketchMeta,
} from "../../types";

function webMediaRecorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.includes("@highlevel.placeholder");
}

/** Same detection as HL mirror (`looksLikePhoneName`) — phone-as-title is not a real name. */
function looksLikePhoneName(name: string): boolean {
  const digits = name.replace(/\D/g, "");
  if (digits.length < 7) return false;
  const compact = name.replace(/[\s().+\-]/g, "");
  return digits.length / Math.max(compact.length, 1) >= 0.7;
}

function isSyntheticNamePart(part: string): boolean {
  const p = part.trim().toLowerCase();
  return !p || p === "unknown" || p === "lead" || p === "google lsa" || looksLikePhoneName(part);
}

/** Prefer genuine first/last; leave blanks when the placeholder is phone-as-title / Unknown. */
function namePrefillFromClient(fullName: string | null | undefined): {
  first_name: string;
  last_name: string;
} {
  const name = (fullName ?? "").trim();
  if (!name || looksLikePhoneName(name)) return { first_name: "", last_name: "" };
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    if (isSyntheticNamePart(parts[0])) return { first_name: "", last_name: "" };
    return { first_name: parts[0], last_name: "" };
  }
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  if (isSyntheticNamePart(first) && isSyntheticNamePart(last)) {
    return { first_name: "", last_name: "" };
  }
  return {
    first_name: isSyntheticNamePart(first) ? "" : first,
    last_name: isSyntheticNamePart(last) ? "" : last,
  };
}

function propertyPrefill(r: EstimateRequest): Partial<Client> {
  const addr = (r.property_address ?? "").trim();
  const zip = (r.property_zip ?? "").trim();
  if (!addr || addr === "Unknown" || zip === "00000") return {};
  const city = (r.property_city ?? "").trim();
  const state = (r.property_state ?? "").trim();
  return {
    mailing_address: addr,
    mailing_city: !city || city === "Unknown" ? "" : city,
    mailing_state: !state || state === "Unknown" ? "" : state,
    mailing_zip: zip,
  };
}

/**
 * Map estimate_requests.lead_source → clients.lead_source (ClientForm LEAD_SOURCES).
 * Shared values (e.g. google_lsa) pass through; a few estimate-only labels remap.
 */
function leadSourcePrefill(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  const aliases: Record<string, string> = {
    website_form: "website",
    repeat_client: "repeat",
  };
  const mapped = aliases[v] ?? v;
  return (LEAD_SOURCES as readonly string[]).includes(mapped) ? mapped : "";
}

function clientCreatePrefill(r: EstimateRequest): Partial<Client> {
  const names = namePrefillFromClient(r.client_name);
  const email =
    r.client_email && !isPlaceholderEmail(r.client_email) ? r.client_email.trim() : "";
  const phone = (r.client_phone ?? "").trim();
  const lead_source = leadSourcePrefill(r.lead_source);
  return {
    ...names,
    phone: phone && phone !== "unknown" ? phone : "",
    email,
    ...(lead_source ? { lead_source } : {}),
    ...propertyPrefill(r),
  };
}

/** HL mirror often stores phone-as-name + placeholder email (property may also be Unknown). */
function needsRealClient(r: EstimateRequest): boolean {
  if (!r.client_id) return true;
  if (isPlaceholderEmail(r.client_email)) return true;
  const name = (r.client_name ?? "").trim();
  if (looksLikePhoneName(name)) return true;
  return false;
}

interface ClientHit {
  id: string;
  name: string;
  phone: string;
}

function LinkClientModal({
  open,
  onClose,
  onLinked,
  request,
  defaultPath = "create",
}: {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
  request: EstimateRequest;
  /** Thin-client CTA defaults to create; "Change client" opens search. */
  defaultPath?: "create" | "search";
}) {
  const toast = useToast();
  /** Default path is pre-filled create; search is secondary. */
  const [path, setPath] = useState<"create" | "search">(defaultPath);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientHit[]>([]);
  const [selected, setSelected] = useState<ClientHit | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefill = clientCreatePrefill(request);

  const reset = useCallback(() => {
    setPath(defaultPath);
    setQuery("");
    setResults([]);
    setSelected(null);
    setSubmitting(false);
  }, [defaultPath]);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    setPath(defaultPath);
  }, [open, reset, defaultPath]);

  useEffect(() => {
    if (!open || path !== "search") return;
    const hint = (request.client_phone ?? "").replace(/\D/g, "").slice(-10);
    if (hint) setQuery(hint);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, path, request.client_phone]);

  useEffect(() => {
    if (!open || path !== "search" || !query.trim() || selected) {
      if (!query.trim() || selected) setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const d = await api.get<{
          clients: {
            id: string;
            first_name: string | null;
            last_name: string | null;
            phone: string | null;
          }[];
        }>(`/api/clients?search=${encodeURIComponent(query)}&limit=8`);
        setResults(
          (d.clients ?? []).map((c) => ({
            id: c.id,
            name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unknown",
            phone: c.phone ?? "",
          })),
        );
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, selected, open, path]);

  const link = async (clientId: string) => {
    setSubmitting(true);
    try {
      await api.put(`/api/estimate-requests/${request.id}`, { client_id: clientId });
      toast.push("success", "Client linked");
      onLinked();
      onClose();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Failed to link client");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <ClientForm
        open={open && path === "create"}
        mode="create"
        initial={prefill}
        onClose={onClose}
        onSaved={(client) => void link(client.id)}
        secondaryAction={{
          label: "Search for an existing client instead",
          onClick: () => {
            setSelected(null);
            setResults([]);
            setPath("search");
          },
        }}
      />
      <Modal
        open={open && path === "search"}
        title="Link Existing Client"
        onClose={onClose}
        footer={
          <div class="flex items-center justify-between gap-sm" style={{ width: "100%" }}>
            <button
              type="button"
              class="link-btn"
              style={{ fontSize: "var(--text-sm)" }}
              onClick={() => setPath("create")}
            >
              ← Back to create
            </button>
            <Button
              variant="primary"
              disabled={!selected || submitting}
              onClick={() => selected && void link(selected.id)}
            >
              {submitting ? "Linking…" : "Link Client"}
            </Button>
          </div>
        }
      >
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
          Use this if the phone already belongs to a real client in CHS.
        </p>
        {selected ? (
          <div class="quick-action-modal__selected-client">
            <span>{selected.name}</span>
            <button
              type="button"
              class="mc-new-compose__clear"
              onClick={() => {
                setSelected(null);
                setQuery("");
                setResults([]);
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <input
              ref={inputRef}
              class="form-input"
              placeholder="Search client by name or phone…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              autoComplete="off"
            />
            {results.length > 0 && (
              <div class="mc-client-results">
                {results.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    class="mc-client-result"
                    onClick={() => {
                      setSelected(hit);
                      setQuery(hit.name);
                      setResults([]);
                    }}
                  >
                    <span class="mc-client-result__name">{hit.name}</span>
                    <span class="mc-client-result__phone">{hit.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

interface DetailResponse {
  request: EstimateRequest;
  activity: ActivityEntry[];
}

interface DetailProps extends RoutableProps {
  id?: string;
}

// Legal forward targets from a given stage (for the "Advance" control).
function forwardTargets(status: EstimateRequestStatus): EstimateRequestStatus[] {
  const order: EstimateRequestStatus[] = [
    "new_request",
    "appointment_set",
    "visit_done",
    "building",
    "sent",
    "follow_up",
  ];
  const i = order.indexOf(status);
  if (i === -1) return [];
  return order.slice(i + 1); // strictly forward; won/lost handled separately
}

export function EstimateRequestDetail({ id }: DetailProps) {
  const { data, loading, error, refetch } = useApi<DetailResponse>(
    id ? `/api/estimate-requests/${id}` : null,
  );
  const toast = useToast();
  const tier = useViewportTier();
  const [visitLayout, setVisitLayout] = useState<"redesigned" | "legacy">("redesigned");
  const [requestDetailsOpen, setRequestDetailsOpen] = useState(false);
  const r = data?.request;

  useEffect(() => {
    api
      .get<{ setting: { value: string } }>("/api/settings/visit_capture_layout")
      .then((res) => {
        const v = (res.setting?.value ?? "redesigned").toLowerCase();
        setVisitLayout(v === "legacy" ? "legacy" : "redesigned");
      })
      .catch(() => setVisitLayout("redesigned"));
  }, []);
  const { data: estData } = useApi<{ estimate: Estimate }>(
    r?.estimate_id ? `/api/estimates/${r.estimate_id}` : null,
  );
  const estimate = estData?.estimate;

  const [notes, setNotes] = useState("");
  const [scopeDraft, setScopeDraft] = useState<ScopeDraftItem[] | null>(null);
  const [draftGenerating, setDraftGenerating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [hasGeneratedDraft, setHasGeneratedDraft] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const voiceSupported =
    typeof window !== "undefined" &&
    (nativeAudioRecorderAvailable() || webMediaRecorderSupported());
  const [apptOpen, setApptOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [wonOpen, setWonOpen] = useState(false);
  const [reviewDateEdit, setReviewDateEdit] = useState(false);
  const [reviewDateVal, setReviewDateVal] = useState("");
  const [reviewTimeVal, setReviewTimeVal] = useState("");
  const [sketchModalOpen, setSketchModalOpen] = useState(false);
  const [sketchCount, setSketchCount] = useState(0);
  const [firstSketchId, setFirstSketchId] = useState<string | null>(null);
  const [linkClientOpen, setLinkClientOpen] = useState(false);
  const [linkClientPath, setLinkClientPath] = useState<"create" | "search">("create");
  const [visitPhotos, setVisitPhotos] = useState<
    { id: string; thumb_url: string; original_url: string }[]
  >([]);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [viewPhoto, setViewPhoto] = useState<{
    id: string;
    thumb_url: string;
    original_url: string;
  } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const prevStatusRef = useRef<EstimateRequestStatus | null>(null);

  const loadVisitPhotos = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<{
        photos: { id: string; thumb_url: string; original_url: string }[];
      }>(`/api/estimate-requests/${id}/photos`);
      setVisitPhotos(res.photos ?? []);
    } catch {
      setVisitPhotos([]);
    }
  }, [id]);

  useEffect(() => {
    setNotes(r?.visit_notes ?? "");
  }, [r?.id, r?.visit_notes]);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ sketches: SketchMeta[] }>(`/api/estimate-requests/${id}/sketches`)
      .then((res) => {
        setSketchCount(res.sketches.length);
        setFirstSketchId(res.sketches[0]?.id ?? null);
      })
      .catch(() => {
        setSketchCount(0);
        setFirstSketchId(null);
      });
  }, [id, sketchModalOpen]);

  useEffect(() => {
    void loadVisitPhotos();
  }, [loadVisitPhotos]);

  useEffect(() => {
    if (r?.scope_draft && r.scope_draft.length > 0) {
      setScopeDraft(r.scope_draft);
    } else if (r && !r.scope_draft) {
      setScopeDraft(null);
    }
  }, [r?.id, r?.scope_draft]);

  // Sync review date edit state when record changes.
  useEffect(() => {
    if (!reviewDateEdit) {
      const iso = r?.proposal_review_date ?? "";
      if (iso) {
        const d = new Date(iso.includes("T") ? iso : iso + "Z");
        if (!isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          setReviewDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
          setReviewTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
          return;
        }
      }
      setReviewDateVal("");
      setReviewTimeVal("");
    }
  }, [r?.id, r?.proposal_review_date, reviewDateEdit]);

  const saveReviewDate = () => {
    if (!reviewDateVal) return;
    const iso = reviewTimeVal
      ? new Date(`${reviewDateVal}T${reviewTimeVal}`).toISOString()
      : new Date(`${reviewDateVal}T00:00:00`).toISOString();
    void patch({ proposal_review_date: iso }, "Proposal review date saved");
    setReviewDateEdit(false);
  };

  const clearReviewDate = () => {
    void patch({ proposal_review_date: null }, "Proposal review date cleared");
    setReviewDateEdit(false);
  };

  // Poll for client deposit conversion while estimate is out and not yet won.
  useEffect(() => {
    if (!r || r.status === "won" || r.status === "lost" || !r.estimate_sent) return;
    const poll = window.setInterval(() => void refetch(), 20_000);
    return () => window.clearInterval(poll);
  }, [r?.id, r?.status, r?.estimate_sent]);

  // Auto-navigate when conversion completes while this page is open (not on initial load of won).
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (
      r?.status === "won" &&
      r.converted_job_id &&
      prev &&
      prev !== "won"
    ) {
      go(`/jobs/${r.converted_job_id}`);
    }
    if (r?.status) prevStatusRef.current = r.status;
  }, [r?.status, r?.converted_job_id]);

  const patch = async (body: Record<string, unknown>, successMsg: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}`, body);
      toast.push("success", successMsg);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const saveNotes = (value?: string) => {
    if (!r) return;
    const next = value ?? notes;
    if ((r.visit_notes ?? "") === next) return;
    void patch({ visit_notes: next }, "Visit notes saved");
  };

  const appendTranscriptToNotes = (transcript: string) => {
    const chunk = transcript.trim();
    if (!chunk) {
      toast.push("info", "No speech detected in recording");
      return;
    }
    const next = notes.trim() ? `${notes.trim()}\n${chunk}` : chunk;
    setNotes(next);
    saveNotes(next);
    toast.push("success", "Voice note added");
  };

  const uploadAndTranscribe = async (blob: Blob, mimeType: string) => {
    if (!id) return;
    setTranscribing(true);
    try {
      const form = new FormData();
      const ext = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("wav")
          ? "wav"
          : "m4a";
      form.append("audio", blob, `visit-note.${ext}`);
      form.append("mime_type", mimeType);
      const res = await fetch(`/api/estimate-requests/${id}/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        transcript?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(data.details || data.error || `Transcription failed (${res.status})`);
      }
      appendTranscriptToNotes(data.transcript ?? "");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Transcription failed";
      // WebKit's opaque TypeError for failed fetches — surface a clearer cause.
      const msg =
        raw === "Load failed" || raw === "Failed to fetch"
          ? "Could not upload recording (network/file read failed). Try again."
          : raw;
      toast.push("error", msg);
    } finally {
      setTranscribing(false);
    }
  };

  const startWebMediaRecorder = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    mediaChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) mediaChunksRef.current.push(e.data);
    };
    mediaRecRef.current = rec;
    rec.start();
  };

  const stopWebMediaRecorder = (): Promise<{ blob: Blob; mimeType: string }> =>
    new Promise((resolve, reject) => {
      const rec = mediaRecRef.current;
      if (!rec) {
        reject(new Error("No active recording"));
        return;
      }
      rec.onstop = () => {
        const mimeType = rec.mimeType || "audio/webm";
        const blob = new Blob(mediaChunksRef.current, { type: mimeType });
        mediaChunksRef.current = [];
        mediaRecRef.current = null;
        for (const track of rec.stream.getTracks()) track.stop();
        resolve({ blob, mimeType });
      };
      rec.stop();
    });

  const toggleRecording = async () => {
    if (transcribing) return;

    if (recording) {
      setRecording(false);
      try {
        if (isNativePlatform() && nativeAudioRecorderAvailable()) {
          const { blob, mimeType } = await stopNativeAudioRecording();
          await uploadAndTranscribe(blob, mimeType);
        } else {
          const { blob, mimeType } = await stopWebMediaRecorder();
          await uploadAndTranscribe(blob, mimeType);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Stop recording failed";
        if (/permission|denied/i.test(raw)) setMicDenied(true);
        const msg =
          raw === "Load failed" || raw === "Failed to fetch"
            ? "Could not read recording file. Try again."
            : raw;
        toast.push("error", msg);
      }
      return;
    }

    setMicDenied(false);
    try {
      if (isNativePlatform() && nativeAudioRecorderAvailable()) {
        await startNativeAudioRecording();
      } else {
        await startWebMediaRecorder();
      }
      setRecording(true);
    } catch (err) {
      void cancelNativeAudioRecording();
      const msg = err instanceof Error ? err.message : "Could not start recording";
      if (/permission|denied|NotAllowed/i.test(msg)) setMicDenied(true);
      else toast.push("error", msg);
    }
  };

  /** Discard in-progress recording without uploading (Record modal dismiss). */
  const cancelRecording = () => {
    if (!recording) return;
    setRecording(false);
    if (isNativePlatform() && nativeAudioRecorderAvailable()) {
      void cancelNativeAudioRecording();
      return;
    }
    const rec = mediaRecRef.current;
    mediaRecRef.current = null;
    mediaChunksRef.current = [];
    if (rec) {
      try {
        for (const track of rec.stream.getTracks()) track.stop();
        rec.onstop = null;
        rec.stop();
      } catch {
        /* ignore */
      }
    }
  };

  const uploadVisitPhotoBlobs = async (files: Blob[]) => {
    if (!id || !files.length || photoUploading) return;
    setPhotoUploading(true);
    try {
      for (const file of files) {
        await uploadPhoto(file, {
          estimate_request_id: id,
          photo_type: "estimate_visit",
        }, { withGps: true });
      }
      toast.push("success", files.length === 1 ? "Photo added" : `${files.length} photos added`);
      await loadVisitPhotos();
    } catch (err) {
      toast.push("error", err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const onVisitPhotosSelected = async (files: FileList | null) => {
    if (!files?.length) return;
    await uploadVisitPhotoBlobs(Array.from(files));
  };

  /** Native: Capacitor Camera (PROMPT). Web: hidden file input. */
  const onPhotosButtonClick = async () => {
    if (photoUploading) return;
    if (isNativePlatform()) {
      try {
        const blob = await capturePhotoNative();
        if (blob) await uploadVisitPhotoBlobs([blob]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // User cancelled the prompt — not an error.
        if (/cancel/i.test(msg)) return;
        toast.push("error", msg || "Camera failed");
      }
      return;
    }
    photoInputRef.current?.click();
  };

  const deleteVisitPhoto = async (photoId: string) => {
    try {
      await api.del(`/api/photos/${photoId}`);
      setVisitPhotos((prev) => prev.filter((p) => p.id !== photoId));
      toast.push("success", "Photo removed");
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Failed to remove photo");
    }
  };

  const generateScopeDraft = async () => {
    if (!id) return;
    const trimmed = notes.trim();
    if (!trimmed && sketchCount === 0 && visitPhotos.length === 0) {
      setDraftError("Add visit notes, a sketch, or photos before generating a scope draft.");
      return;
    }
    setDraftError(null);
    setDraftGenerating(true);
    try {
      const res = await api.post<{ draft: ScopeDraftItem[]; generated_at: string }>(
        `/api/estimate-requests/${id}/scope-draft`,
      );
      setScopeDraft(res.draft);
      setHasGeneratedDraft(true);
    } catch (err) {
      setDraftError("Scope draft generation failed. Check visit notes and try again.");
      if (err instanceof ApiError && err.details) {
        console.warn("[scope-draft]", err.details);
      }
    } finally {
      setDraftGenerating(false);
    }
  };

  const regenerateScopeDraft = async () => {
    if (!id) return;
    setDraftError(null);
    setDraftGenerating(true);
    try {
      await api.del(`/api/estimate-requests/${id}/scope-draft`);
      const res = await api.post<{ draft: ScopeDraftItem[] }>(
        `/api/estimate-requests/${id}/scope-draft`,
      );
      setScopeDraft(res.draft);
      setHasGeneratedDraft(true);
    } catch {
      setDraftError("Scope draft generation failed. Check visit notes and try again.");
    } finally {
      setDraftGenerating(false);
    }
  };

  const patchScopeDraftItem = async (itemIndex: number, updates: Record<string, unknown>) => {
    if (!id || !scopeDraft) return;
    try {
      const res = await api.patch<{ draft: ScopeDraftItem[] }>(
        `/api/estimate-requests/${id}/scope-draft`,
        { item_index: itemIndex, updates },
      );
      setScopeDraft(res.draft);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  // Appointment + lost use dedicated endpoints (PUT /:id/appointment, /:id/lost).
  const apptCall = async (body: Record<string, unknown>, successMsg: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}/appointment`, body);
      toast.push("success", successMsg);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const markLost = async (reason: string, lostNotes: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}/lost`, {
        lost_reason: reason,
        lost_notes: lostNotes,
      });
      toast.push("success", "Marked as lost");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (loading) return <Spinner center />;
  if (error || !r) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <div class="empty-state__title">Request not found</div>
        <div>{error ?? "This estimate request doesn't exist."}</div>
        <div class="mt-md">
          <Button variant="secondary" onClick={() => go("/estimating")}>
            Back to pipeline
          </Button>
        </div>
      </div>
    );
  }

  const fullAddress = [r.property_address, r.property_city, r.property_state, r.property_zip]
    .filter(Boolean)
    .join(", ");
  const targets = forwardTargets(r.status);
  const terminal = r.status === "won" || r.status === "lost";
  const thinClient = needsRealClient(r);
  const displayEmail =
    r.client_email && !isPlaceholderEmail(r.client_email) ? r.client_email : null;
  const useRedesign =
    visitLayout === "redesigned" && (tier === "mobile" || tier === "tablet");

  const visitCaptureProps = {
    requestId: r.id,
    notes,
    onNotesInput: setNotes,
    onNotesBlur: () => saveNotes(),
    recording,
    transcribing,
    micDenied,
    voiceSupported,
    onDismissMicDenied: () => setMicDenied(false),
    onToggleRecording: () => void toggleRecording(),
    onOpenAppSettings: () => void openAppSettings(),
    sketchCount,
    firstSketchId,
    sketchModalOpen,
    onOpenSketch: () => setSketchModalOpen(true),
    visitPhotos,
    photoUploading,
    photoInputRef,
    onPhotosButtonClick: () => void onPhotosButtonClick(),
    onVisitPhotosSelected: (files: FileList | null) => void onVisitPhotosSelected(files),
    onViewPhoto: setViewPhoto,
    onDeletePhoto: (photoId: string) => void deleteVisitPhoto(photoId),
    draftGenerating,
    draftError,
    hasGeneratedDraft,
    hasScopeDraft: Boolean(scopeDraft && scopeDraft.length > 0),
    onGenerateScopeDraft: () => void generateScopeDraft(),
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <h1 class="view-title">
              {r.client_id ? (
                <a
                  href={`/app/clients/${r.client_id}`}
                  style={{ color: "inherit", textDecoration: "underline", textDecorationColor: "var(--color-border)", textUnderlineOffset: "2px" }}
                  onClick={(e) => { e.preventDefault(); go(`/clients/${r.client_id}`); }}
                >
                  {r.client_name}
                </a>
              ) : r.client_name}
            </h1>
            <span class={`er-status pipeline-col--${r.status}`}>{formatStatus(r.status)}</span>
            {r.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
          </div>
          <p class="view-subtitle">
            REQ-{String(r.request_number).padStart(3, "0")} · {fullAddress}
          </p>
        </div>
        <div class="view-header__right flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          {canDeleteRequest(r) && <DeleteRequestButton request={r} size="sm" />}
          <Button variant="tertiary" onClick={() => go("/estimating")}>
            ← Pipeline
          </Button>
        </div>
      </div>

      {useRedesign && (
        <div class="stack" style={{ marginBottom: "var(--space-md)" }}>
          <VisitCaptureRedesign
            {...visitCaptureProps}
            onCancelRecording={cancelRecording}
          />
          {scopeDraft && scopeDraft.length > 0 && (
            <ScopeDraftSection
              draft={scopeDraft}
              generating={draftGenerating}
              onRegenerate={() => void regenerateScopeDraft()}
              onPatchItem={patchScopeDraftItem}
            />
          )}
        </div>
      )}

      {useRedesign && (
        <div class="request-details" style={{ marginBottom: "var(--space-md)" }}>
          <button
            type="button"
            class="request-details__toggle"
            aria-expanded={requestDetailsOpen}
            onClick={() => setRequestDetailsOpen((v) => !v)}
          >
            <span aria-hidden="true">{requestDetailsOpen ? "▾" : "▸"}</span>
            Request details
          </button>
        </div>
      )}

      <div hidden={useRedesign && !requestDetailsOpen}>
      <div class="detail-grid">
        <div class="stack">
          <Card title="Overview">
            {thinClient && (
              <div
                class="flex items-center justify-between gap-sm"
                style={{
                  flexWrap: "wrap",
                  marginBottom: "var(--space-md)",
                  padding: "var(--space-sm) var(--space-md)",
                  background: "var(--color-warning-bg, var(--color-surface-2))",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <span style={{ fontSize: "var(--text-sm)" }}>
                  {!r.client_id
                    ? "No client linked yet — create one from this lead’s contact info when you’re ready."
                    : `This lead needs a real client — HighLevel only had a phone${
                        r.property_address === "Unknown" ? " and no property address" : ""
                      }.`}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setLinkClientPath("create");
                    setLinkClientOpen(true);
                  }}
                >
                  Create Client
                </Button>
              </div>
            )}
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Job Type</span>
                <span class="kv__value">{jobTypeDisplayLabel(r.job_type, r.job_type_detail)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Lead Source</span>
                <span class="kv__value">
                  {formatStatus(r.lead_source)}
                  {r.lead_source_detail ? ` · ${r.lead_source_detail}` : ""}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Client Phone</span>
                <span class="kv__value">{r.client_phone ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Email</span>
                <span class="kv__value">
                  {displayEmail ?? (
                    <span class="text--muted">
                      {isPlaceholderEmail(r.client_email)
                        ? "Not captured from HighLevel"
                        : "—"}
                    </span>
                  )}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Property</span>
                <span class="kv__value">{fullAddress}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Days in Stage</span>
                <span class="kv__value">{r.days_in_stage}</span>
              </div>
            </div>
            {!thinClient && r.client_id && (
              <div style={{ marginTop: "var(--space-md)" }}>
                <button
                  type="button"
                  class="link-btn"
                  style={{ fontSize: "var(--text-sm)" }}
                  onClick={() => {
                    setLinkClientPath("search");
                    setLinkClientOpen(true);
                  }}
                >
                  Change client
                </button>
              </div>
            )}
          </Card>

          <Card title="Appointment">
            {r.appointment_date ? (
              <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
                <div>
                  <div>{formatDateTime(r.appointment_date)}</div>
                  <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                    {r.appointment_completed ? "Completed" : "Scheduled"}
                  </div>
                </div>
                <div class="flex gap-sm">
                  <Button size="sm" variant="secondary" onClick={() => setApptOpen(true)}>
                    Reschedule
                  </Button>
                  {!r.appointment_completed && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void apptCall({ appointment_completed: true }, "Appointment marked complete")
                      }
                    >
                      Mark Complete
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div class="flex items-center justify-between gap-sm">
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  No appointment set.
                </span>
                <Button size="sm" variant="primary" onClick={() => setApptOpen(true)}>
                  Set Appointment
                </Button>
              </div>
            )}
          </Card>

          <Card title="📅 Proposal Review">
            {reviewDateEdit ? (
              <div class="stack" style={{ gap: "var(--space-sm)" }}>
                <div class="form-row">
                  <FormField label="Date">
                    <input
                      class="form-input"
                      type="date"
                      value={reviewDateVal}
                      onInput={(e) => setReviewDateVal((e.target as HTMLInputElement).value)}
                    />
                  </FormField>
                  <FormField label="Time (optional)">
                    <input
                      class="form-input"
                      type="time"
                      value={reviewTimeVal}
                      onInput={(e) => setReviewTimeVal((e.target as HTMLInputElement).value)}
                    />
                  </FormField>
                </div>
                <div class="flex gap-sm">
                  <Button size="sm" variant="primary" disabled={!reviewDateVal} onClick={saveReviewDate}>
                    Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setReviewDateEdit(false)}>
                    Cancel
                  </Button>
                  {r.proposal_review_date && (
                    <Button size="sm" variant="danger" onClick={clearReviewDate}>
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            ) : r.proposal_review_date ? (
              <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
                <div>
                  <div
                    style={{
                      color: new Date(r.proposal_review_date) < new Date()
                        ? "var(--color-text-muted)"
                        : undefined,
                    }}
                  >
                    {formatDateTime(r.proposal_review_date)}
                  </div>
                  {new Date(r.proposal_review_date) < new Date() && (
                    <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                      Review date has passed
                    </div>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => setReviewDateEdit(true)}>
                  Edit
                </Button>
              </div>
            ) : (
              <div class="flex items-center justify-between gap-sm">
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  Not scheduled
                </span>
                <Button size="sm" variant="primary" onClick={() => setReviewDateEdit(true)}>
                  Schedule
                </Button>
              </div>
            )}
          </Card>

          {!useRedesign && <VisitCaptureLegacy {...visitCaptureProps} />}

          {!useRedesign && scopeDraft && scopeDraft.length > 0 && (
            <ScopeDraftSection
              draft={scopeDraft}
              generating={draftGenerating}
              onRegenerate={() => void regenerateScopeDraft()}
              onPatchItem={patchScopeDraftItem}
            />
          )}

          <Card title="Estimate">
            <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
              {estimate ? (
                <div>
                  <div class="flex items-center gap-sm">
                    <span style={{ fontWeight: "var(--weight-semibold)" }}>
                      EST-{String(estimate.estimate_number ?? 0).padStart(3, "0")}
                      {estimate.version > 1 ? ` · v${estimate.version}` : ""}
                    </span>
                    <Badge
                      tone={
                        estimate.status === "sent"
                          ? "info"
                          : estimate.status === "approved" || estimate.status === "signed"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {formatStatus(estimate.status)}
                    </Badge>
                  </div>
                  <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                    {formatCurrency(estimate.total)}
                    {estimate.deposit_amount
                      ? ` · deposit ${formatCurrency(estimate.deposit_amount)}`
                      : ""}
                  </div>
                </div>
              ) : (
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  {r.estimate_id ? "Estimate started." : "No estimate built yet."}
                </span>
              )}
              <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
                {canDeleteEstimate(estimate) &&
                  !r.converted_job_id &&
                  r.status !== "won" &&
                  r.status !== "lost" && (
                    <DeleteEstimateButton estimate={estimate!} size="sm" onDeleted={refetch} />
                  )}
                <Button
                  variant="primary"
                  onClick={() => {
                    if (!r.client_id && !(estimate || r.estimate_id)) {
                      setLinkClientPath("create");
                      setLinkClientOpen(true);
                      toast.push("info", "Create or link a client before building an estimate");
                      return;
                    }
                    go(`/estimating/${r.id}/estimate`);
                  }}
                >
                  {estimate || r.estimate_id ? "Open Estimate" : "Build Estimate"}
                </Button>
              </div>
            </div>
            {estimate && estimate.portal_path && (
              <EstimateClientProgress estimate={estimate} />
            )}
          </Card>

          <FollowUpSequenceCard request={r} />

          {canDeleteRequest(r) && (
            <Card title="Danger zone">
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-sm)" }}>
                Permanently remove this request from the pipeline, including any estimate, payment
                schedule, and client quote link.
              </p>
              <DeleteRequestButton request={r} />
            </Card>
          )}
        </div>

        <div class="stack">
          <Card title="Stage">
            <div class="stack">
              {!terminal && targets.length > 0 && (
                <FormField label="Advance to">
                  <Select
                    value=""
                    placeholder="Select stage…"
                    options={targets.map((t) => ({
                      value: t,
                      label: stageLabel(t),
                    }))}
                    onChange={(v) =>
                      v && patch({ status: v }, `Moved to ${formatStatus(v)}`)
                    }
                  />
                </FormField>
              )}
              {!terminal && (
                <span
                  style={{ display: "block" }}
                  title={r.estimate_sent ? undefined : ESTIMATE_SENT_TOOLTIP}
                >
                  <Button
                    variant="primary"
                    block
                    disabled={!r.estimate_sent}
                    onClick={() => setWonOpen(true)}
                  >
                    Mark as Won
                  </Button>
                </span>
              )}
              {!terminal && (
                <Button variant="danger" block onClick={() => setLostOpen(true)}>
                  Mark Lost
                </Button>
              )}
              {r.status === "won" && (
                <div class="stack" style={{ gap: "var(--space-sm)" }}>
                  <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                    Won — converted to a job. This request is closed on the estimating board.
                  </div>
                  {r.converted_job_id && (
                    <Button variant="primary" block onClick={() => go(`/jobs/${r.converted_job_id}`)}>
                      Go to Job →
                    </Button>
                  )}
                </div>
              )}
              {r.status === "lost" && r.lost_reason && (
                <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                  Lost: {formatStatus(r.lost_reason)}
                  {r.lost_notes ? ` — ${r.lost_notes}` : ""}
                </div>
              )}
            </div>
          </Card>

          {scopeDraft && scopeDraft.length > 0 && (
            <ScopeSummaryCard
              requestId={r.id}
              draft={scopeDraft}
              onDraftUpdate={setScopeDraft}
            />
          )}

          <Card title="Activity Log">
            {data!.activity.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                No activity yet.
              </p>
            ) : (
              <div class="timeline">
                {data!.activity.map((a) => (
                  <div key={a.id} class="timeline__item">
                    <span class="timeline__dot" />
                    <div class="timeline__content">
                      <div class="timeline__summary">{formatStatus(a.action.replace(/^estimate_request_/, ""))}</div>
                      <div class="timeline__meta">
                        {a.user_email} · {formatDateTime(a.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
      </div>

      <AppointmentModal
        open={apptOpen}
        initial={r.appointment_date}
        initialTime={(r as any).appointment_time ?? null}
        onClose={() => setApptOpen(false)}
        onSave={(date, time) => {
          setApptOpen(false);
          void apptCall({ appointment_date: date, appointment_time: time }, "Appointment set");
        }}
      />

      <LostModal
        open={lostOpen}
        onClose={() => setLostOpen(false)}
        onSave={(reason, lostNotes) => {
          setLostOpen(false);
          void markLost(reason, lostNotes);
        }}
      />

      <MarkWonModal
        request={wonOpen ? r : null}
        onClose={() => setWonOpen(false)}
        onWon={() => {
          setWonOpen(false);
          refetch();
        }}
      />

      {sketchModalOpen && r && (
        <SketchModal requestId={r.id} onClose={() => setSketchModalOpen(false)} />
      )}

      <LinkClientModal
        open={linkClientOpen}
        onClose={() => setLinkClientOpen(false)}
        onLinked={() => refetch()}
        request={r}
        defaultPath={linkClientPath}
      />

      <Modal
        open={!!viewPhoto}
        title="Visit photo"
        onClose={() => setViewPhoto(null)}
      >
        {viewPhoto && (
          <img
            class="visit-capture__photo-full"
            src={viewPhoto.original_url}
            alt="Visit photo"
          />
        )}
      </Modal>
    </div>
  );
}

function stageLabel(key: EstimateRequestStatus): string {
  return PIPELINE_STAGES.find((s) => s.key === key)?.label ?? formatStatus(key);
}

function AppointmentModal({
  open,
  initial,
  initialTime,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string | null;
  initialTime: string | null;
  onClose: () => void;
  onSave: (date: string, time: string | null) => void;
}) {
  const [dateVal, setDateVal] = useState("");
  const [timeVal, setTimeVal] = useState("");

  useEffect(() => {
    if (initial) {
      const d = new Date(initial.includes("T") ? initial : initial + "T00:00:00");
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        setDateVal(
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        );
      } else {
        setDateVal(initial.slice(0, 10));
      }
    } else {
      setDateVal("");
    }
    setTimeVal(initialTime ?? "");
  }, [initial, initialTime, open]);

  return (
    <Modal
      open={open}
      title="Set Appointment"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dateVal} onClick={() => onSave(dateVal, timeVal || null)}>
            Save
          </Button>
        </>
      }
    >
      <FormField label="Appointment Date" required>
        <input
          class="form-input"
          type="date"
          value={dateVal}
          onInput={(e) => setDateVal((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Appointment Time (optional)">
        <input
          class="form-input"
          type="time"
          value={timeVal}
          onInput={(e) => setTimeVal((e.target as HTMLInputElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// ─── Follow-Up Sequence Card (Sprint 26) ─────────────────────────────────────

function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function FollowUpSequenceCard({ request: r }: { request: import("../../types").EstimateRequest }) {
  // Only show the card when the estimate has been sent or is in follow-up/terminal.
  const relevant = ["sent", "viewed", "follow_up", "won", "lost"].includes(r.status) || r.follow_up_count > 0;
  if (!relevant) return null;

  const count = r.follow_up_count ?? 0;

  type BadgeTone = "success" | "warning" | "error" | "neutral";
  let statusLabel: string;
  let tone: BadgeTone;

  if (r.status === "won") {
    statusLabel = "Stopped — Won";
    tone = "success";
  } else if (r.status === "lost") {
    statusLabel = "Stopped — Lost";
    tone = "neutral";
  } else if (r.follow_up_sequence_active) {
    statusLabel = "Active";
    tone = "success";
  } else if (count >= 4) {
    statusLabel = "Complete";
    tone = "neutral";
  } else if (count === 0 && !r.sent_date) {
    statusLabel = "Not Started";
    tone = "neutral";
  } else if (r.follow_up_completed_at) {
    statusLabel = "Complete";
    tone = "neutral";
  } else {
    statusLabel = "Not Started";
    tone = "neutral";
  }

  return (
    <Card title="Follow-Up Sequence">
      <div class="kv">
        <div class="kv__row">
          <span class="kv__label">Status</span>
          <span class="kv__value">
            <Badge tone={tone}>{statusLabel}</Badge>
          </span>
        </div>
        <div class="kv__row">
          <span class="kv__label">Touches Sent</span>
          <span class="kv__value">{count} of 4</span>
        </div>
        <div class="kv__row">
          <span class="kv__label">Last Sent</span>
          <span class="kv__value">{formatDateLong(r.last_follow_up_date)}</span>
        </div>
        {!r.follow_up_sequence_active && r.follow_up_completed_at && (
          <div class="kv__row">
            <span class="kv__label">Completed</span>
            <span class="kv__value">{formatDateLong(r.follow_up_completed_at)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function LostModal({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (reason: string, notes: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (open) {
      setReason("");
      setNotes("");
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title="Mark as Lost"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!reason} onClick={() => onSave(reason, notes)}>
            Mark Lost
          </Button>
        </>
      }
    >
      <FormField label="Reason" required>
        <Select
          value={reason}
          placeholder="Select a reason…"
          options={LOST_REASONS.map((x) => ({ value: x, label: formatStatus(x) }))}
          onChange={setReason}
        />
      </FormField>
      <FormField label="Notes">
        <textarea
          class="form-textarea"
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// Compact client-link + progress shown on the request detail's Estimate card.
function EstimateClientProgress({ estimate }: { estimate: Estimate }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const link = estimate.portal_path ? `${window.location.origin}${estimate.portal_path}` : null;

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.push("success", "Client link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push("error", "Couldn't copy — select and copy manually.");
    }
  };

  const steps = [
    { label: "Sent", done: ["sent", "viewed", "approved", "signed"].includes(estimate.status) },
    { label: "Viewed", done: !!estimate.viewed_date || ["viewed", "approved", "signed"].includes(estimate.status) },
    { label: "Signed", done: estimate.signed },
    { label: "Deposit Paid", done: estimate.status === "approved" },
  ];

  return (
    <div class="stack" style={{ marginTop: "var(--space-md)" }}>
      <div class="quote-progress">
        {steps.map((s, i) => (
          <div key={i} class={`quote-progress__step${s.done ? " is-done" : ""}`}>
            <span class="quote-progress__dot">{s.done ? "✓" : i + 1}</span>
            <span class="quote-progress__label">{s.label}</span>
          </div>
        ))}
      </div>
      {link && (
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <input
            class="form-input"
            style={{ flex: "1", minWidth: "220px", fontSize: "var(--text-sm)" }}
            readOnly
            value={link}
            onFocus={(ev) => (ev.target as HTMLInputElement).select()}
          />
          <Button
            variant="secondary"
            onClick={() => window.open(link, "_blank", "noopener,noreferrer")}
          >
            Open ↗
          </Button>
          <Button variant="secondary" onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
        </div>
      )}
    </div>
  );
}
