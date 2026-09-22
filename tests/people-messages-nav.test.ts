import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV } from "../frontend/src/lib/sidebar-nav";
import { messagesHref, parseMessagesSearch } from "../frontend/src/components/messages/href";
import { conversationsUrl } from "../frontend/src/components/messages/helpers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("People nav — Messages", () => {
  const people = SIDEBAR_NAV.find((s) => s.id === "people");

  it("keeps Clients, Payers, Subs, Labor and adds Messages", () => {
    expect(people).toBeTruthy();
    const labels = people!.children!.map((c) => c.label);
    expect(labels).toEqual(["Clients", "Payers", "Subs", "Labor", "Messages"]);
  });

  it("routes Messages to /app/people/messages", () => {
    const messages = people!.children!.find((c) => c.label === "Messages");
    expect(messages?.href).toBe("/app/people/messages");
    expect(messagesHref()).toBe("/app/people/messages");
  });
});

describe("messagesHref / parseMessagesSearch", () => {
  it("carries client selection", () => {
    expect(messagesHref({ clientId: "c-1" })).toBe("/app/people/messages?client=c-1");
    expect(parseMessagesSearch("client=c-1")).toEqual({
      tab: "clients",
      clientId: "c-1",
      noteId: null,
    });
  });

  it("carries unassigned tab and note", () => {
    expect(messagesHref({ tab: "unassigned", noteId: "n-9" })).toBe(
      "/app/people/messages?tab=unassigned&note=n-9",
    );
    expect(parseMessagesSearch("tab=unassigned&note=n-9")).toEqual({
      tab: "unassigned",
      clientId: null,
      noteId: "n-9",
    });
  });

  it("does not add a third tab — archived is a list filter query, not a People route", () => {
    expect(conversationsUrl(false)).toBe("/api/sms/conversations");
    expect(conversationsUrl(true)).toBe("/api/sms/conversations?archived=1");
    expect(parseMessagesSearch("tab=unassigned").tab).toBe("unassigned");
    expect(parseMessagesSearch("").tab).toBe("clients");
  });
});

describe("Messages full-page layout (Option A)", () => {
  it("uses the standard view-header, not a modal/card wrapper", () => {
    const src = readFileSync(join(repoRoot, "frontend/src/views/people/Messages.tsx"), "utf8");
    expect(src).toContain('class="view-header"');
    expect(src).toContain('class="view-title"');
    expect(src).toContain('class="view-subtitle"');
    expect(src).not.toMatch(/class="modal/);
    expect(src).not.toMatch(/mc-panel/);
  });

  it("does not style the page as a centered rounded card", () => {
    const css = readFileSync(join(repoRoot, "frontend/src/styles/app.css"), "utf8");
    const start = css.indexOf("Full-page Messages (People)");
    const end = css.indexOf("Mobile notification panel");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = css.slice(start, end);
    expect(block).not.toMatch(/border-radius/);
    expect(block).not.toMatch(/box-shadow/);
    expect(block).toContain("max-width: none");
    expect(block).not.toMatch(/height:\s*calc\(100vh/);
  });
});
