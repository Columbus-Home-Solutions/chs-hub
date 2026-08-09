import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { isNativePlatform } from "../../lib/native";
import type { VisitCaptureSharedProps } from "./visitCaptureTypes";

function Icon({ name }: { name: string }) {
  return <i class={`ti ti-${name}`} aria-hidden="true" />;
}

/** Original Visit Capture card — kept fully intact as the toggle fallback. */
export function VisitCaptureLegacy(props: VisitCaptureSharedProps) {
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

  return (
    <Card
      title="Visit Capture"
      actions={
        <div class="visit-capture__actions flex gap-sm">
          {voiceSupported && (
            <Button
              size="sm"
              variant={recording || transcribing ? "danger" : "secondary"}
              disabled={transcribing}
              onClick={() => void onToggleRecording()}
            >
              <Icon name="microphone" />{" "}
              {transcribing ? "Transcribing…" : recording ? "Stop recording" : "Record"}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onOpenSketch}>
            <Icon name="pencil" /> Draw{sketchCount > 0 ? ` ${sketchCount}` : ""}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={photoUploading}
            onClick={() => void onPhotosButtonClick()}
          >
            <Icon name="camera" />{" "}
            {photoUploading
              ? "Uploading…"
              : `Photos${visitPhotos.length > 0 ? ` ${visitPhotos.length}` : ""}`}
          </Button>
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
        </div>
      }
    >
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
      <textarea
        class={`form-textarea${recording ? " visit-capture__textarea--recording" : ""}`}
        placeholder={
          recording
            ? "Recording… tap Stop when finished"
            : transcribing
              ? "Transcribing voice note…"
              : "Notes from the estimate visit…"
        }
        value={notes}
        onInput={(e) => onNotesInput((e.target as HTMLTextAreaElement).value)}
        onBlur={onNotesBlur}
      />
      {micDenied && (
        <div class="visit-capture__alert callout callout--warning">
          <span>
            {isNativePlatform()
              ? "Microphone access was denied. Enable Microphone (and Speech Recognition) for CHS Hub in Settings."
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
      <div class="visit-capture__footer">
        <span class="text--muted visit-capture__hint">Saved when you click away</span>
        <div class="visit-capture__draft-actions">
          {draftError && <span class="visit-capture__error text--error">{draftError}</span>}
          <Button
            size="sm"
            variant="primary"
            disabled={draftGenerating}
            onClick={() => void onGenerateScopeDraft()}
          >
            <Icon name="wand" />{" "}
            {draftGenerating
              ? "Generating…"
              : hasScopeDraft || hasGeneratedDraft
                ? "Regenerate scope draft"
                : "Build scope draft"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
