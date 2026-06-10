import { useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import type { EstimateRequest } from "../../types";

/** Hard-delete an estimate request and any draft/sent estimates attached to it. */
export function DeleteRequestButton({
  request,
  size = "default",
  block,
  onDeleted,
}: {
  request: EstimateRequest;
  size?: "default" | "sm";
  block?: boolean;
  /** When set, called after delete instead of navigating to the pipeline. */
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const label = `REQ-${String(request.request_number).padStart(3, "0")}`;
  const sent = request.estimate_sent;

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/estimate-requests/${request.id}`);
      toast.push("success", "Request deleted");
      setOpen(false);
      if (onDeleted) {
        onDeleted();
      } else {
        go("/estimating");
      }
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
        Delete Request
      </Button>
      <Modal
        open={open}
        title="Delete request"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Yes, delete"}
            </Button>
          </>
        }
      >
        <div class="stack" style={{ gap: "var(--space-sm)" }}>
          <p style={{ margin: 0 }}>
            Permanently delete <strong>{label}</strong> for <strong>{request.client_name}</strong>?
            This removes the request from the pipeline and cannot be undone.
          </p>
          {sent && (
            <p class="text--muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              Any sent estimate and client quote link for this request will also be removed.
            </p>
          )}
          {!sent && request.estimate_id && (
            <p class="text--muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              The in-progress estimate and payment schedule for this request will be deleted.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

export function canDeleteRequest(request: EstimateRequest | null | undefined): boolean {
  if (!request) return false;
  if (request.status === "won") return false;
  if (request.converted_job_id) return false;
  return true;
}
