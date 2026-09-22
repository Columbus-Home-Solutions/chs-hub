import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeJobRag,
  daysPastTarget,
  isOutOfRangeEntry,
  overallScheduleProgress,
} from "../src/lib/schedule-rag.js";
import { normalizeScheduleEntryType, isScheduleEntryType } from "../src/lib/schedule-entry-type.js";
import {
  TYPE_DEADLINE,
  TYPE_PERMIT_INSPECTION,
  TYPE_PROPOSAL_REVIEW,
  TYPE_WARRANTY_CALL,
  eventTypeLabel,
  getCalendarColor,
  type CalendarEvent,
} from "../src/lib/calendar-colors.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "1",
    type: "job_appointment",
    title: "Work",
    date: "2026-09-20",
    start_time: null,
    end_time: null,
    assigned_user_id: null,
    assigned_user_name: null,
    assigned_user_color: null,
    assigned_sub_id: null,
    assigned_sub_name: null,
    assigned_sub_color: null,
    job_id: null,
    job_number: null,
    job_title: null,
    link_path: null,
    meet_link: null,
    description: null,
    status: null,
    ...partial,
  };
}

describe("schedule entry_type", () => {
  it("allows job_task and deadline and rejects other values", () => {
    expect(isScheduleEntryType("deadline")).toBe(true);
    expect(isScheduleEntryType("job_task")).toBe(true);
    expect(isScheduleEntryType("permit_inspection")).toBe(false);
    expect(normalizeScheduleEntryType("deadline")).toBe("deadline");
    expect(normalizeScheduleEntryType(null)).toBe("job_task");
  });

  it("adds entry_type via additive migration, no CHECK rebuild", () => {
    const sql = readFileSync(join(repoRoot, "migrations/0124_schedule_entry_type.sql"), "utf8");
    expect(sql).toContain("ALTER TABLE schedule_entries ADD COLUMN entry_type");
    expect(sql).not.toMatch(/CHECK\s*\(\s*entry_type/);
  });
});

describe("calendar colors + labels", () => {
  it("colors warranty calls teal, not brand amber", () => {
    expect(TYPE_WARRANTY_CALL).toBe("#14B8A6");
    expect(getCalendarColor(ev({ type: "warranty_call", assigned_user_id: "u1" }))).toBe("#14B8A6");
    expect(getCalendarColor(ev({ type: "warranty_call" }))).toBe("#6B7280");
  });

  it("types permit inspections, deadlines, and proposal reviews", () => {
    expect(getCalendarColor(ev({ type: "permit_inspection" }))).toBe(TYPE_PERMIT_INSPECTION);
    expect(getCalendarColor(ev({ type: "deadline" }))).toBe(TYPE_DEADLINE);
    expect(getCalendarColor(ev({ type: "proposal_review" }))).toBe(TYPE_PROPOSAL_REVIEW);
    expect(eventTypeLabel("permit_inspection")).toBe("Permit Inspection");
    expect(eventTypeLabel("deadline")).toBe("Deadline");
  });

  it("keeps job-task color on the assigned user, not the sub", () => {
    expect(
      getCalendarColor(
        ev({
          assigned_user_color: "#3B82F6",
          assigned_sub_color: "#10B981",
          assigned_sub_name: "Acme Electric",
        }),
      ),
    ).toBe("#3B82F6");
  });
});

describe("RAG heuristic (draft)", () => {
  it("marks behind when the target end has passed on an open job", () => {
    expect(
      computeJobRag({
        status: "in_progress",
        targetEndDate: "2026-09-01",
        today: "2026-09-20",
        hasIncompletePermitInspection: false,
        hasOutOfRangeEntry: false,
      }),
    ).toBe("behind");
  });

  it("marks at_risk for a scheduled permit inspection or out-of-range entry", () => {
    expect(
      computeJobRag({
        status: "scheduled",
        targetEndDate: "2026-10-01",
        today: "2026-09-20",
        hasIncompletePermitInspection: true,
        hasOutOfRangeEntry: false,
      }),
    ).toBe("at_risk");
    expect(
      computeJobRag({
        status: "scheduled",
        targetEndDate: "2026-10-01",
        today: "2026-09-20",
        hasIncompletePermitInspection: false,
        hasOutOfRangeEntry: true,
      }),
    ).toBe("at_risk");
  });

  it("is on_track otherwise, including complete jobs and missing dates", () => {
    expect(
      computeJobRag({
        status: "in_progress",
        targetEndDate: "2026-10-01",
        today: "2026-09-20",
        hasIncompletePermitInspection: false,
        hasOutOfRangeEntry: false,
      }),
    ).toBe("on_track");
    expect(
      computeJobRag({
        status: "complete",
        targetEndDate: "2026-09-01",
        today: "2026-09-20",
        hasIncompletePermitInspection: false,
        hasOutOfRangeEntry: false,
      }),
    ).toBe("on_track");
  });

  it("clamps the overall-schedule progress bar and flags out-of-range days", () => {
    expect(overallScheduleProgress("2026-09-01", "2026-09-10", "2026-08-20").pct).toBe(0);
    expect(overallScheduleProgress("2026-09-01", "2026-09-10", "2026-09-20").pct).toBe(100);
    expect(overallScheduleProgress("2026-09-01", "2026-09-11", "2026-09-06").pct).toBe(50);
    expect(isOutOfRangeEntry("2026-09-12", "2026-09-10")).toBe(true);
    expect(daysPastTarget("2026-09-12", "2026-09-10")).toBe(2);
  });
});

describe("calendar feed failure", () => {
  it("returns a loud 500 payload instead of an empty events array", async () => {
    const { calendarFeedFailure } = await import("../src/routes/calendar-events.js");
    const body = calendarFeedFailure(new Error("no such column: entry_type"));
    expect(body.error).toBe("calendar_feed_failed");
    expect(body.details).toContain("entry_type");
    expect(body).not.toHaveProperty("events");
  });
});

describe("schedule redesign UI wiring", () => {
  it("defaults Overall Schedule to Today and exposes all four views", () => {
    const src = readFileSync(join(repoRoot, "frontend/src/views/jobs/ScheduleCalendar.tsx"), "utf8");
    expect(src).toContain('useUrlTab(MODES, "today", "view")');
    expect(src).toContain("This Week");
    expect(src).toContain("Timeline");
    expect(src).toContain("Month");
    expect(src).toContain("Showing:");
    expect(src).toContain("Everyone");
    expect(src).toContain("os-rag");
    expect(src).not.toMatch(/#F59E0B/);
    expect(src).toContain("Schedule feed failed");
  });

  it("adds the job-tab banner and Sub badge without touching the dashboard widget", () => {
    const tab = readFileSync(join(repoRoot, "frontend/src/views/jobs/ScheduleTab.tsx"), "utf8");
    const dash = readFileSync(join(repoRoot, "frontend/src/views/dashboard/TodaySchedule.tsx"), "utf8");
    expect(tab).toContain("Overall Schedule");
    expect(tab).toContain("Sub: {e.sub_name}");
    expect(tab).toContain("+ Add Deadline");
    expect(dash).toContain("Today's Schedule");
    expect(dash).not.toContain("Overall Schedule");
  });
});
