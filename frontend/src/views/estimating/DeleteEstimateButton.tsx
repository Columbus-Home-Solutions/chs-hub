import { useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import type { Estimate } from "../../types";

/**
 * Hard-delete a draft or sent (unconverted) estimate. Blocked once approved /
 * converted to a job — use Mark Lost or delete the job instead.
 */
export function DeleteEstimateButton({
  estimate,
  size = "default",
  onDeleted,
}: {
  estimate: Estimate;
  size?: "default" | "sm";
  /** When set, called after delete instead of navigating away (e.g. request detail refetch). */
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const sent = estimate.status === "sent" || estimate.status === "viewed";

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/estimates/${estimate.id}`);
      toast.push("success", "Estimate deleted");
      setOpen(false);
      if (onDeleted) {
        onDeleted();
      } else if (estimate.request_id) {
        go(`/estimating/${estimate.request_id}`);
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
      <Button size={size === "sm" ? "sm" : undefined} variant="danger" onClick={() => setOpen(true)}>
        Delete Estimate
      </Button>
      <Modal
        open={open}
        title="Delete estimate"
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
            Delete <strong>EST-{String(estimate.estimate_number ?? 0).padStart(3, "0")}</strong>?
            This cannot be undone.
          </p>
          {sent && (
            <p class="text--muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              The client quote link will stop working. You can build and send a fresh estimate from
              this request afterward.
            </p>
          )}
          {!sent && (
            <p class="text--muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              Line items, payment schedule, and any generated contract documents for this estimate
              will be removed. The estimate request stays open so you can start over.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

/** True when this estimate can be hard-deleted (not converted / deposit paid). */
export function canDeleteEstimate(estimate: Estimate | null | undefined): boolean {
  if (!estimate) return false;
  if (estimate.status === "approved") return false;
  if (estimate.linked_job_id) return false;
  return true;
}
