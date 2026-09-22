import { describe, expect, it } from "vitest";
import {
  applyConversationStatePatch,
  conversationIsUnread,
  conversationUnreadContribution,
  EMPTY_CONVERSATION_STATE,
  filterConversationsByArchive,
  parseConversationStatePatch,
  sortConversationsForList,
  sumConversationUnread,
} from "../shared/sms-conversation-state";

const now = "2026-08-28 21:00:00";

describe("parseConversationStatePatch", () => {
  it("accepts boolean archive/flag/pin/unread fields", () => {
    expect(parseConversationStatePatch({ archived: true, flagged: false })).toEqual({
      ok: true,
      patch: { archived: true, flagged: false },
    });
  });

  it("rejects delete-shaped payloads and empty bodies", () => {
    expect(parseConversationStatePatch({ delete: true })).toEqual({
      ok: false,
      error: "No fields to update",
    });
    expect(parseConversationStatePatch({})).toMatchObject({ ok: false });
    expect(parseConversationStatePatch({ archived: "yes" })).toMatchObject({ ok: false });
  });
});

describe("applyConversationStatePatch", () => {
  it("archives without touching flag/pin and never implies a hard delete", () => {
    const next = applyConversationStatePatch(EMPTY_CONVERSATION_STATE, { archived: true }, now);
    expect(next.archived_at).toBe(now);
    expect(next.flagged_at).toBeNull();
    expect(next.pinned_at).toBeNull();
    expect(Object.keys(next)).not.toContain("deleted_at");
  });

  it("unarchives, unflags, unpins, and clears mark-unread independently", () => {
    const current = {
      archived_at: now,
      flagged_at: now,
      pinned_at: now,
      unread_override_at: now,
    };
    const next = applyConversationStatePatch(
      current,
      { archived: false, flagged: false, pinned: false, unread: false },
      "2026-08-28 22:00:00",
    );
    expect(next).toEqual(EMPTY_CONVERSATION_STATE);
  });
});

describe("archive filter", () => {
  const rows = [
    { id: "a", archived_at: null as string | null },
    { id: "b", archived_at: now },
  ];

  it("hides archived rows from the default list", () => {
    expect(filterConversationsByArchive(rows, false).map((r) => r.id)).toEqual(["a"]);
  });

  it("Show archived returns only archived rows", () => {
    expect(filterConversationsByArchive(rows, true).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("pin sort", () => {
  it("pins to the top regardless of recency, then sorts by last_message_at desc", () => {
    const rows = [
      { id: "old-pinned", pinned_at: now, last_message_at: "2026-08-01T00:00:00Z" },
      { id: "newest", pinned_at: null, last_message_at: "2026-08-28T00:00:00Z" },
      { id: "mid", pinned_at: null, last_message_at: "2026-08-15T00:00:00Z" },
    ];
    expect(sortConversationsForList(rows).map((r) => r.id)).toEqual([
      "old-pinned",
      "newest",
      "mid",
    ]);
  });
});

describe("unread override and badge", () => {
  it("mark unread restores unread styling when genuine unread_count is 0", () => {
    expect(conversationIsUnread({ unread_count: 0, unread_override: true })).toBe(true);
    expect(conversationUnreadContribution({ unread_count: 0, unread_override: true })).toBe(1);
  });

  it("opening/clearing override matches a read conversation", () => {
    expect(conversationIsUnread({ unread_count: 0, unread_override: false })).toBe(false);
  });

  it("archived conversations with genuine unread still count toward the badge", () => {
    const rows = [
      { unread_count: 2, unread_override: false, archived_at: now },
      { unread_count: 0, unread_override: true, archived_at: null },
      { unread_count: 0, unread_override: false, archived_at: now },
    ];
    expect(sumConversationUnread(rows)).toBe(3);
  });
});
