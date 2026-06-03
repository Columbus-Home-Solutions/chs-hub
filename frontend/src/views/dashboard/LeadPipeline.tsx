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

// HL stages to show in the condensed Kanban (subset of full pipeline).
const DISPLAY_STAGES = [
  "New Lead",
  "Contacted / Follow Up",
  "Appointment Set",
  "Estimate Sent",
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

  // Use the first pipeline found (main CHS pipeline).
  const pipeline = pipelines[0];
  const stages = pipeline?.stages ?? [];

  // Filter to display stages only.
  const displayStages = stages.filter((s) =>
    DISPLAY_STAGES.some((d) => s.name.toLowerCase().includes(d.toLowerCase())),
  );
  const shownStages = displayStages.length > 0 ? displayStages : stages.slice(0, 4);

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
          {shownStages.map((stage) => {
            const cards = oppsByStage.get(stage.id) ?? [];
            return (
              <div
                key={stage.id}
                class="lead-col"
                onDragOver={(e) => { e.preventDefault(); dragStage.current = stage.id; }}
                onDrop={() => handleDrop(stage.id)}
              >
                <div class="lead-col__header">
                  <span class="lead-col__name">{stage.name}</span>
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
