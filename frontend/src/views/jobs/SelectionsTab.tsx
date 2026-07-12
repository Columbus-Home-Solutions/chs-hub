/**
 * Owner-facing selections on Job Detail — read-only status plus mid-job allowance creation.
 */

import { useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { ClientSelectionsPanel } from "../../components/ClientSelectionCards";
import { SelectionFormModal } from "../estimating/SelectionFormModal";
import { go } from "../../lib/nav";

export function SelectionsTab({
  jobId,
  estimateId,
}: {
  jobId: string;
  estimateId: string | null;
}) {
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div class="tab-content">
      <div class="flex items-center justify-between gap-sm" style={{ marginBottom: "var(--space-md)" }}>
        <h2 class="view-title" style={{ fontSize: "var(--text-lg)", margin: 0 }}>
          Selections &amp; Allowances
        </h2>
        <div class="flex items-center gap-sm">
          <Button size="sm" variant="primary" onClick={() => setAllowanceOpen(true)}>
            + Add Allowance
          </Button>
          {estimateId && (
            <Button variant="secondary" size="sm" onClick={() => go(`/estimates/${estimateId}`)}>
              View estimate →
            </Button>
          )}
        </div>
      </div>

      <ClientSelectionsPanel
        listUrl={`/api/jobs/${jobId}/selections`}
        approveUrl={() => ""}
        readOnly
        refreshKey={refreshKey}
        emptyMessage="No selections have been added for this job yet."
      />

      <SelectionFormModal
        open={allowanceOpen}
        onClose={() => setAllowanceOpen(false)}
        onCreated={() => {
          setAllowanceOpen(false);
          setRefreshKey((k) => k + 1);
        }}
        jobId={jobId}
      />
    </div>
  );
}
