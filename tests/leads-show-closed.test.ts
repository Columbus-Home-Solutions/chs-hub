import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const kanban = readFileSync(join(repoRoot, "frontend/src/views/estimating/CHSLeadsKanban.tsx"), "utf8");

describe("CHS Leads show-closed defaults", () => {
  it("opens Kanban with Won/Lost and List without them, independently", () => {
    expect(kanban).toContain("useState(true)");
    expect(kanban).toContain("useState(false)");
    expect(kanban).toContain("setKanbanShowClosed");
    expect(kanban).toContain("setListShowClosed");
    expect(kanban).toContain('viewMode === "kanban" ? kanbanShowClosed : listShowClosed');
    expect(kanban).toContain("stagesForClosed(kanbanShowClosed)");
    expect(kanban).toContain("stagesForClosed(listShowClosed)");
  });

  it("does not persist the toggle and clears a previously saved key", () => {
    expect(kanban).toContain('localStorage.removeItem(CLOSED_TOGGLE_KEY)');
    expect(kanban).toContain('const CLOSED_TOGGLE_KEY = "chs_leads_show_closed"');
    expect(kanban).not.toContain("localStorage.setItem(CLOSED_TOGGLE_KEY");
    expect(kanban).not.toContain("localStorage.getItem(CLOSED_TOGGLE_KEY");
  });
});
