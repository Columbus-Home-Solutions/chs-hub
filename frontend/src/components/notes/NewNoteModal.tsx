import { Modal } from "../ui/Modal";
import { NewNoteForm, type NewNoteEnteredVia } from "./NewNoteForm";

export function NewNoteModal({
  open,
  jobId = null,
  enteredVia = "quick_capture",
  onClose,
}: {
  open: boolean;
  jobId?: string | null;
  enteredVia?: NewNoteEnteredVia;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <Modal open title="New Note" onClose={onClose}>
      <NewNoteForm
        initialJobId={jobId}
        enteredVia={enteredVia}
        onSaved={() => onClose()}
      />
    </Modal>
  );
}
