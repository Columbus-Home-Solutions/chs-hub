import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleUntouchedLeads } from "../src/routes/estimate-requests.js";
import type { Env } from "../src/env.js";
import { SIDEBAR_NAV } from "../frontend/src/lib/sidebar-nav";
import { untouchedIsAmber, UNTOUCHED_STALE_MS } from "../frontend/src/lib/untouched-leads";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("untouched lead count", () => {
  it("counts new_request only and drops test clients", async () => {
    let sql = "";
    const env = {
      DB: {
        prepare(q: string) {
          sql = q;
          return {
            async first() {
              return { count: 2, oldest_created_at: "2026-09-22T10:00:00Z" };
            },
          };
        },
      },
    } as unknown as Env;

    const res = await handleUntouchedLeads(env);
    expect(sql).toContain("er.status = 'new_request'");
    expect(sql).toContain("is_test");
    expect(sql).not.toMatch(/status IN \(/);
    expect(await res.json()).toEqual({
      count: 2,
      oldest_created_at: "2026-09-22T10:00:00Z",
    });
  });

  it("returns zero when nothing is new", async () => {
    const env = {
      DB: {
        prepare() {
          return { async first() { return { count: 0, oldest_created_at: null }; } };
        },
      },
    } as unknown as Env;
    expect(await (await handleUntouchedLeads(env)).json()).toEqual({
      count: 0,
      oldest_created_at: null,
    });
  });
});

describe("untouched badge age", () => {
  const now = Date.parse("2026-09-22T18:00:00Z");

  it("stays neutral until the oldest lead is more than an hour old", () => {
    expect(untouchedIsAmber(new Date(now - UNTOUCHED_STALE_MS).toISOString(), now)).toBe(false);
    expect(untouchedIsAmber(new Date(now - UNTOUCHED_STALE_MS + 1000).toISOString(), now)).toBe(false);
  });

  it("turns amber after one hour", () => {
    expect(untouchedIsAmber(new Date(now - UNTOUCHED_STALE_MS - 1000).toISOString(), now)).toBe(true);
  });

  it("stays neutral with no leads", () => {
    expect(untouchedIsAmber(null, now)).toBe(false);
  });
});

describe("untouched badge placement", () => {
  const sidebar = read("frontend/src/components/layout/Sidebar.tsx");
  const more = read("frontend/src/components/layout/MoreNavSheet.tsx");
  const phone = read("frontend/src/components/layout/AppShell.tsx");
  const tablet = read("frontend/src/components/layout/TabletSidebar.tsx");
  const badge = read("frontend/src/components/layout/UntouchedLeadsBadge.tsx");
  const hook = read("frontend/src/hooks/useUntouchedLeads.ts");
  const topnav = read("frontend/src/components/layout/TopNav.tsx");

  it("lands Leads on the CHS tab", () => {
    const leads = SIDEBAR_NAV.find((s) => s.id === "pipeline")!.children!.find((c) => c.label === "Leads");
    expect(leads?.href).toBe("/app/estimating?tab=chs");
  });

  it("badges the desktop Pipeline/Leads item and the phone and iPad More entry", () => {
    expect(sidebar).toContain('section.id === "pipeline"');
    expect(sidebar).toContain('child.label === "Leads"');
    expect(more).toContain('child.label === "Leads"');
    expect(phone).toContain('tab.path === "__more__"');
    expect(tablet).toContain('tab.path === "__more__"');
    expect(badge).toContain('tone={amber ? "warning" : "neutral"}');
    expect(badge).toContain("count <= 0");
  });

  it("refreshes on route change and on a 60s visible-tab interval", () => {
    expect(hook).toContain("/api/estimate-requests/untouched");
    expect(hook).toContain("60_000");
    expect(hook).toContain("visibilityState");
    expect(hook).toContain("[url]");
  });

  it("does not touch the notification bell", () => {
    expect(topnav).not.toContain("UntouchedLeads");
    expect(topnav).not.toContain("/api/estimate-requests/untouched");
  });
});
