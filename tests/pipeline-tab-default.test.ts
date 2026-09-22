import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseQueryParam } from "../frontend/src/hooks/useUrlTab";
import { SIDEBAR_NAV } from "../frontend/src/lib/sidebar-nav";
import { to } from "../frontend/src/lib/nav";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pipeline = readFileSync(
  join(repoRoot, "frontend/src/views/estimating/EstimateRequestPipeline.tsx"),
  "utf8",
);
const detail = readFileSync(
  join(repoRoot, "frontend/src/views/estimating/EstimateRequestDetail.tsx"),
  "utf8",
);

const TABS = new Set(["hl", "chs"] as const);

describe("Pipeline tab default — CHS Leads", () => {
  it("defaults to CHS Leads when no ?tab= is present", () => {
    expect(parseQueryParam("", "tab", TABS, "chs")).toBe("chs");
    expect(parseQueryParam("stage=new_request", "tab", TABS, "chs")).toBe("chs");
  });

  it("lets an explicit URL param win in both directions", () => {
    expect(parseQueryParam("tab=chs&stage=new_request", "tab", TABS, "chs")).toBe("chs");
    expect(parseQueryParam("tab=hl", "tab", TABS, "chs")).toBe("hl");
  });

  it("does not remember the last tab in localStorage", () => {
    expect(pipeline).not.toMatch(/localStorage\.(get|set)Item/);
    expect(pipeline).not.toContain("chs_pipeline_active_tab");
    expect(pipeline).toContain('parseQueryParam(currentSearch, "tab", TABS, "chs")');
  });

  it("still exposes the HL Pipeline tab for a same-visit manual click", () => {
    expect(pipeline).toContain("HL Pipeline");
    expect(pipeline).toContain('setSessionTab("hl")');
    expect(pipeline).toContain('setSessionTab("chs")');
  });

  it("lead detail back arrow goes to /estimating with no HL tab state", () => {
    expect(detail).toContain('go("/estimating")');
    expect(detail).not.toMatch(/go\("\/estimating\?tab=hl"\)/);
  });

  it("sidebar Leads stays active on /estimating with no tab (back-arrow landing)", () => {
    const leads = SIDEBAR_NAV.find((s) => s.id === "pipeline")?.children?.find((c) => c.label === "Leads");
    expect(leads?.href).toBe(to("/estimating") + "?tab=chs");
    expect(leads?.activeTest?.(to("/estimating"), "")).toBe(true);
    expect(leads?.activeTest?.(to("/estimating"), "tab=chs&stage=new_request")).toBe(true);
    expect(leads?.activeTest?.(to("/estimating"), "tab=hl")).toBe(false);
  });
});
