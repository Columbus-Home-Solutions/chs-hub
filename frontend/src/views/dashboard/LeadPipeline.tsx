import { useEffect, useRef, useState } from "preact/hooks";
import { go } from "../../lib/nav";

interface HLOpportunity {
  id: string;
  name: string;
  phone?: string;
  source?: string;
  pipelineStageId?: string;
  dateAdded?: string;
}

interface HLPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

// HL stage name → CHS display label. Stage names from the HL API are compared
// case-insensitively. Unmapped stages fall through to their raw HL name.
// Lead Nurture Campaign stages are grouped under "Nurture" so they appear in
// their own column instead of being silently hidden or mislabeled.
export const HL_STAGE_MAP: Record<string, string> = {
  // Main pipeline
  "New Lead": "New Lead",
  "Contacted / Follow Up": "Contacted / Follow Up",
  "Appointment Set": "Appointment Set",
  "Estimate Sent": "Estimate Sent",
  // Lead Nurture Campaign stages → Nurture column
  "Purgatory": "Nurture",
  "Emails Round 1": "Nurture",
  "Emails Round 2": "Nurture",
  "Emails Round 1 ": "Nurture", // trailing-space variant
  "Emails Round 2 ": "Nurture",
  "SMS Round 1": "Nurture",
  "SMS Round 1 ": "Nurture",
  "Drip Campaign": "Nurture",
  "Drip Campaign ": "Nurture",
};

// HL stages to show in the condensed Kanban (subset of full pipeline).
const DISPLAY_STAGES = [
  "New Lead",
  "Contacted / Follow Up",
  "Appointment Set",
  "Estimate Sent",
  "Nurture",
];

function stageAge(dateAdded: string | undefined): string {
  if (!dateAdded) return "";
  const days = Math.floor((Date.now() - new Date(dateAdded).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "1d";
  return `${days}d`;
}

export function LeadPipeline() {
  const [pipelines, setPipelines] = useState<HLPipeline[]>([]);
  const [opportunities, setOpportunities] = useState<HLOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragStage = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [plRes, oppRes] = await Promise.all([
          fetch("/api/hl/opportunities/pipelines").then((r) => {
            if (!r.ok) throw new Error("HL not connected");
            return r.json() as Promise<{ pipelines: HLPipeline[] }>;
          }),
          fetch("/api/hl/opportunities/search?limit=50").then((r) => {
            if (!r.ok) throw new Error("HL not connected");
            return r.json() as Promise<{ opportunities: HLOpportunity[] }>;
          }),
        ]);
        if (!cancelled) {
          setPipelines(plRes.pipelines ?? []);
          setOpportunities(oppRes.opportunities ?? []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "HighLevel not connected");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div class="dash-card dash-card--full">
        <div class="dash-card__header"><h2 class="dash-card__title">Lead Pipeline</h2></div>
        <div class="dash-card__body">
          <div class="lead-pipeline--skeleton" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card dash-card--full">
        <div class="dash-card__header"><h2 class="dash-card__title">Lead Pipeline</h2></div>
        <div class="dash-card__body dash-card__body--error">
          <span>HighLevel not connected.</span>{" "}
          <button class="link-btn" onClick={() => go("/settings/integrations")}>
            Settings → Integrations
          </button>
        </div>
      </div>
    );
  }

  // Collect all stages across all pipelines (to handle nurture campaigns
  // which may live in a separate pipeline from the main CHS pipeline).
  const allStages = pipelines.flatMap((p) => p.stages);

  // Map each HL stage name → CHS display label using HL_STAGE_MAP.
  // Stages not in the map use their raw HL name as the display label.
  function resolveDisplayLabel(stageName: string): string {
    const exact = HL_STAGE_MAP[stageName];
    if (exact) return exact;
    // Case-insensitive fallback.
    const lower = stageName.toLowerCase().trim();
    for (const [key, val] of Object.entries(HL_STAGE_MAP)) {
      if (key.toLowerCase().trim() === lower) return val;
    }
    return stageName;
  }

  // Build a virtual column list from DISPLAY_STAGES order. Each column
  // accumulates opportunities whose stage name resolves to that display label.
  const columnDefs = DISPLAY_STAGES.map((label) => ({
    label,
    // All stage IDs (across all pipelines) that map to this display label.
    stageIds: allStages
      .filter((s) => resolveDisplayLabel(s.name) === label)
      .map((s) => s.id),
  })).filter((col) => col.stageIds.length > 0);

  // Fallback: if no mapped stages found, show first pipeline's first 4 stages.
  const shownColumns = columnDefs.length > 0
    ? columnDefs
    : (pipelines[0]?.stages ?? []).slice(0, 4).map((s) => ({
        label: s.name,
        stageIds: [s.id],
      }));

  // Group opportunities by resolved display label.
  const oppsByLabel = new Map<string, HLOpportunity[]>();
  for (const opp of opportunities) {
    const sid = opp.pipelineStageId ?? "";
    const stage = allStages.find((s) => s.id === sid);
    const label = stage ? resolveDisplayLabel(stage.name) : null;
    if (!label || !DISPLAY_STAGES.includes(label)) continue;
    if (!oppsByLabel.has(label)) oppsByLabel.set(label, []);
    oppsByLabel.get(label)!.push(opp);
  }

  // Keep the old oppsByStage for drag-drop write-back (we still move by actual stage ID).
  const oppsByStage = new Map<string, HLOpportunity[]>();
  for (const opp of opportunities) {
    const sid = opp.pipelineStageId ?? "";
    if (!oppsByStage.has(sid)) oppsByStage.set(sid, []);
    oppsByStage.get(sid)!.push(opp);
  }

  const handleDrop = async (stageId: string) => {
    if (!dragging || !stageId) return;
    const oppId = dragging;
    setDragging(null);
    try {
      await fetch(`/api/hl/opportunities/${oppId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pipelineStageId: stageId }),
      });
      // Optimistic update.
      setOpportunities((prev) =>
        prev.map((o) => (o.id === oppId ? { ...o, pipelineStageId: stageId } : o)),
      );
    } catch {
      // Silent failure — HL write-back is best-effort on the dashboard.
    }
  };

  return (
    <div class="dash-card dash-card--full">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Lead Pipeline</h2>
        <button class="link-btn" onClick={() => go("/estimating")}>
          View Full Pipeline →
        </button>
      </div>
      <div class="dash-card__body">
        <div class="lead-pipeline">
          {shownColumns.map((col) => {
            const cards = oppsByLabel.get(col.label) ?? [];
            // Use the first real stage ID for drag-drop write-back.
            const primaryStageId = col.stageIds[0] ?? "";
            return (
              <div
                key={col.label}
                class="lead-col"
                onDragOver={(e) => { e.preventDefault(); dragStage.current = primaryStageId; }}
                onDrop={() => handleDrop(primaryStageId)}
              >
                <div class="lead-col__header">
                  <span class="lead-col__name">{col.label}</span>
                  <span class="lead-col__count">{cards.length}</span>
                </div>
                <div class="lead-col__body">
                  {cards.map((opp) => (
                    <div
                      key={opp.id}
                      class="lead-card"
                      draggable
                      onDragStart={() => setDragging(opp.id)}
                      onDragEnd={() => setDragging(null)}
                    >
                      <div class="lead-card__name">{opp.name}</div>
                      <div class="lead-card__meta">
                        {opp.phone && <span class="lead-card__phone">{opp.phone}</span>}
                        {opp.source && <span class="lead-card__source">{opp.source}</span>}
                        <span class="lead-card__age">{stageAge(opp.dateAdded)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
