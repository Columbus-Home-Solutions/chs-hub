import { useEffect, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { isNativePlatform } from "../../lib/native";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Dedicated Record UI for the redesigned Visit Capture layout.
 * Recording/transcription mechanics stay in the parent (same Capgo + Gemini path).
 */
export function VisitRecordModal({
  open,
  recording,
  transcribing,
  micDenied,
  voiceSupported,
  onClose,
  onToggleRecording,
  onOpenAppSettings,
  onDismissMicDenied,
}: {
  open: boolean;
  recording: boolean;
  transcribing: boolean;
  micDenied: boolean;
  voiceSupported: boolean;
  onClose: () => void;
  onToggleRecording: () => void;
  onOpenAppSettings: () => void;
  onDismissMicDenied: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!open) {
      setElapsed(0);
      return;
    }
    if (!recording) return;
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open, recording]);

  const handleClose = () => {
    if (transcribing) return;
    onClose();
  };

  const statusLabel = !voiceSupported
    ? "Voice capture isn’t available on this device"
    : transcribing
      ? "Transcribing…"
      : recording
        ? "Recording — tap Stop when finished"
        : "Tap the mic to start recording";

  return (
    <Modal open={open} title="Record visit note" onClose={handleClose} size="default">
      <div class="visit-record-modal">
        <p class="visit-record-modal__status">{statusLabel}</p>
        <div class="visit-record-modal__timer" aria-live="polite">
          {recording || transcribing ? formatElapsed(elapsed) : "00:00"}
        </div>

        <button
          type="button"
          class={`visit-record-modal__mic${recording ? " visit-record-modal__mic--live" : ""}${
            transcribing ? " visit-record-modal__mic--busy" : ""
          }`}
          disabled={!voiceSupported || transcribing}
          aria-label={recording ? "Stop recording" : "Start recording"}
          onClick={() => void onToggleRecording()}
        >
          <i class={`ti ti-${recording ? "player-stop-filled" : "microphone"}`} aria-hidden="true" />
        </button>

        {micDenied && (
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
              ✕
            </button>
          </div>
        )}

        <div class="visit-record-modal__actions">
          {recording ? (
            <Button
              variant="danger"
              disabled={transcribing}
              onClick={() => void onToggleRecording()}
              style={{ minWidth: "12rem", minHeight: "48px" }}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={transcribing}
              onClick={handleClose}
              style={{ minWidth: "12rem", minHeight: "48px" }}
            >
              {transcribing ? "Please wait…" : "Done"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
