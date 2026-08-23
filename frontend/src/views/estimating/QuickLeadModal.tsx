/**
 * QuickLeadModal — Sprint 23
 * Fast lead entry form for the "New Lead" button on the CHS Leads Kanban.
 * Calls POST /api/estimate-requests/quick-lead and shows a matched-client notice
 * if the phone dedupes to an existing record.
 */
import { useState } from "preact/hooks";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import type { EstimateRequest } from "../../types";
import { AddressAutocomplete } from "../../components/AddressAutocomplete";
import type { AddressResult } from "../../hooks/useAddressAutocomplete";

interface QuickLeadModalProps {
  onClose: () => void;
  onCreated: (request: EstimateRequest) => void;
}

const JOB_TYPE_OPTIONS = [
  { value: "remodel", label: "Remodel" },
  { value: "addition", label: "Addition" },
  { value: "new_build", label: "New Build" },
  { value: "repair", label: "Repair" },
  { value: "other", label: "Other" },
];

const LEAD_SOURCE_OPTIONS = [
  { value: "google_lsa", label: "Google LSA" },
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "repeat", label: "Repeat Client" },
  { value: "direct_call", label: "Direct Call" },
  { value: "other", label: "Other" },
];

export function QuickLeadModal({ onClose, onCreated }: QuickLeadModalProps) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [matchedClient, setMatchedClient] = useState<string | null>(null);
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
    job_type: "remodel",
    job_type_detail: "",
    lead_source: "direct_call",
    property_address: "",
    property_city: "",
    property_state: "Arkansas",
    property_zip: "",
    notes: "",
  });

  function set(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear matched notice when phone changes.
    if (field === "phone") setMatchedClient(null);
  }

  function handleAddressSelect(result: AddressResult) {
    setForm((prev) => ({
      ...prev,
      property_address: result.street,
      property_city: result.city,
      property_state: result.state || "Arkansas",
      property_zip: result.zip,
    }));
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (submitting) return;

    if (!form.first_name.trim() || !form.last_name.trim() || !form.phone.trim()) {
      toast.push("error", "First name, last name, and phone are required.");
      return;
    }
    if (form.job_type === "other" && !form.job_type_detail.trim()) {
      toast.push("error", "Describe what kind of job this is.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ request: EstimateRequest; matched_client: string | null }>(
        "/api/estimate-requests/quick-lead",
        {
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim() || undefined,
          job_type: form.job_type,
          job_type_detail: form.job_type_detail.trim() || null,
          lead_source: form.lead_source,
          property_address: form.property_address.trim() || undefined,
          property_city: form.property_city.trim() || undefined,
          property_state: form.property_state.trim() || undefined,
          property_zip: form.property_zip.trim() || undefined,
          notes: form.notes.trim() || undefined,
        },
      );
      if (res.matched_client) {
        setMatchedClient(res.matched_client);
      }
      toast.push("success", "Lead created — card added to New Lead column");
      onCreated(res.request);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.push("error", msg ?? "Failed to create lead");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="modal-backdrop is-active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal is-active" role="dialog" aria-modal="true" aria-labelledby="ql-title">
        <div class="modal__header">
          <h2 class="modal__title" id="ql-title">New Lead</h2>
          <button type="button" class="modal__close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="modal__body">
            <div class="form-row form-row--2col">
              <div class="form-group">
                <label class="form-label" for="ql-first">First Name *</label>
                <input
                  id="ql-first"
                  class="form-input"
                  type="text"
                  placeholder="Jane"
                  value={form.first_name}
                  onInput={(e) => set("first_name", (e.target as HTMLInputElement).value)}
                  required
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="ql-last">Last Name *</label>
                <input
                  id="ql-last"
                  class="form-input"
                  type="text"
                  placeholder="Smith"
                  value={form.last_name}
                  onInput={(e) => set("last_name", (e.target as HTMLInputElement).value)}
                  required
                />
              </div>
            </div>

            <div class="form-row form-row--2col">
              <div class="form-group">
                <label class="form-label" for="ql-phone">Phone *</label>
                <input
                  id="ql-phone"
                  class="form-input"
                  type="tel"
                  placeholder="501-555-0101"
                  value={form.phone}
                  onInput={(e) => set("phone", (e.target as HTMLInputElement).value)}
                  required
                />
                {matchedClient && (
                  <p class="form-hint" style={{ color: "var(--color-brand)" }}>
                    ✓ Matches existing client: {matchedClient}
                  </p>
                )}
              </div>
              <div class="form-group">
                <label class="form-label" for="ql-email">Email</label>
                <input
                  id="ql-email"
                  class="form-input"
                  type="email"
                  placeholder="jane@example.com"
                  value={form.email}
                  onInput={(e) => set("email", (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>

            <div class="form-row form-row--2col">
              <div class="form-group">
                <label class="form-label" for="ql-jobtype">Job Type</label>
                <select
                  id="ql-jobtype"
                  class="form-select"
                  value={form.job_type}
                  onChange={(e) => set("job_type", (e.target as HTMLSelectElement).value)}
                >
                  {JOB_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="ql-source">Lead Source</label>
                <select
                  id="ql-source"
                  class="form-select"
                  value={form.lead_source}
                  onChange={(e) => set("lead_source", (e.target as HTMLSelectElement).value)}
                >
                  {LEAD_SOURCE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="ql-jobdetail">
                Description{form.job_type === "other" ? " *" : ""}
              </label>
              <input
                id="ql-jobdetail"
                class="form-input"
                type="text"
                required={form.job_type === "other"}
                placeholder="e.g. Pergola repair, Kitchen remodel…"
                value={form.job_type_detail}
                onInput={(e) => set("job_type_detail", (e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="form-group">
              <AddressAutocomplete
                label="Property Address"
                initialValue={form.property_address}
                onSelect={handleAddressSelect}
                onInputChange={(v) => set("property_address", v)}
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="ql-notes">Notes</label>
              <textarea
                id="ql-notes"
                class="form-textarea"
                placeholder="Initial project notes..."
                value={form.notes}
                onInput={(e) => set("notes", (e.target as HTMLTextAreaElement).value)}
              />
            </div>
          </div>

          <div class="modal__footer">
            <button type="button" class="btn btn--secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" class="btn btn--primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create Lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
