/**
 * Shared client-facing selection choice cards — used on the job portal and quote page.
 */

import { useEffect, useState } from "preact/hooks";

export interface ClientSelectionChoice {
  id: string;
  title: string;
  description: string | null;
  price: number;
  photo_ids: string[];
  vendor_name: string | null;
  is_client_added: boolean;
  approved: boolean;
  approved_at: string | null;
  client_signature_document_id?: string | null;
}

export interface ClientSelection {
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
  chosen_choice_id?: string | null;
  choices: ClientSelectionChoice[];
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

export function SelectionCard({
  sel,
  onApprove,
  onChoose,
  flow = "individual",
  readOnly = false,
  individualSignLinkUrl,
}: {
  sel: ClientSelection;
  onApprove?: (selectionId: string, choiceId: string) => Promise<{ sign_link?: string | null }>;
  onChoose?: (selectionId: string, choiceId: string) => Promise<void>;
  flow?: "individual" | "combined";
  readOnly?: boolean;
  individualSignLinkUrl?: string;
}) {
  const [chosenId, setChosenId] = useState<string | null>(
    sel.chosen_choice_id ?? sel.choices.find((c) => c.approved)?.id ?? null,
  );
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approved, setApproved] = useState(sel.status === "approved");
  const [signaturePending, setSignaturePending] = useState(
    flow === "individual" && sel.status === "sent",
  );
  const [signLink, setSignLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [expandedPhoto, setExpandedPhoto] = useState<string | null>(null);

  useEffect(() => {
    setChosenId(sel.chosen_choice_id ?? sel.choices.find((c) => c.approved)?.id ?? null);
    setApproved(sel.status === "approved");
    if (flow === "individual") setSignaturePending(sel.status === "sent");
  }, [sel.id, sel.status, sel.chosen_choice_id, flow, sel.choices]);

  const lowestPrice = Math.min(...sel.choices.map((c) => c.price));
  const isCombined = flow === "combined";

  async function fetchIndividualSignLink(): Promise<string | null> {
    if (signLink) return signLink;
    if (!individualSignLinkUrl) return null;
    const res = await fetch(individualSignLinkUrl, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
    }
    const link = (data as { sign_link?: string | null }).sign_link ?? null;
    if (link) setSignLink(link);
    return link;
  }

  useEffect(() => {
    if (!signaturePending || isCombined || signLink || !individualSignLinkUrl) return;
    void fetchIndividualSignLink().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signaturePending, isCombined, individualSignLinkUrl, signLink]);

  async function openIndividualSign() {
    setLinkBusy(true);
    setApproveError(null);
    try {
      const link = await fetchIndividualSignLink();
      if (!link) {
        throw new Error("Signing link is not ready yet. Please try again in a few seconds.");
      }
      window.open(link, "_blank", "noopener,noreferrer");
    } catch (e) {
      setApproveError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  }

  if (readOnly) {
    const approvedChoice = sel.choices.find((c) => c.approved);
    const pendingChoice = sel.choices.find((c) => c.client_signature_document_id);
    const chosenChoice = sel.chosen_choice_id
      ? sel.choices.find((c) => c.id === sel.chosen_choice_id)
      : null;
    const displayChoice = approvedChoice ?? pendingChoice ?? chosenChoice;
    const statusLabel =
      sel.status === "approved"
        ? "Approved"
        : sel.status === "sent"
          ? "Signature Pending"
          : "Pending";
    const statusClass =
      sel.status === "approved"
        ? "portal-badge--success"
        : sel.status === "sent"
          ? "portal-badge--warning"
          : "portal-badge--info";

    return (
      <>
        <div
          class={`portal-card selection-card${sel.status === "approved" ? " selection-card--approved" : ""}${sel.status === "sent" ? " selection-card--pending-signature" : ""}`}
        >
          <div class="selection-card__header">
            <div>
              <h3 class="selection-card__title">{sel.title}</h3>
              <div class="selection-card__meta-row">
                {sel.category && <span class="selection-card__meta">{sel.category}</span>}
                {sel.location && <span class="selection-card__meta">{sel.location}</span>}
              </div>
            </div>
            <span class={`portal-badge ${statusClass}`}>{statusLabel}</span>
          </div>

          <div class="selection-card__allowance">
            Allowance: <strong>{fmtCurrency(sel.allowance_amount)}</strong>
          </div>

          {displayChoice ? (
            <div class="selection-card__approved-choice">
              {displayChoice.photo_ids[0] && (
                <div
                  class="selection-choice-card__photo"
                  style={{ marginBottom: "10px", maxWidth: "200px" }}
                  onClick={() => setExpandedPhoto(displayChoice.photo_ids[0])}
                  role="presentation"
                >
                  <img src={`/api/photos/${displayChoice.photo_ids[0]}/thumb`} alt="" loading="lazy" />
                </div>
              )}
              <strong>{displayChoice.title}</strong>
              {displayChoice.vendor_name && (
                <span class="selection-card__meta"> — {displayChoice.vendor_name}</span>
              )}
              {displayChoice.description && (
                <div class="selection-card__meta" style={{ marginTop: "6px", whiteSpace: "pre-wrap" }}>
                  {displayChoice.description}
                </div>
              )}
              <div style={{ marginTop: "6px" }}>
                <span class="selection-card__price">{fmtCurrency(displayChoice.price)}</span>
                {displayChoice.price > sel.allowance_amount && (
                  <span class="selection-card__overage">
                    {" "}
                    +{fmtCurrency(displayChoice.price - sel.allowance_amount)} over allowance
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div class="selection-choices-grid">
              {sel.choices.map((c) => {
                const isOver = c.price > sel.allowance_amount;
                return (
                  <div
                    key={c.id}
                    class={`selection-choice-card selection-choice-card--readonly${isOver ? " selection-choice-card--over" : ""}`}
                  >
                    {c.photo_ids[0] && (
                      <div
                        class="selection-choice-card__photo"
                        onClick={() => setExpandedPhoto(c.photo_ids[0])}
                        role="presentation"
                      >
                        <img src={`/api/photos/${c.photo_ids[0]}/thumb`} alt="" loading="lazy" />
                      </div>
                    )}
                    <div class="selection-choice-card__title">{c.title}</div>
                    {c.description && <div class="selection-choice-card__desc">{c.description}</div>}
                    {c.vendor_name && <div class="selection-choice-card__vendor">{c.vendor_name}</div>}
                    <div class="selection-choice-card__footer">
                      <span class="selection-choice-card__price">{fmtCurrency(c.price)}</span>
                      {isOver && (
                        <span class="selection-choice-card__overage">
                          +{fmtCurrency(c.price - sel.allowance_amount)} over
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {expandedPhoto && (
          <PhotoLightbox photoId={expandedPhoto} onClose={() => setExpandedPhoto(null)} />
        )}
      </>
    );
  }

  async function handleApprove() {
    if (!chosenId || !onApprove) return;
    setApproving(true);
    setApproveError(null);
    try {
      const res = await onApprove(sel.id, chosenId);
      setSignLink(res.sign_link ?? null);
      setSignaturePending(true);
      setConfirming(false);
    } catch (e) {
      setApproveError((e as Error).message || "Approval failed. Please try again.");
    } finally {
      setApproving(false);
    }
  }

  async function handleChoose() {
    if (!chosenId || !onChoose) return;
    setApproving(true);
    setApproveError(null);
    try {
      await onChoose(sel.id, chosenId);
      setConfirming(false);
    } catch (e) {
      setApproveError((e as Error).message || "Could not save your choice. Please try again.");
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

  if (signaturePending && !isCombined) {
    return (
      <div class="portal-card selection-card selection-card--pending-signature">
        <div class="selection-card__header">
          <div>
            <h3 class="selection-card__title">{sel.title}</h3>
            {sel.location && <span class="selection-card__meta">{sel.location}</span>}
          </div>
          <span class="portal-badge portal-badge--warning">Signature Pending</span>
        </div>
        {approveError && <p class="form-error">{approveError}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <button
            type="button"
            class="btn btn--primary"
            style={{ textAlign: "center" }}
            disabled={linkBusy}
            onClick={() => void openIndividualSign()}
          >
            {linkBusy ? "Opening…" : "Sign Now →"}
          </button>
          <p class="selection-card__sig-notice" style={{ margin: 0 }}>
            A signature request was also sent to your email as a backup.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
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
            {sel.deadline_passed && <span class="portal-badge portal-badge--danger">Past Due</span>}
            {!sel.deadline_passed && sel.deadline_approaching && sel.deadline_date && (
              <span class="portal-badge portal-badge--warning">Due {fmtDate(sel.deadline_date)}</span>
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
                {c.photo_ids[0] && (
                  <div
                    class="selection-choice-card__photo"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedPhoto(c.photo_ids[0]);
                    }}
                    role="presentation"
                  >
                    <img src={`/api/photos/${c.photo_ids[0]}/thumb`} alt="" loading="lazy" />
                  </div>
                )}
                <div class="selection-choice-card__title">{c.title}</div>
                {c.description && <div class="selection-choice-card__desc">{c.description}</div>}
                {c.vendor_name && <div class="selection-choice-card__vendor">{c.vendor_name}</div>}
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

        {confirming ? (
          <div class="selection-card__confirm">
            <p>
              {isCombined ? "Save this choice: " : "Confirm your selection: "}
              <strong>{sel.choices.find((c) => c.id === chosenId)?.title}</strong>?
              {(() => {
                const chosen = sel.choices.find((c) => c.id === chosenId);
                if (chosen && chosen.price > sel.allowance_amount) {
                  return (
                    <span class="selection-card__confirm-overage">
                      {" "}
                      {isCombined
                        ? `This option is ${fmtCurrency(chosen.price - sel.allowance_amount)} over the allowance.`
                        : `The ${fmtCurrency(chosen.price - sel.allowance_amount)} overage will be added to your project budget.`}
                    </span>
                  );
                }
                return null;
              })()}
            </p>
            {!isCombined && (
              <p class="selection-card__sig-note">
                You'll receive an e-signature request by email to finalize this choice.
              </p>
            )}
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
                onClick={isCombined ? handleChoose : handleApprove}
                disabled={approving}
              >
                {approving ? "Saving…" : isCombined ? "Choose this option" : "Confirm & Sign"}
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
              {isCombined
                ? sel.chosen_choice_id
                  ? "Change choice"
                  : "Choose this option"
                : "Approve Selection"}
            </button>
            {!chosenId && (
              <span class="selection-card__hint">Select one of the options above to continue.</span>
            )}
            {isCombined && sel.chosen_choice_id && chosenId === sel.chosen_choice_id && (
              <span class="selection-card__hint selection-card__hint--success">Choice saved</span>
            )}
          </div>
        )}
      </div>
      {expandedPhoto && (
        <PhotoLightbox photoId={expandedPhoto} onClose={() => setExpandedPhoto(null)} />
      )}
    </>
  );
}

function PhotoLightbox({ photoId, onClose }: { photoId: string; onClose: () => void }) {
  return (
    <div class="portal-photo-lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <div class="portal-photo-lightbox__inner" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="portal-photo-lightbox__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <img src={`/api/photos/${photoId}`} alt="" />
      </div>
    </div>
  );
}

export function ClientSelectionsPanel({
  listUrl,
  approveUrl,
  chooseUrl,
  confirmAllUrl,
  combinedSignLinkUrl,
  individualSignLinkUrl,
  flow = "individual",
  onUpdated,
  pollWhilePending = false,
  readOnly = false,
  refreshKey = 0,
  emptyMessage,
}: {
  listUrl: string;
  approveUrl?: (selectionId: string) => string;
  chooseUrl?: (selectionId: string) => string;
  confirmAllUrl?: string;
  combinedSignLinkUrl?: string;
  individualSignLinkUrl?: (selectionId: string) => string;
  flow?: "individual" | "combined";
  onUpdated?: () => void;
  pollWhilePending?: boolean;
  readOnly?: boolean;
  refreshKey?: number;
  emptyMessage?: string;
}) {
  const [selections, setSelections] = useState<ClientSelection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [confirmAllError, setConfirmAllError] = useState<string | null>(null);
  const [combinedSignLink, setCombinedSignLink] = useState<string | null>(null);
  const [combinedLinkBusy, setCombinedLinkBusy] = useState(false);

  const load = async () => {
    const res = await fetch(listUrl, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
    setSelections(data.selections ?? []);
    onUpdated?.();
  };

  useEffect(() => {
    load()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl, refreshKey]);

  useEffect(() => {
    if (!pollWhilePending) return;
    const hasPendingSig = selections.some((s) => s.status === "sent");
    if (!hasPendingSig) return;
    const poll = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollWhilePending, selections]);

  const signaturePending =
    flow === "combined" && selections.some((s) => s.status === "sent");

  const fetchCombinedSignLink = async (): Promise<string | null> => {
    if (combinedSignLink) return combinedSignLink;
    if (!combinedSignLinkUrl) return null;
    const res = await fetch(combinedSignLinkUrl, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
    }
    const link = (data as { sign_link?: string | null }).sign_link ?? null;
    if (link) setCombinedSignLink(link);
    return link;
  };

  useEffect(() => {
    if (loading || !signaturePending || combinedSignLink || !combinedSignLinkUrl) return;
    void fetchCombinedSignLink().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, signaturePending, combinedSignLinkUrl, combinedSignLink]);

  async function handleApprove(selectionId: string, choiceId: string) {
    if (!approveUrl) throw new Error("approveUrl not configured");
    const res = await fetch(approveUrl(selectionId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ choice_id: choiceId }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
    return data as { sign_link?: string | null };
  }

  async function handleChoose(selectionId: string, choiceId: string) {
    if (!chooseUrl) throw new Error("chooseUrl not configured");
    const res = await fetch(chooseUrl(selectionId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ choice_id: choiceId }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
    await load();
  }

  async function handleConfirmAll() {
    if (!confirmAllUrl) return;
    setConfirmingAll(true);
    setConfirmAllError(null);
    try {
      const res = await fetch(confirmAllUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
      setCombinedSignLink((data as { sign_link?: string | null }).sign_link ?? null);
      if (!(data as { sign_link?: string | null }).sign_link && combinedSignLinkUrl) {
        void fetchCombinedSignLink().catch(() => undefined);
      }
      await load();
    } catch (e) {
      setConfirmAllError((e as Error).message);
    } finally {
      setConfirmingAll(false);
    }
  }

  async function openCombinedSign() {
    setCombinedLinkBusy(true);
    setConfirmAllError(null);
    try {
      const link = await fetchCombinedSignLink();
      if (!link) throw new Error("Signing link is not ready yet. Please try again in a few seconds.");
      window.open(link, "_blank", "noopener,noreferrer");
    } catch (e) {
      setConfirmAllError((e as Error).message);
    } finally {
      setCombinedLinkBusy(false);
    }
  }

  if (loading) return <div class="quote-muted">Loading selections…</div>;
  if (error) return <div class="quote-error">{error}</div>;
  if (selections.length === 0) {
    if (emptyMessage) {
      return (
        <div class="empty-state">
          <div class="empty-state__title">No selections</div>
          <div>{emptyMessage}</div>
        </div>
      );
    }
    return null;
  }

  const pending = selections.filter((s) => s.status !== "approved");
  const done = selections.filter((s) => s.status === "approved");
  const isCombined = flow === "combined";
  const allChosen =
    isCombined &&
    selections.length > 0 &&
    selections.every((s) => s.chosen_choice_id != null);

  const chosenSummary = isCombined
    ? selections
        .map((s) => {
          const choice = s.choices.find((c) => c.id === s.chosen_choice_id);
          if (!choice) return null;
          const over = Math.max(0, choice.price - s.allowance_amount);
          const overStr = over > 0 ? ` (+${fmtCurrency(over)})` : "";
          return `${choice.title}${overStr}`;
        })
        .filter(Boolean)
    : [];
  const totalOverage = isCombined
    ? selections.reduce((sum, s) => {
        const choice = s.choices.find((c) => c.id === s.chosen_choice_id);
        if (!choice) return sum;
        return sum + Math.max(0, choice.price - s.allowance_amount);
      }, 0)
    : 0;

  return (
    <div class="selections-list">
      {pending.map((s) => (
        <SelectionCard
          key={s.id}
          sel={s}
          flow={flow}
          readOnly={readOnly || signaturePending}
          individualSignLinkUrl={
            individualSignLinkUrl && s.status === "sent" ? individualSignLinkUrl(s.id) : undefined
          }
          onApprove={
            readOnly || isCombined || !approveUrl
              ? undefined
              : async (sid, cid) => {
                  const result = await handleApprove(sid, cid);
                  void load().catch(() => undefined);
                  return result;
                }
          }
          onChoose={
            readOnly || !isCombined || !chooseUrl || signaturePending
              ? undefined
              : handleChoose
          }
        />
      ))}
      {done.map((s) => (
        <SelectionCard
          key={s.id}
          sel={s}
          flow={flow}
          readOnly={readOnly}
          onApprove={readOnly || !approveUrl ? undefined : handleApprove}
        />
      ))}

      {isCombined && !readOnly && signaturePending && (
        <div class="portal-card selection-card selection-card--pending-signature">
          <div class="selection-card__header">
            <h3 class="selection-card__title">Confirm all selections</h3>
            <span class="portal-badge portal-badge--warning">Signature Pending</span>
          </div>
          {confirmAllError && <p class="form-error">{confirmAllError}</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <button
              type="button"
              class="btn btn--primary"
              style={{ textAlign: "center" }}
              disabled={combinedLinkBusy}
              onClick={() => void openCombinedSign()}
            >
              {combinedLinkBusy ? "Opening…" : "Sign Now →"}
            </button>
            <p class="selection-card__sig-notice" style={{ margin: 0 }}>
              One signature request was also sent to your email covering all selections.
            </p>
          </div>
        </div>
      )}

      {isCombined && !readOnly && !signaturePending && pending.length > 0 && (
        <div class="portal-card selection-card selection-card__confirm-all">
          <h3 class="selection-card__title">Review &amp; sign all selections</h3>
          {allChosen ? (
            <>
              <p class="selection-card__meta" style={{ marginBottom: "10px" }}>
                {chosenSummary.join(", ")}
                {totalOverage > 0 && (
                  <>
                    {" "}
                    — Total added to budget: <strong>{fmtCurrency(totalOverage)}</strong>
                  </>
                )}
              </p>
              {confirmAllError && <p class="form-error">{confirmAllError}</p>}
              <button
                type="button"
                class="btn btn--primary"
                disabled={confirmingAll}
                onClick={() => void handleConfirmAll()}
              >
                {confirmingAll ? "Sending…" : "Confirm & Sign All Selections"}
              </button>
            </>
          ) : (
            <>
              <p class="selection-card__hint" style={{ marginBottom: "10px" }}>
                Choose an option for every allowance above, then sign once to confirm everything.
              </p>
              <button type="button" class="btn btn--primary" disabled>
                Confirm & Sign All Selections
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
