/**
 * SelectionsTab — Sprint 38 Run 4.
 *
 * Client-portal view of material/finish selections. Client sees pending selections,
 * chooses one from each, and approves via e-signature (BoldSign template).
 *
 * GET  /api/portal/:token/selections
 * POST /api/portal/:token/selections/:id/approve  { choice_id }
 */

import { useEffect, useState } from "preact/hooks";
import { getJson, postJson, portalToken } from "./portalApi";

interface SelectionChoice {
  id: string;
  title: string;
  description: string | null;
  price: number;
  photo_ids: string[];
  vendor_name: string | null;
  is_client_added: boolean;
  approved: boolean;
  approved_at: string | null;
}

interface Selection {
  id: string;
  title: string;
  category: string | null;
  location: string | null;
  allowance_amount: number;
  required: boolean;
  deadline_date: string | null;
  deadline_approaching: boolean;
  deadline_passed: boolean;
  public_instructions: string | null;
  status: "pending" | "sent" | "approved";
  choices: SelectionChoice[];
}

interface SelectionsPayload {
  selections: Selection[];
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

// ── Individual selection card ─────────────────────────────────────────────────

function SelectionCard({
  sel,
  onApprove,
}: {
  sel: Selection;
  onApprove: (selectionId: string, choiceId: string) => Promise<void>;
}) {
  const [chosenId, setChosenId] = useState<string | null>(
    sel.choices.find((c) => c.approved)?.id ?? null,
  );
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approved, setApproved] = useState(sel.status === "approved");
  const [signaturePending, setSignaturePending] = useState(sel.status === "sent");

  const lowestPrice = Math.min(...sel.choices.map((c) => c.price));

  async function handleApprove() {
    if (!chosenId) return;
    setApproving(true);
    setApproveError(null);
    try {
      await onApprove(sel.id, chosenId);
      setSignaturePending(true);
      setConfirming(false);
    } catch (e) {
      setApproveError((e as Error).message || "Approval failed. Please try again.");
    } finally {
      setApproving(false);
    }
  }

  if (approved) {
    const approvedChoice = sel.choices.find((c) => c.approved);
    return (
      <div class="portal-card selection-card selection-card--approved">
        <div class="selection-card__header">
          <div>
            <h3 class="selection-card__title">{sel.title}</h3>
            {sel.location && <span class="selection-card__meta">{sel.location}</span>}
          </div>
          <span class="portal-badge portal-badge--success">Approved</span>
        </div>
        {approvedChoice && (
          <div class="selection-card__approved-choice">
            <strong>{approvedChoice.title}</strong>
            {approvedChoice.vendor_name && (
              <span class="selection-card__meta"> — {approvedChoice.vendor_name}</span>
            )}
            <span class="selection-card__price">{fmtCurrency(approvedChoice.price)}</span>
            {approvedChoice.price > sel.allowance_amount && (
              <span class="selection-card__overage">
                +{fmtCurrency(approvedChoice.price - sel.allowance_amount)} over allowance
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (signaturePending) {
    return (
      <div class="portal-card selection-card selection-card--pending-signature">
        <div class="selection-card__header">
          <div>
            <h3 class="selection-card__title">{sel.title}</h3>
            {sel.location && <span class="selection-card__meta">{sel.location}</span>}
          </div>
          <span class="portal-badge portal-badge--warning">Signature Pending</span>
        </div>
        <p class="selection-card__sig-notice">
          A signature request has been sent to your email. Please check your inbox and sign to
          confirm your selection.
        </p>
      </div>
    );
  }

  return (
    <div class={`portal-card selection-card${sel.deadline_passed ? " selection-card--overdue" : ""}`}>
      <div class="selection-card__header">
        <div>
          <h3 class="selection-card__title">{sel.title}</h3>
          <div class="selection-card__meta-row">
            {sel.category && <span class="selection-card__meta">{sel.category}</span>}
            {sel.location && <span class="selection-card__meta">{sel.location}</span>}
          </div>
        </div>
        <div class="selection-card__badges">
          {sel.required && <span class="portal-badge portal-badge--info">Required</span>}
          {sel.deadline_passed && (
            <span class="portal-badge portal-badge--danger">Past Due</span>
          )}
          {!sel.deadline_passed && sel.deadline_approaching && sel.deadline_date && (
            <span class="portal-badge portal-badge--warning">
              Due {fmtDate(sel.deadline_date)}
            </span>
          )}
        </div>
      </div>

      <div class="selection-card__allowance">
        Allowance: <strong>{fmtCurrency(sel.allowance_amount)}</strong>
        {sel.deadline_date && !sel.deadline_approaching && (
          <span class="selection-card__deadline"> · Due by {fmtDate(sel.deadline_date)}</span>
        )}
      </div>

      {sel.public_instructions && (
        <p class="selection-card__instructions">{sel.public_instructions}</p>
      )}

      {/* Choice grid */}
      <div class="selection-choices-grid">
        {sel.choices.map((c) => {
          const isChosen = chosenId === c.id;
          const isOver = c.price > sel.allowance_amount;
          const isLowest = c.price === lowestPrice;
          return (
            <button
              key={c.id}
              type="button"
              class={`selection-choice-card${isChosen ? " selection-choice-card--selected" : ""}${isOver ? " selection-choice-card--over" : ""}`}
              onClick={() => setChosenId(c.id)}
            >
              <div class="selection-choice-card__title">{c.title}</div>
              {c.description && (
                <div class="selection-choice-card__desc">{c.description}</div>
              )}
              {c.vendor_name && (
                <div class="selection-choice-card__vendor">{c.vendor_name}</div>
              )}
              <div class="selection-choice-card__footer">
                <span class="selection-choice-card__price">{fmtCurrency(c.price)}</span>
                {isOver && (
                  <span class="selection-choice-card__overage">
                    +{fmtCurrency(c.price - sel.allowance_amount)} over
                  </span>
                )}
                {isLowest && !isOver && (
                  <span class="selection-choice-card__badge">Within Allowance</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Confirm step */}
      {confirming ? (
        <div class="selection-card__confirm">
          <p>
            Confirm your selection: <strong>{sel.choices.find((c) => c.id === chosenId)?.title}</strong>?
            {(() => {
              const chosen = sel.choices.find((c) => c.id === chosenId);
              if (chosen && chosen.price > sel.allowance_amount) {
                return (
                  <span class="selection-card__confirm-overage">
                    {" "}The {fmtCurrency(chosen.price - sel.allowance_amount)} overage will be added
                    to your project budget.
                  </span>
                );
              }
              return null;
            })()}
          </p>
          <p class="selection-card__sig-note">
            You'll receive an e-signature request by email to finalize this choice.
          </p>
          {approveError && <p class="form-error">{approveError}</p>}
          <div class="selection-card__confirm-actions">
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              onClick={() => setConfirming(false)}
              disabled={approving}
            >
              Back
            </button>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              onClick={handleApprove}
              disabled={approving}
            >
              {approving ? "Sending…" : "Confirm & Sign"}
            </button>
          </div>
        </div>
      ) : (
        <div class="selection-card__actions">
          <button
            type="button"
            class="btn btn--primary"
            disabled={!chosenId}
            onClick={() => setConfirming(true)}
          >
            Approve Selection
          </button>
          {!chosenId && (
            <span class="selection-card__hint">Select one of the options above to continue.</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── SelectionsTab ─────────────────────────────────────────────────────────────

export function SelectionsTab() {
  const token = portalToken();
  const [selections, setSelections] = useState<Selection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<SelectionsPayload>(`/api/portal/${token}/selections`)
      .then((d) => setSelections(d.selections))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleApprove(selectionId: string, choiceId: string) {
    await postJson(`/api/portal/${token}/selections/${selectionId}/approve`, {
      choice_id: choiceId,
    });
  }

  if (loading) {
    return <div class="portal-tab-loading">Loading selections…</div>;
  }

  if (error) {
    return <div class="portal-tab-error">{error}</div>;
  }

  if (selections.length === 0) {
    return (
      <div class="portal-card portal-empty">
        <p>No selections have been assigned to your project yet.</p>
        <p class="portal-empty__sub">
          Your project manager will add material or finish choices for you to review here.
        </p>
      </div>
    );
  }

  const pending = selections.filter((s) => s.status !== "approved");
  const done = selections.filter((s) => s.status === "approved");

  return (
    <div class="portal-tab">
      {pending.length > 0 && (
        <section class="portal-section">
          <h2 class="portal-section__title">
            Pending Selections ({pending.length})
          </h2>
          <div class="selections-list">
            {pending.map((s) => (
              <SelectionCard key={s.id} sel={s} onApprove={handleApprove} />
            ))}
          </div>
        </section>
      )}
      {done.length > 0 && (
        <section class="portal-section">
          <h2 class="portal-section__title">Approved Selections</h2>
          <div class="selections-list">
            {done.map((s) => (
              <SelectionCard key={s.id} sel={s} onApprove={handleApprove} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
