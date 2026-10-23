import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../frontend/src/lib/calendar-colors";
import { MONTH_VISIBLE_CHIPS, monthChipTooltip } from "../frontend/src/lib/schedule-chip";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(repoRoot, "frontend/src/styles/app.css"), "utf8");
const view = readFileSync(join(repoRoot, "frontend/src/views/jobs/ScheduleCalendar.tsx"), "utf8");

const LONG_TITLE = "JOB-104 Kitchen Cabinets and Countertops — 6 Roxbury Drive JOB-104";

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "1",
    type: "job_appointment",
    title: LONG_TITLE,
    date: "2026-10-12",
    start_time: "08:00",
    end_time: "12:00",
    assigned_user_id: null,
    assigned_user_name: null,
    assigned_user_color: null,
    assigned_sub_id: null,
    assigned_sub_name: null,
    assigned_sub_color: null,
    job_id: "job-1",
    job_number: 104,
    job_title: "Kitchen Cabinets and Countertops",
    link_path: null,
    meet_link: null,
    description: null,
    status: null,
    ...partial,
  };
}

describe("month schedule tiles", () => {
  it("keeps seven equal columns so a long title cannot widen a day", () => {
    expect(css).toMatch(/\.cal__weekdays\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.cal__month-grid\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.cal--month \.cal-cell\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.cal--month \.cal-cell\s*\{[^}]*height:\s*7\.5rem/);
    expect(css).toMatch(/\.cal--month \.cal-cell\s*\{[^}]*max-height:\s*7\.5rem/);
    expect(css).not.toMatch(/grid-template-columns:\s*repeat\(7,\s*1fr\)/);
  });

  it("ellipsizes each month chip on one line", () => {
    expect(css).toMatch(
      /\.cal--month \.cal-chip__work\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/,
    );
    expect(view).toContain("class=\"cal-chip__work\"");
    expect(view).not.toContain("title={e.title}");
  });

  it("puts the full title, job, time, assignee, and type in the tooltip", () => {
    const text = monthChipTooltip(ev({}));
    expect(text).toContain(LONG_TITLE);
    expect(text).toContain("JOB-104");
    expect(text).toContain("08:00–12:00");
    expect(text).toContain("Unassigned");
    expect(text).toContain("Job appointment");
    expect(monthChipTooltip(ev({ assigned_user_name: "Alex", start_time: null, end_time: null }))).toContain("Alex");
    expect(view).toContain('role="tooltip"');
    expect(view).toContain("monthChipTooltip");
  });

  it("caps a day at three chips and opens the rest from +N more", () => {
    expect(MONTH_VISIBLE_CHIPS).toBe(3);
    expect(view).toContain("entries.slice(0, MONTH_VISIBLE_CHIPS)");
    expect(view).toContain("class=\"cal-cell__more\"");
    expect(view).toContain("setSelectedDay(day)");
  });
});
