import { useEffect, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";
import { LOST_REASONS, type EstimateRequest } from "../../types";

/** Same lost endpoint and reason list as the lead detail page. */
export function MarkLostButton({
  request,
  size = "default",
  block,
  onLost,
}: {
  request: EstimateRequest;
  size?: "default" | "sm";
  block?: boolean;
  onLost?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setNotes("");
    }
  }, [open]);

  const save = async () => {
    if (!reason) return;
    setBusy(true);
    try {
      await api.put(`/api/estimate-requests/${request.id}/lost`, {
        lost_reason: reason,
        lost_notes: notes,
      });
      toast.push("success", "Marked as lost");
      setOpen(false);
      onLost?.();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size={size === "sm" ? "sm" : undefined}
        block={block}
        variant="danger"
        onClick={() => setOpen(true)}
      >
        Mark Lost
      </Button>
      <Modal
        open={open}
        title="Mark as Lost"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!reason || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Mark Lost"}
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
    </>
  );
}
