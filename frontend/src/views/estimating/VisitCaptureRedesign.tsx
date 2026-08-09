import { useEffect, useRef, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { isNativePlatform } from "../../lib/native";
import { VisitRecordModal } from "./VisitRecordModal";
import type { VisitCaptureSharedProps } from "./visitCaptureTypes";

function Icon({ name }: { name: string }) {
  return <i class={`ti ti-${name}`} aria-hidden="true" />;
}

/** Phone/tablet hero Visit Capture — tiles, notes, Build Scope Draft, Record modal. */
export function VisitCaptureRedesign(
  props: VisitCaptureSharedProps & {
    onCancelRecording: () => void;
  },
) {
  const {
    requestId,
    notes,
    onNotesInput,
    onNotesBlur,
    recording,
    transcribing,
    micDenied,
    voiceSupported,
    onDismissMicDenied,
    onToggleRecording,
    onOpenAppSettings,
    onCancelRecording,
    sketchCount,
    firstSketchId,
    sketchModalOpen,
    onOpenSketch,
    visitPhotos,
    photoUploading,
    photoInputRef,
    onPhotosButtonClick,
    onVisitPhotosSelected,
    onViewPhoto,
    onDeletePhoto,
    draftGenerating,
    draftError,
    hasGeneratedDraft,
    hasScopeDraft,
    onGenerateScopeDraft,
  } = props;

  const [recordOpen, setRecordOpen] = useState(false);
  const wasTranscribing = useRef(false);

  // Close Record modal once transcription finishes after a stop.
  useEffect(() => {
    if (transcribing) {
      wasTranscribing.current = true;
      return;
    }
    if (wasTranscribing.current && !recording && recordOpen) {
      wasTranscribing.current = false;
      setRecordOpen(false);
    }
  }, [transcribing, recording, recordOpen]);

  const closeRecordModal = () => {
    if (transcribing) return;
    if (recording) onCancelRecording();
    setRecordOpen(false);
  };

  return (
    <>
      <Card title="Visit Capture">
        <div class="visit-capture-hero__tiles" role="group" aria-label="Visit capture actions">
          <button
            type="button"
            class={`visit-capture-hero__tile${recording || transcribing ? " visit-capture-hero__tile--live" : ""}`}
            disabled={!voiceSupported || transcribing}
            onClick={() => setRecordOpen(true)}
          >
            <span class="visit-capture-hero__tile-icon" aria-hidden="true">
              <Icon name="microphone" />
            </span>
            <span class="visit-capture-hero__tile-label">Record</span>
            {(recording || transcribing) && (
              <span class="visit-capture-hero__badge">
                {transcribing ? "…" : "Live"}
              </span>
            )}
          </button>

          <button type="button" class="visit-capture-hero__tile" onClick={onOpenSketch}>
            <span class="visit-capture-hero__tile-icon" aria-hidden="true">
              <Icon name="pencil" />
            </span>
            <span class="visit-capture-hero__tile-label">Draw</span>
            {sketchCount > 0 && (
              <span class="visit-capture-hero__badge">{sketchCount}</span>
            )}
          </button>

          <button
            type="button"
            class="visit-capture-hero__tile"
            disabled={photoUploading}
            onClick={() => void onPhotosButtonClick()}
          >
            <span class="visit-capture-hero__tile-icon" aria-hidden="true">
              <Icon name="camera" />
            </span>
            <span class="visit-capture-hero__tile-label">
              {photoUploading ? "Uploading…" : "Photos"}
            </span>
            {visitPhotos.length > 0 && !photoUploading && (
              <span class="visit-capture-hero__badge">{visitPhotos.length}</span>
            )}
          </button>
        </div>

        {!isNativePlatform() && (
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => void onVisitPhotosSelected((e.target as HTMLInputElement).files)}
          />
        )}

        {(visitPhotos.length > 0 || firstSketchId) && (
          <div class="visit-capture-hero__media">
            {visitPhotos.length > 0 && (
              <div class="visit-capture__photos">
                {visitPhotos.map((p) => (
                  <div key={p.id} class="visit-capture__photo">
                    <button
                      type="button"
                      class="visit-capture__photo-open"
                      onClick={() => onViewPhoto(p)}
                      aria-label="View photo"
                    >
                      <img src={p.thumb_url} alt="Visit photo" />
                    </button>
                    <button
                      type="button"
                      class="visit-capture__photo-remove"
                      aria-label="Remove photo"
                      onClick={() => void onDeletePhoto(p.id)}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {firstSketchId && (
              <img
                key={`${firstSketchId}-${sketchModalOpen ? "open" : "closed"}`}
                class="visit-capture__sketch-thumb"
                src={`/api/estimate-requests/${requestId}/sketches/${firstSketchId}/thumbnail`}
                alt="Sketch preview"
                onClick={onOpenSketch}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
          </div>
        )}

        <textarea
          class={`form-textarea visit-capture-hero__notes${
            recording ? " visit-capture__textarea--recording" : ""
          }`}
          rows={5}
          placeholder={
            recording
              ? "Recording… finish in the Record panel"
              : transcribing
                ? "Transcribing voice note…"
                : "Notes from the estimate visit…"
          }
          value={notes}
          onInput={(e) => onNotesInput((e.target as HTMLTextAreaElement).value)}
          onBlur={onNotesBlur}
        />

        {micDenied && !recordOpen && (
          <div class="visit-capture__alert callout callout--warning">
            <span>
              {isNativePlatform()
                ? "Microphone access was denied. Enable Microphone for CHS Hub in Settings."
                : "Microphone access was denied. Check your browser settings."}
            </span>
            {isNativePlatform() && (
              <Button size="sm" variant="secondary" onClick={() => void onOpenAppSettings()}>
                Open Settings
              </Button>
            )}
            <button
              type="button"
              class="visit-capture__alert-dismiss"
              aria-label="Dismiss"
              onClick={onDismissMicDenied}
            >
              <Icon name="x" />
            </button>
          </div>
        )}

        <div class="visit-capture-hero__draft">
          {draftError && <span class="visit-capture__error text--error">{draftError}</span>}
          <Button
            variant="primary"
            disabled={draftGenerating}
            onClick={() => void onGenerateScopeDraft()}
            style={{ width: "100%", minHeight: "48px", fontSize: "1.05rem" }}
          >
            <Icon name="wand" />{" "}
            {draftGenerating
              ? "Generating…"
              : hasScopeDraft || hasGeneratedDraft
                ? "Regenerate scope draft"
                : "Build Scope Draft"}
          </Button>
          <span class="text--muted visit-capture__hint">Notes save when you tap away</span>
        </div>
      </Card>

      <VisitRecordModal
        open={recordOpen}
        recording={recording}
        transcribing={transcribing}
        micDenied={micDenied}
        voiceSupported={voiceSupported}
        onClose={closeRecordModal}
        onToggleRecording={onToggleRecording}
        onOpenAppSettings={onOpenAppSettings}
        onDismissMicDenied={onDismissMicDenied}
      />
    </>
  );
}
