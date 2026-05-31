import { useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { uploadPhoto, uploadReceipt, type ReceiptResult } from "../../lib/capture";
import { ReceiptConfirm, type PhotoReceipt } from "./PhotosTab";

/**
 * Mobile Quick Capture Bar (Sprint 8). A fixed bottom bar on Job Detail giving
 * one-tap entry into the capture flows: camera photo + receipt scan upload
 * inline, while note/task/log jump to their tab. Hidden on wider screens via the
 * `quick-capture-bar` CSS (display:none ≥ tablet).
 */
export function QuickCaptureBar({
  jobId,
  onNavigate,
  onCaptured,
}: {
  jobId: string;
  onNavigate: (tab: "tasks" | "daily_logs" | "notes") => void;
  onCaptured: () => void;
}) {
  const toast = useToast();
  const photoRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptResult | null>(null);

  const onPhoto = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await uploadPhoto(file, { job_id: jobId, photo_type: "job_progress" }, { withGps: true });
      toast.push("success", "Photo captured");
      onCaptured();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onReceipt = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploadReceipt(file, { job_id: jobId });
      setReceipt(res.receipt);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const receiptAsConfirm: PhotoReceipt | null = receipt
    ? { ...receipt, expense_id: null }
    : null;

  return (
    <>
      <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPhoto} />
      <input ref={receiptRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onReceipt} />

      <nav class="quick-capture-bar" aria-label="Quick capture">
        <button class="qc-btn" disabled={busy} onClick={() => photoRef.current?.click()}>
          <span class="qc-btn__icon">📷</span><span>Photo</span>
        </button>
        <button class="qc-btn" onClick={() => onNavigate("notes")}>
          <span class="qc-btn__icon">🎤</span><span>Note</span>
        </button>
        <button class="qc-btn" onClick={() => onNavigate("tasks")}>
          <span class="qc-btn__icon">✅</span><span>Task</span>
        </button>
        <button class="qc-btn" disabled={busy} onClick={() => receiptRef.current?.click()}>
          <span class="qc-btn__icon">💵</span><span>Receipt</span>
        </button>
        <button class="qc-btn" onClick={() => onNavigate("daily_logs")}>
          <span class="qc-btn__icon">📝</span><span>Log</span>
        </button>
      </nav>

      {busy && (
        <div class="qc-uploading"><Spinner /> <span>Uploading…</span></div>
      )}

      {receiptAsConfirm && (
        <Modal
          open
          title="Confirm receipt"
          onClose={() => setReceipt(null)}
          footer={<Button variant="secondary" onClick={() => setReceipt(null)}>Close</Button>}
        >
          <ReceiptConfirm
            receipt={receiptAsConfirm}
            jobId={jobId}
            onConfirmed={() => { setReceipt(null); onCaptured(); }}
            toast={toast}
          />
        </Modal>
      )}
    </>
  );
}
