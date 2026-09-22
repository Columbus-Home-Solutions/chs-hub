/**
 * EstimateRequestPipeline — Sprint 23 update
 * Now a tabbed coordinator:
 *   Tab 1: "HL Pipeline"  — existing HighLevel Kanban (zero changes to HL code)
 *   Tab 2: "CHS Leads"    — native estimate_requests pipeline (CHSLeadsKanban)
 *
 * CHS Leads is the hard default on every mount. Manual HL clicks last only for
 * this visit; they are not written to localStorage or the URL. An explicit
 * `?tab=hl` / `?tab=chs` (dashboard stage taps) still wins.
 */
import type { RoutableProps } from "preact-router";
import { useRouter } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { parseQueryParam } from "../../hooks/useUrlTab";
import { LeadPipeline } from "../dashboard/LeadPipeline";
import { CHSLeadsKanban } from "./CHSLeadsKanban";
import { useApi } from "../../hooks/useApi";

type PipelineTab = "hl" | "chs";
const TABS = new Set<PipelineTab>(["hl", "chs"]);

interface CountResponse {
  counts?: Record<string, number>;
}

export function EstimateRequestPipeline(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const currentSearch = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const urlTab = parseQueryParam(currentSearch, "tab", TABS, "chs");

  const [sessionTab, setSessionTab] = useState<PipelineTab | null>(null);
  const [newRequestCount, setNewRequestCount] = useState(0);
  const [highlightStage, setHighlightStage] = useState<string | null>(null);

  // Lightweight pipeline fetch just to get the new_request badge count.
  const { data: pipelineData } = useApi<CountResponse>("/api/estimate-requests/pipeline");

  useEffect(() => {
    if (pipelineData?.counts?.new_request !== undefined) {
      setNewRequestCount(pipelineData.counts.new_request);
    }
  }, [pipelineData]);

  // Keep ?stage= in sync when sidebar deep-links into CHS Leads.
  useEffect(() => {
    const params = new URLSearchParams(currentSearch);
    const stageParam = params.get("stage");
    if (stageParam) setHighlightStage(stageParam);
  }, [currentSearch]);

  // Incoming navigation (dashboard ?tab=, sidebar, back to /estimating) wins
  // over a same-visit manual click.
  useEffect(() => {
    setSessionTab(null);
  }, [url]);

  const activeTab = sessionTab ?? urlTab;

  return (
    <div>
      {/* Top-level tab bar */}
      <div class="pipeline-tab-bar">
        <button
          type="button"
          class={`pipeline-tab-bar__tab${activeTab === "hl" ? " pipeline-tab-bar__tab--active" : ""}`}
          onClick={() => setSessionTab("hl")}
        >
          HL Pipeline
        </button>
        <button
          type="button"
          class={`pipeline-tab-bar__tab${activeTab === "chs" ? " pipeline-tab-bar__tab--active" : ""}`}
          onClick={() => setSessionTab("chs")}
        >
          CHS Leads
          {newRequestCount > 0 && (
            <span class="pipeline-tab-bar__badge">{newRequestCount}</span>
          )}
        </button>
      </div>

      {activeTab === "hl" && (
        <div class="pipeline-tab-content">
          <LeadPipeline />
        </div>
      )}

      {activeTab === "chs" && (
        <div class="pipeline-tab-content">
          <CHSLeadsKanban onNewRequestCount={setNewRequestCount} highlightStage={highlightStage ?? undefined} />
        </div>
      )}
    </div>
  );
}
