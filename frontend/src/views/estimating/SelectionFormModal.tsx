/**
 * SelectionFormModal — Sprint 38 Run 4.
 *
 * Create or edit allowances and choices for estimates/jobs.
 */

import { useEffect, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";
import { api } from "../../api";
import { uploadPhoto } from "../../lib/capture";

interface Choice {
  id?: string;
  title: string;
  price: string;
  description: string;
  vendor_name: string;
  photoId: string | null;
  photoPreview: string | null;
}

export interface EditSelectionValues {
  id: string;
  title: string;
  category: string | null;
  location: string | null;
  allowance_amount: number;
  required: boolean;
  deadline_date: string | null;
  public_instructions: string | null;
}

export interface EditChoiceValues {
  id: string;
  selectionId: string;
  selectionTitle?: string;
  title: string;
  price: number;
  description: string | null;
  vendor_name: string | null;
  photo_ids: string[];
}

interface SelectionFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  estimateId?: string;
  jobId?: string;
  estimateSubItemId?: string;
  defaultTitle?: string;
  selectionId?: string;
  selectionTitle?: string;
  linkedJobId?: string | null;
  editSelection?: EditSelectionValues;
  editChoice?: EditChoiceValues;
}

const BLANK_CHOICE: Choice = {
  title: "",
  price: "",
  description: "",
  vendor_name: "",
  photoId: null,
  photoPreview: null,
};

export function SelectionFormModal({
  open,
  onClose,
  onCreated,
  estimateId,
  jobId,
  estimateSubItemId,
  defaultTitle = "",
  selectionId,
  selectionTitle,
  linkedJobId,
  editSelection,
  editChoice,
}: SelectionFormModalProps) {
  const addChoiceOnly = !!selectionId && !editChoice && !editSelection;
  const editChoiceMode = !!editChoice;
  const editSelectionMode = !!editSelection;

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
  const [photoUploading, setPhotoUploading] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editSelectionMode && editSelection) {
      setTitle(editSelection.title);
      setCategory(editSelection.category ?? "");
      setLocation(editSelection.location ?? "");
      setAllowanceAmount(String(editSelection.allowance_amount));
      setRequired(editSelection.required);
      setDeadlineDate(editSelection.deadline_date ?? "");
      setPublicInstructions(editSelection.public_instructions ?? "");
      return;
    }
    if (editChoiceMode && editChoice) {
      setChoices([
        {
          title: editChoice.title,
          price: String(editChoice.price),
          description: editChoice.description ?? "",
          vendor_name: editChoice.vendor_name ?? "",
          photoId: editChoice.photo_ids[0] ?? null,
          photoPreview: editChoice.photo_ids[0]
            ? `/api/photos/${editChoice.photo_ids[0]}/thumb`
            : null,
        },
      ]);
      return;
    }
    setChoices([{ ...BLANK_CHOICE }]);
    if (!addChoiceOnly) {
      setTitle(defaultTitle);
      setCategory("");
      setLocation("");
      setAllowanceAmount("");
      setRequired(true);
      setDeadlineDate("");
      setPublicInstructions("");
    }
  }, [open, addChoiceOnly, defaultTitle, editSelection, editSelectionMode, editChoice, editChoiceMode]);

  function addChoice() {
    setChoices((prev) => [...prev, { ...BLANK_CHOICE }]);
  }

  function removeChoice(i: number) {
    setChoices((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateChoice(i: number, field: keyof Choice, value: string | null) {
    setChoices((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }

  async function handlePhotoPick(i: number, file: File | null) {
    if (!file) return;
    setPhotoUploading(i);
    setError(null);
    try {
      const res = await uploadPhoto(file, {
        job_id: linkedJobId ?? null,
        photo_type: "general",
        caption: choices[i]?.title || "Selection choice",
      });
      setChoices((prev) =>
        prev.map((c, idx) =>
          idx === i
            ? { ...c, photoId: res.id, photoPreview: res.thumb_url || `/api/photos/${res.id}/thumb` }
            : c,
        ),
      );
    } catch (e) {
      setError((e as Error).message || "Photo upload failed.");
    } finally {
      setPhotoUploading(null);
    }
  }

  function clearPhoto(i: number) {
    setChoices((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, photoId: null, photoPreview: null } : c)),
    );
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (editSelectionMode && editSelection) {
        const amount = parseFloat(allowanceAmount);
        if (!title.trim()) {
          setError("Title is required.");
          setSubmitting(false);
          return;
        }
        if (isNaN(amount) || amount < 0) {
          setError("Allowance amount must be a positive number.");
          setSubmitting(false);
          return;
        }
        await api.put(`/api/selections/${editSelection.id}`, {
          title: title.trim(),
          category: category.trim() || null,
          location: location.trim() || null,
          allowance_amount: amount,
          required,
          deadline_date: deadlineDate || null,
          public_instructions: publicInstructions.trim() || null,
        });
      } else if (editChoiceMode && editChoice) {
        const c = choices[0];
        if (!c.title.trim()) {
          setError("Choice title is required.");
          setSubmitting(false);
          return;
        }
        const price = parseFloat(c.price);
        if (isNaN(price) || price < 0) {
          setError("Price is required.");
          setSubmitting(false);
          return;
        }
        await api.put(`/api/selections/${editChoice.selectionId}/choices/${editChoice.id}`, {
          title: c.title.trim(),
          price,
          description: c.description.trim() || null,
          vendor_name: c.vendor_name.trim() || null,
          photo_ids: c.photoId ? [c.photoId] : [],
        });
      } else if (addChoiceOnly) {
        const c = choices[0];
        if (!c.title.trim()) {
          setError("Choice title is required.");
          setSubmitting(false);
          return;
        }
        const price = parseFloat(c.price);
        if (isNaN(price) || price < 0) {
          setError("Price is required.");
          setSubmitting(false);
          return;
        }
        await api.post(`/api/selections/${selectionId}/choices`, {
          title: c.title.trim(),
          price,
          description: c.description.trim() || null,
          vendor_name: c.vendor_name.trim() || null,
          photo_ids: c.photoId ? [c.photoId] : [],
        });
      } else {
        const amount = parseFloat(allowanceAmount);
        if (!title.trim()) {
          setError("Title is required.");
          setSubmitting(false);
          return;
        }
        if (isNaN(amount) || amount < 0) {
          setError("Allowance amount must be a positive number.");
          setSubmitting(false);
          return;
        }
        const validChoices = choices.filter((c) => c.title.trim() && !isNaN(parseFloat(c.price)));
        if (validChoices.length === 0) {
          setError("Add at least one choice with a title and price.");
          setSubmitting(false);
          return;
        }

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
            photo_ids: c.photoId ? [c.photoId] : [],
          })),
        });
      }

      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message || "Failed to save.");
    } finally {
      setSubmitting(false);
    }
  }

  const modalTitle = editSelectionMode
    ? "Edit Allowance"
    : editChoiceMode
      ? `Edit Choice — ${editChoice?.selectionTitle ?? "Allowance"}`
      : addChoiceOnly
        ? `Add Choice — ${selectionTitle ?? "Allowance"}`
        : "Add Allowance & Choices";

  const submitLabel = editSelectionMode
    ? "Save Changes"
    : editChoiceMode
      ? "Save Choice"
      : addChoiceOnly
        ? "Add Choice"
        : "Save Allowance";

  const renderChoiceFields = (c: Choice, i: number) => (
    <div key={i} class="selection-choice-row">
      <div class="form-row">
        <FormField label={addChoiceOnly || editChoiceMode ? "Choice Title" : `Choice ${i + 1} Title`} required>
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
            onInput={(e) => updateChoice(i, "description", (e.target as HTMLInputElement).value)}
            placeholder="Optional details"
          />
        </FormField>
        <FormField label="Vendor">
          <input
            class="form-input"
            type="text"
            value={c.vendor_name}
            onInput={(e) => updateChoice(i, "vendor_name", (e.target as HTMLInputElement).value)}
            placeholder="e.g. Tile Shop, Floor & Decor"
          />
        </FormField>
      </div>
      <FormField label="Photo (optional)">
        {c.photoPreview ? (
          <div class="selection-choice-photo">
            <img src={c.photoPreview} alt="" class="selection-choice-photo__thumb" />
            <button type="button" class="btn btn--ghost btn--sm" onClick={() => clearPhoto(i)}>
              Remove photo
            </button>
          </div>
        ) : (
          <label class="selection-choice-photo__upload">
            <input
              type="file"
              accept="image/*"
              disabled={photoUploading === i}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0] ?? null;
                void handlePhotoPick(i, f);
                (e.target as HTMLInputElement).value = "";
              }}
            />
            {photoUploading === i ? "Uploading…" : "Upload photo"}
          </label>
        )}
      </FormField>
      {!addChoiceOnly && !editChoiceMode && choices.length > 1 && (
        <button type="button" class="btn btn--ghost btn--sm btn--danger" onClick={() => removeChoice(i)}>
          Remove
        </button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={modalTitle}>
      <form onSubmit={handleSubmit} class="modal-form">
        {editSelectionMode && (
          <>
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
          </>
        )}

        {!addChoiceOnly && !editSelectionMode && !editChoiceMode && (
          <>
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

            <div class="selection-choices">
              <div class="selection-choices__header">
                <h4 class="selection-choices__title">Choices</h4>
                <button type="button" class="btn btn--ghost btn--sm" onClick={addChoice}>
                  + Add Choice
                </button>
              </div>
              {choices.map(renderChoiceFields)}
            </div>
          </>
        )}

        {(addChoiceOnly || editChoiceMode) && renderChoiceFields(choices[0], 0)}

        {error && <p class="form-error">{error}</p>}

        <div class="modal-actions">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? <Spinner size="sm" /> : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
