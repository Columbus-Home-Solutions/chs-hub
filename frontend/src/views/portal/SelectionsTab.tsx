/**
 * SelectionsTab — Sprint 38 Run 4.
 *
 * Client-portal view of material/finish selections.
 *
 * GET  /api/portal/:token/selections
 * GET  /api/portal/:token/selections/:id/sign-link
 * POST /api/portal/:token/selections/:id/approve  { choice_id }
 */

import { useEffect, useState } from "preact/hooks";
import { getJson, portalToken } from "./portalApi";
import { ClientSelection, ClientSelectionsPanel } from "../../components/ClientSelectionCards";

interface SelectionsPayload {
  selections: ClientSelection[];
}

export function SelectionsTab() {
  const token = portalToken();
  const [hasSelections, setHasSelections] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<SelectionsPayload>(`/api/portal/${token}/selections`)
      .then((d) => setHasSelections(d.selections.length > 0))
      .catch((e) => setError((e as Error).message));
  }, [token]);

  if (error) {
    return <div class="portal-tab-error">{error}</div>;
  }

  if (hasSelections === null) {
    return <div class="portal-tab-loading">Loading selections…</div>;
  }

  if (!hasSelections) {
    return (
      <div class="portal-card portal-empty">
        <p>No selections have been assigned to your project yet.</p>
        <p class="portal-empty__sub">
          Your project manager will add material or finish choices for you to review here.
        </p>
      </div>
    );
  }

  return (
    <div class="portal-tab">
      <ClientSelectionsPanel
        listUrl={`/api/portal/${token}/selections`}
        approveUrl={(selectionId) => `/api/portal/${token}/selections/${selectionId}/approve`}
        individualSignLinkUrl={(selectionId) =>
          `/api/portal/${token}/selections/${selectionId}/sign-link`
        }
        pollWhilePending
      />
    </div>
  );
}
