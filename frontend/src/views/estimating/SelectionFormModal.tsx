/**
 * SelectionFormModal — Sprint 38 Run 4.
 *
 * Owner creates an allowance + initial choices for an estimate sub-item.
 * Also supports mid-job creation when jobId is provided instead of estimateId.
 *
 * POST /api/estimates/:id/selections (before estimate is sent)
 * POST /api/jobs/:id/selections (mid-job)
 */

import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";
import { api } from "../../api";

interface Choice {
  title: string;
  price: string;
  description: string;
  vendor_name: string;
}

interface SelectionFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Either estimateId or jobId must be provided */
  estimateId?: string;
  jobId?: string;
  estimateSubItemId?: string;
  defaultTitle?: string;
}

const BLANK_CHOICE: Choice = { title: "", price: "", description: "", vendor_name: "" };

export function SelectionFormModal({
  open,
  onClose,
  onCreated,
  estimateId,
  jobId,
  estimateSubItemId,
  defaultTitle = "",
}: SelectionFormModalProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [category, setCategory] = useState("");
  const [location, setLocation] = useState("");
  const [allowanceAmount, setAllowanceAmount] = useState("");
  const [required, setRequired] = useState(true);
  const [deadlineDate, setDeadlineDate] = useState("");
  const [publicInstructions, setPublicInstructions] = useState("");
  const [choices, setChoices] = useState<Choice[]>([{ ...BLANK_CHOICE }]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addChoice() {
    setChoices((prev) => [...prev, { ...BLANK_CHOICE }]);
  }

  function removeChoice(i: number) {
    setChoices((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateChoice(i: number, field: keyof Choice, value: string) {
    setChoices((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const amount = parseFloat(allowanceAmount);
    if (!title.trim()) { setError("Title is required."); return; }
    if (isNaN(amount) || amount < 0) { setError("Allowance amount must be a positive number."); return; }
    const validChoices = choices.filter(
      (c) => c.title.trim() && !isNaN(parseFloat(c.price)),
    );
    if (validChoices.length === 0) {
      setError("Add at least one choice with a title and price.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const endpoint = estimateId
        ? `/api/estimates/${estimateId}/selections`
        : `/api/jobs/${jobId}/selections`;

      await api.post(endpoint, {
        title: title.trim(),
        category: category.trim() || null,
        location: location.trim() || null,
        allowance_amount: amount,
        required,
        deadline_date: deadlineDate || null,
        public_instructions: publicInstructions.trim() || null,
        estimate_sub_item_id: estimateSubItemId ?? null,
        choices: validChoices.map((c) => ({
          title: c.title.trim(),
          price: parseFloat(c.price),
          description: c.description.trim() || null,
          vendor_name: c.vendor_name.trim() || null,
        })),
      });

      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message || "Failed to create selection.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Allowance & Choices">
      <form onSubmit={handleSubmit} class="modal-form">
        <FormField label="Selection Title" required>
          <input
            class="form-input"
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="e.g. Master Bath Tile"
          />
        </FormField>

        <div class="form-row">
          <FormField label="Category">
            <input
              class="form-input"
              type="text"
              value={category}
              onInput={(e) => setCategory((e.target as HTMLInputElement).value)}
              placeholder="e.g. Flooring, Fixtures"
            />
          </FormField>
          <FormField label="Location">
            <input
              class="form-input"
              type="text"
              value={location}
              onInput={(e) => setLocation((e.target as HTMLInputElement).value)}
              placeholder="e.g. Master Bath"
            />
          </FormField>
        </div>

        <FormField label="Allowance Amount ($)" required>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={allowanceAmount}
            onInput={(e) => setAllowanceAmount((e.target as HTMLInputElement).value)}
            placeholder="0.00"
          />
        </FormField>

        <div class="form-row">
          <FormField label="Deadline">
            <input
              class="form-input"
              type="date"
              value={deadlineDate}
              onInput={(e) => setDeadlineDate((e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="">
            <label class="form-checkbox">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired((e.target as HTMLInputElement).checked)}
              />
              Required selection
            </label>
          </FormField>
        </div>

        <FormField label="Client Instructions">
          <textarea
            class="form-input"
            rows={2}
            value={publicInstructions}
            onInput={(e) => setPublicInstructions((e.target as HTMLTextAreaElement).value)}
            placeholder="What the client should know when choosing…"
          />
        </FormField>

        {/* ── Choices ──────────────────────────────────────────────────── */}
        <div class="selection-choices">
          <div class="selection-choices__header">
            <h4 class="selection-choices__title">Choices</h4>
            <button type="button" class="btn btn--ghost btn--sm" onClick={addChoice}>
              + Add Choice
            </button>
          </div>
          {choices.map((c, i) => (
            <div key={i} class="selection-choice-row">
              <div class="form-row">
                <FormField label={`Choice ${i + 1} Title`} required>
                  <input
                    class="form-input"
                    type="text"
                    value={c.title}
                    onInput={(e) => updateChoice(i, "title", (e.target as HTMLInputElement).value)}
                    placeholder="e.g. Option A — 12×24 Porcelain"
                  />
                </FormField>
                <FormField label="Price ($)" required>
                  <input
                    class="form-input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={c.price}
                    onInput={(e) => updateChoice(i, "price", (e.target as HTMLInputElement).value)}
                    placeholder="0.00"
                  />
                </FormField>
              </div>
              <div class="form-row">
                <FormField label="Description">
                  <input
                    class="form-input"
                    type="text"
                    value={c.description}
                    onInput={(e) =>
                      updateChoice(i, "description", (e.target as HTMLInputElement).value)
                    }
                    placeholder="Optional details"
                  />
                </FormField>
                <FormField label="Vendor">
                  <input
                    class="form-input"
                    type="text"
                    value={c.vendor_name}
                    onInput={(e) =>
                      updateChoice(i, "vendor_name", (e.target as HTMLInputElement).value)
                    }
                    placeholder="e.g. Tile Shop, Floor & Decor"
                  />
                </FormField>
              </div>
              {choices.length > 1 && (
                <button
                  type="button"
                  class="btn btn--ghost btn--sm btn--danger"
                  onClick={() => removeChoice(i)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        {error && <p class="form-error">{error}</p>}

        <div class="modal-actions">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? <Spinner size="sm" /> : "Save Allowance"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
