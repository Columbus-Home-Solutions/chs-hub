/**
 * BidRequestModal — Sprint 38 Run 3.
 *
 * Owner creates a bid request from an estimate sub-item or a job (change-order context).
 * Selects which active subs to invite, sets sealed/open mode, notify-losers toggle.
 * On submit: POST /api/bid-requests.
 */

import { useEffect, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";
import { api } from "../../api";

interface Sub {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  trade: string | null;
  phone: string | null;
  is_active: number;
}

interface BidRequestModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (bidRequestId: string) => void;
  /** Pre-fill from estimate context */
  estimateId?: string;
  estimateSubItemId?: string;
  defaultTitle?: string;
  defaultScope?: string;
  /** Pre-fill from job context */
  jobId?: string;
}

function subLabel(s: Sub): string {
  return [s.company_name, s.contact_name || s.primary_contact].filter(Boolean).join(" — ");
}

export function BidRequestModal({
  open,
  onClose,
  onCreated,
  estimateId,
  estimateSubItemId,
  defaultTitle = "",
  defaultScope = "",
  jobId,
}: BidRequestModalProps) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);

  const [title, setTitle] = useState(defaultTitle);
  const [scopeDescription, setScopeDescription] = useState(defaultScope);
  const [quantitiesNotes, setQuantitiesNotes] = useState("");
  const [neededByDate, setNeededByDate] = useState("");
  const [bidMode, setBidMode] = useState<"sealed" | "open">("sealed");
  const [notifyLosers, setNotifyLosers] = useState(true);
  const [selectedSubIds, setSelectedSubIds] = useState<Set<string>>(new Set());

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setScopeDescription(defaultScope);
      setQuantitiesNotes("");
      setNeededByDate("");
      setBidMode("sealed");
      setNotifyLosers(true);
      setSelectedSubIds(new Set());
      setError(null);
    }
  }, [open, defaultTitle, defaultScope]);

  // Load active subs on open
  useEffect(() => {
    if (!open) return;
    setSubsLoading(true);
    api
      .get<{ subcontractors: Sub[] }>("/api/subcontractors?is_active=1&limit=200")
      .then((d) => setSubs((d.subcontractors ?? []).filter((s) => s.is_active !== 0)))
      .catch(() => setSubs([]))
      .finally(() => setSubsLoading(false));
  }, [open]);

  const toggleSub = (id: string) => {
    setSelectedSubIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required."); return; }
    if (!scopeDescription.trim()) { setError("Scope description is required."); return; }
    if (selectedSubIds.size === 0) { setError("Select at least one sub to invite."); return; }
    if (!estimateId && !jobId) { setError("Missing estimate or job context."); return; }

    setSubmitting(true);
    try {
      const result = await api.post<{ id: string }>("/api/bid-requests", {
        title: title.trim(),
        scope_description: scopeDescription.trim(),
        quantities_notes: quantitiesNotes.trim() || null,
        needed_by_date: neededByDate || null,
        estimate_id: estimateId ?? null,
        job_id: jobId ?? null,
        estimate_sub_item_id: estimateSubItemId ?? null,
        bid_mode: bidMode,
        notify_losers: notifyLosers ? 1 : 0,
        sub_ids: Array.from(selectedSubIds),
      });
      onCreated(result.id);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Failed to create bid request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Request Bids from Subs"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={submitting || selectedSubIds.size === 0}
            onClick={handleSubmit}
          >
            {submitting ? "Sending invites…" : `Send to ${selectedSubIds.size} sub${selectedSubIds.size !== 1 ? "s" : ""}`}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}

        <FormField label="Bid request title" required>
          <input
            class="form-input"
            type="text"
            placeholder="e.g. Electrical rough-in — Unit 4"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Scope of work" required>
          <textarea
            class="form-input"
            rows={4}
            placeholder="Describe exactly what you need priced. Be specific so subs can give accurate quotes."
            value={scopeDescription}
            onInput={(e) => setScopeDescription((e.target as HTMLTextAreaElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Quantities / measurements (optional)">
          <textarea
            class="form-input"
            rows={2}
            placeholder="e.g. 1,200 sq ft, 14 fixtures, 3 circuits"
            value={quantitiesNotes}
            onInput={(e) => setQuantitiesNotes((e.target as HTMLTextAreaElement).value)}
            disabled={submitting}
          />
        </FormField>

        <FormField label="Needed by date (optional)">
          <input
            class="form-input"
            type="date"
            value={neededByDate}
            onInput={(e) => setNeededByDate((e.target as HTMLInputElement).value)}
            disabled={submitting}
          />
        </FormField>

        {/* Sealed / Open toggle */}
        <div>
          <div class="form-label" style={{ marginBottom: "8px" }}>Bidding mode</div>
          <div class="radio-group">
            <label class="radio-option">
              <input
                type="radio"
                name="bid_mode"
                value="sealed"
                checked={bidMode === "sealed"}
                onChange={() => setBidMode("sealed")}
                disabled={submitting}
              />
              <span>
                <strong>Sealed</strong> — subs can't see each other's prices
                <span class="form-hint"> (default — recommended)</span>
              </span>
            </label>
            <label class="radio-option">
              <input
                type="radio"
                name="bid_mode"
                value="open"
                checked={bidMode === "open"}
                onChange={() => setBidMode("open")}
                disabled={submitting}
              />
              <span>
                <strong>Open</strong> — subs see the current price list after submitting
              </span>
            </label>
          </div>
        </div>

        {/* Notify losers toggle */}
        <label class="checkbox-option">
          <input
            type="checkbox"
            checked={notifyLosers}
            onChange={(e) => setNotifyLosers((e.target as HTMLInputElement).checked)}
            disabled={submitting}
          />
          <span>
            Notify non-winning subs with a "thanks, went another direction" message
          </span>
        </label>

        {/* Sub selection */}
        <div>
          <div class="form-label" style={{ marginBottom: "8px" }}>
            Invite subs{" "}
            {selectedSubIds.size > 0 && (
              <span class="badge badge--info" style={{ marginLeft: "6px" }}>
                {selectedSubIds.size} selected
              </span>
            )}
          </div>
          {subsLoading ? (
            <Spinner />
          ) : subs.length === 0 ? (
            <p class="form-hint">No active subs found.</p>
          ) : (
            <div class="sub-select-list">
              {subs.map((s) => (
                <label key={s.id} class="checkbox-option sub-select-row">
                  <input
                    type="checkbox"
                    checked={selectedSubIds.has(s.id)}
                    onChange={() => toggleSub(s.id)}
                    disabled={submitting}
                  />
                  <span class="sub-select-row__name">{subLabel(s)}</span>
                  {s.trade && <span class="sub-select-row__trade">{s.trade}</span>}
                  {s.phone && <span class="sub-select-row__phone">{s.phone}</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
