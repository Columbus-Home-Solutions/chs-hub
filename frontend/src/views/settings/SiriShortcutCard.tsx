import { useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";

const SIRI_SHORTCUT_URL = "https://dashboard.homesolutionsar.com/app/voice-note";

export function SiriShortcutCard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(SIRI_SHORTCUT_URL);
      toast.push("success", "URL copied");
    } catch {
      toast.push("error", "Could not copy — select and copy manually");
    }
  };

  return (
    <>
      <div class="card" style={{ marginBottom: "var(--space-md)" }}>
        <div class="card__body">
          <div class="flex items-center gap-sm">
            <span style={{ fontSize: "1.4rem" }}>🎤</span>
            <strong>Siri Shortcut — Add Job Note</strong>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0" }}>
            Say &ldquo;Hey Siri, make a job note&rdquo; to open CHS New Note capture directly.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Set Up Siri Shortcut
          </Button>
        </div>
      </div>

      {open && (
        <Modal
          open
          title="Setting up your Siri Shortcut"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={copyUrl}>
                Copy URL
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </>
          }
        >
          <ol style={{ lineHeight: 1.7, paddingLeft: "1.25rem", margin: 0 }}>
            <li>Open the Shortcuts app on your iPhone or iPad</li>
            <li>Tap the + button to create a new shortcut</li>
            <li>Tap &ldquo;Add Action&rdquo; → search for &ldquo;Open URLs&rdquo;</li>
            <li>
              Paste this URL:
              <br />
              <code style={{ wordBreak: "break-all", fontSize: "var(--text-sm)" }}>{SIRI_SHORTCUT_URL}</code>
            </li>
            <li>Tap the shortcut name at the top → rename to &ldquo;Make a Job Note&rdquo;</li>
            <li>Tap the settings icon → &ldquo;Add to Siri&rdquo;</li>
            <li>Record your phrase: &ldquo;Make a job note&rdquo;</li>
            <li>Done! Say &ldquo;Hey Siri, make a job note&rdquo; anytime.</li>
          </ol>
        </Modal>
      )}
    </>
  );
}
