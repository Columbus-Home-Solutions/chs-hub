import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const kanban = readFileSync(join(repoRoot, "frontend/src/views/estimating/CHSLeadsKanban.tsx"), "utf8");

describe("CHS Leads bulk-select (New Request only)", () => {
  it("reuses the existing list/kanban toggle persisted as chs_leads_view", () => {
    expect(kanban).toContain('loadStoredView("chs_leads_view")');
    expect(kanban).toContain("<ViewToggle");
  });

  it("scopes checkboxes and Select All to new_request rows", () => {
    expect(kanban).toContain('r.status === "new_request"');
    expect(kanban).toContain('sorted.filter((r) => r.status === "new_request")');
    expect(kanban).toContain("Select all New Request leads");
    expect(kanban).not.toMatch(/status === "appointment_set".*checkbox/s);
  });

  it("uses the Photos-style select bar: count, Select All, Delete Selected, Cancel", () => {
    expect(kanban).toContain("leads-bulk-bar");
    expect(kanban).toContain("Delete Selected");
    expect(kanban).toContain("selectedIds.size} selected");
    expect(kanban).toContain("Select All");
    expect(kanban).toContain("Cancel");
    expect(kanban).toContain("Delete {selectedIds.size} lead");
    expect(kanban).toContain("This cannot be undone.");
  });

  it("calls the bulk-delete endpoint rather than inventing a second delete path", () => {
    expect(kanban).toContain('/api/estimate-requests/bulk-delete');
  });

  it("does not add select-mode checkboxes to kanban cards", () => {
    const cardStart = kanban.indexOf("function LeadCard");
    const cardEnd = kanban.indexOf("export function CHSLeadsKanban");
    const card = kanban.slice(cardStart, cardEnd);
    expect(card).not.toContain("checkbox");
    expect(card).not.toContain("selectMode");
  });
});
