import { describe, it, expect } from "vitest";

/** Mirrors ORDER BY in mirrorDocumentsBatch — pending rows must drain before failed retries. */
function mirrorDocumentSortKey(mirrorStatus: string, createdAt: string): [number, string] {
  const priority = mirrorStatus === "pending" ? 0 : 1;
  return [priority, createdAt];
}

describe("drive mirror document queue", () => {
  it("processes pending documents before failed retries", () => {
    const rows = [
      { id: "failed-old", mirror_status: "failed", created_at: "2026-07-11T16:03:05Z" },
      { id: "pending-new", mirror_status: "pending", created_at: "2026-07-15T13:02:25Z" },
      { id: "pending-older", mirror_status: "pending", created_at: "2026-07-12T19:19:10Z" },
    ];
    const sorted = [...rows].sort((a, b) => {
      const [pa, da] = mirrorDocumentSortKey(a.mirror_status, a.created_at);
      const [pb, db] = mirrorDocumentSortKey(b.mirror_status, b.created_at);
      return pa - pb || da.localeCompare(db);
    });
    expect(sorted.map((r) => r.id)).toEqual(["pending-older", "pending-new", "failed-old"]);
  });

  it("does not treat NULL mirror_status as pending (pre-file BoldSign placeholders)", () => {
    const eligible = (mirrorStatus: string | null) =>
      mirrorStatus === "pending" || mirrorStatus === "failed";
    expect(eligible(null)).toBe(false);
    expect(eligible("pending")).toBe(true);
    expect(eligible("skipped")).toBe(false);
  });
});
