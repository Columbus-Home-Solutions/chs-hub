import { describe, expect, it } from "vitest";
import {
  combinedMessageCenterBadge,
  countUnreviewedMissedCalls,
  missedCallUnassignedNotes,
  parseDismissedIds,
  serializeDismissedIds,
  telHref,
} from "../shared/message-center-unassigned";

const notes = [
  {
    id: "siri-1",
    entered_via: "siri",
    created_at: "2026-08-28T18:00:00.000Z",
    raw_content: "need lumber",
  },
  {
    id: "missed-old",
    entered_via: "missed_call",
    created_at: "2026-08-27T12:00:00.000Z",
    raw_content: "roof leak",
  },
  {
    id: "missed-new",
    entered_via: "missed_call",
    created_at: "2026-08-28T15:00:00.000Z",
    raw_content: "this is John",
  },
  {
    id: "qc-1",
    entered_via: "quick_capture",
    created_at: "2026-08-28T19:00:00.000Z",
    raw_content: "punch item",
  },
];

describe("missedCallUnassignedNotes", () => {
  it("keeps only missed_call rows and sorts most recent first", () => {
    const list = missedCallUnassignedNotes(notes);
    expect(list.map((n) => n.id)).toEqual(["missed-new", "missed-old"]);
  });

  it("does not blend voice notes into the unassigned SMS-adjacent list", () => {
    expect(missedCallUnassignedNotes(notes).every((n) => n.entered_via === "missed_call")).toBe(true);
  });
});

describe("countUnreviewedMissedCalls", () => {
  it("counts missed-call notes that have not been dismissed", () => {
    expect(countUnreviewedMissedCalls(notes, [])).toBe(2);
    expect(countUnreviewedMissedCalls(notes, ["missed-new"])).toBe(1);
    expect(countUnreviewedMissedCalls(notes, ["missed-new", "missed-old", "siri-1"])).toBe(0);
  });
});

describe("combinedMessageCenterBadge", () => {
  it("adds clients unread and unassigned unreviewed", () => {
    expect(combinedMessageCenterBadge(3, 2)).toBe(5);
    expect(combinedMessageCenterBadge(0, 1)).toBe(1);
    expect(combinedMessageCenterBadge(4, 0)).toBe(4);
  });
});

describe("telHref", () => {
  it("matches the existing unassigned-review tel: pattern", () => {
    expect(telHref("501-263-2050")).toBe("tel:+15012632050");
    expect(telHref("+15012632050")).toBe("tel:+15012632050");
    expect(telHref(null)).toBeNull();
    expect(telHref("123")).toBeNull();
  });
});

describe("dismissed id persistence", () => {
  it("round-trips the same localStorage JSON shape Unassigned Voice Notes uses", () => {
    const raw = serializeDismissedIds(["a", "b"]);
    expect(JSON.parse(raw)).toEqual(["a", "b"]);
    expect([...parseDismissedIds(raw)].sort()).toEqual(["a", "b"]);
    expect(parseDismissedIds("not-json").size).toBe(0);
  });
});
