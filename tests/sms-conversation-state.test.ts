import { describe, expect, it } from "vitest";
import { combinedMessageCenterBadge } from "../shared/message-center-unassigned";
import {
  applyConversationPatchToList,
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
  it("accepts boolean archive/flag/pin/unread/no-reply fields", () => {
    expect(parseConversationStatePatch({ archived: true, flagged: false, no_reply_needed: true })).toEqual({
      ok: true,
      patch: { archived: true, flagged: false, no_reply_needed: true },
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

  it("no reply needed sets a timestamp, clears mark-unread, and does not describe a message", () => {
    const next = applyConversationStatePatch(
      { ...EMPTY_CONVERSATION_STATE, unread_override_at: now },
      { no_reply_needed: true },
      "2026-10-11 23:40:00",
    );
    expect(next.no_reply_needed_at).toBe("2026-10-11 23:40:00");
    expect(next.unread_override_at).toBeNull();
    expect(next.archived_at).toBeNull();
    expect(Object.keys(next).sort()).toEqual([
      "archived_at",
      "flagged_at",
      "no_reply_needed_at",
      "pinned_at",
      "unread_override_at",
    ]);
  });

  it("mark unread after no reply needed forces unread without clearing the silence timestamp", () => {
    const silenced = applyConversationStatePatch(
      EMPTY_CONVERSATION_STATE,
      { no_reply_needed: true },
      "2026-10-11 23:40:00",
    );
    const restored = applyConversationStatePatch(silenced, { unread: true }, "2026-10-11 23:45:00");
    expect(restored.no_reply_needed_at).toBe("2026-10-11 23:40:00");
    expect(restored.unread_override_at).toBe("2026-10-11 23:45:00");
    expect(conversationIsUnread({ unread_count: 0, unread_override: true })).toBe(true);
    expect(conversationUnreadContribution({ unread_count: 0, unread_override: true })).toBe(1);
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

  it("no reply needed drops exactly that conversation's unread count, including when archived", () => {
    const rows = [
      {
        client_id: "ann",
        unread_count: 2,
        unread_override: false,
        archived_at: now,
        flagged_at: null,
        pinned_at: null,
      },
      {
        client_id: "other",
        unread_count: 1,
        unread_override: false,
        archived_at: null,
        flagged_at: null,
        pinned_at: null,
      },
    ];
    const silenced = applyConversationPatchToList(rows, "ann", { no_reply_needed: true }, now);
    expect(silenced.unreadDelta).toBe(-2);
    expect(silenced.rows[0].unread_count).toBe(0);
    expect(silenced.rows[0].archived_at).toBe(now);
    expect(conversationIsUnread(silenced.rows[0])).toBe(false);
    expect(sumConversationUnread(silenced.rows)).toBe(1);
    const marked = applyConversationPatchToList(silenced.rows, "ann", { unread: true }, now);
    expect(marked.unreadDelta).toBe(1);
    expect(conversationIsUnread(marked.rows[0])).toBe(true);
  });

  it("badge total adds clients unread and unassigned unreviewed when both are nonzero", () => {
    const clients = sumConversationUnread([
      { unread_count: 1, unread_override: false },
      { unread_count: 0, unread_override: false },
    ]);
    expect(combinedMessageCenterBadge(clients, 2)).toBe(3);
    const silenced = applyConversationPatchToList(
      [
        {
          client_id: "ann",
          unread_count: 1,
          unread_override: false,
          archived_at: null,
          flagged_at: null,
          pinned_at: null,
        },
      ],
      "ann",
      { no_reply_needed: true },
      now,
    );
    expect(combinedMessageCenterBadge(clients + silenced.unreadDelta, 2)).toBe(2);
  });
});
