/**
 * Standalone New Note page — kept at /app/voice-note for the Siri Shortcut URL
 * (Settings → Integrations). Same form as the + menu New Note modal.
 */

import { useMemo, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { NewNoteForm } from "../../components/notes/NewNoteForm";
import { go } from "../../lib/nav";
import "../../styles/voice-note.css";

const VOICE_NOTE_URL = "https://dashboard.homesolutionsar.com/app/voice-note";

export function VoiceNoteCapture() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const prefilledJobId = query.get("job_id");
  const [saved, setSaved] = useState<{ matched: boolean } | null>(null);

  if (saved) {
    return (
      <div class="voice-capture">
        <div class="voice-capture__saved">
          <div class="voice-capture__saved-icon">✓</div>
          <h1 class="view-title">
            {saved.matched ? "Note saved and linked to a job" : "Note saved"}
          </h1>
          {!saved.matched && (
            <p class="text--muted" style={{ marginBottom: "var(--space-lg)" }}>
              We couldn&apos;t match this note to a job automatically.
            </p>
          )}
          <div class="flex gap-sm justify-center" style={{ flexWrap: "wrap" }}>
            {!saved.matched && (
              <Button variant="primary" onClick={() => go("/voice-notes/unmatched")}>
                Assign a job
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setSaved(null)}
            >
              New note
            </Button>
            <Button variant="tertiary" onClick={() => go("/")}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="voice-capture">
      <div class="voice-capture__header">
        <Button variant="tertiary" onClick={() => (history.length > 1 ? history.back() : go("/"))}>
          ← Back
        </Button>
        <h1 class="view-title" style={{ margin: 0, fontSize: "1.1rem" }}>
          New Note
        </h1>
        <span style={{ width: "4rem" }} />
      </div>

      <NewNoteForm
        initialJobId={prefilledJobId}
        enteredVia="siri"
        onSaved={(result) => setSaved({ matched: result.matched })}
      />
    </div>
  );
}

export { VOICE_NOTE_URL };
