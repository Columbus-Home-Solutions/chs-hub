/**
 * EstimateRequestPipeline — Sprint 23 update
 * Now a tabbed coordinator:
 *   Tab 1: "HL Pipeline"  — existing HighLevel Kanban (zero changes to HL code)
 *   Tab 2: "CHS Leads"    — native estimate_requests pipeline (CHSLeadsKanban)
 *
 * Tab selection is persisted in localStorage so it survives navigation.
 * The CHS Leads tab shows a badge with the count of new_request stage leads.
 */
import type { RoutableProps } from "preact-router";
import { useRouter } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { useUrlTab } from "../../hooks/useUrlTab";
import { LeadPipeline } from "../dashboard/LeadPipeline";
import { CHSLeadsKanban } from "./CHSLeadsKanban";
import { useApi } from "../../hooks/useApi";

const TAB_STORAGE_KEY = "chs_pipeline_active_tab";

type PipelineTab = "hl" | "chs";

function storedTab(): PipelineTab {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    if (v === "chs" || v === "hl") return v;
  } catch {
    // ignore
  }
  return "hl";
}

interface CountResponse {
  counts?: Record<string, number>;
}

export function EstimateRequestPipeline(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const currentSearch = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";

  const [activeTab, setActiveTab] = useUrlTab(["hl", "chs"] as const, "hl");
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

  const switchTab = (tab: PipelineTab) => {
    setActiveTab(tab);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  };

  return (
    <div>
      {/* Top-level tab bar */}
      <div class="pipeline-tab-bar">
        <button
          type="button"
          class={`pipeline-tab-bar__tab${activeTab === "hl" ? " pipeline-tab-bar__tab--active" : ""}`}
          onClick={() => switchTab("hl")}
        >
          HL Pipeline
        </button>
        <button
          type="button"
          class={`pipeline-tab-bar__tab${activeTab === "chs" ? " pipeline-tab-bar__tab--active" : ""}`}
          onClick={() => switchTab("chs")}
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
