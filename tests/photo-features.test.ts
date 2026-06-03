import { describe, it, expect } from "vitest";
import {
  validateAnnotationData,
  renderAnnotatedImageSvg,
  renderAnnotationShapes,
  hasMarkup,
  type AnnotationData,
} from "../src/lib/annotation.js";
import { renderPhotoReportHtml, type PhotoReportData } from "../src/lib/photo-report.js";
import { renderProjectPacketHtml, type ProjectPacketData } from "../src/lib/project-packet.js";
import { maskToken } from "../src/routes/devices.js";

describe("annotation overlay contract (Sprint 18)", () => {
  const sample = {
    version: 1,
    image: { width: 1600, height: 1200 },
    shapes: [
      { type: "pen", points: [[10, 10], [20, 25], [30, 40]], color: "#c8102e", width: 4 },
      { type: "rect", x: 100, y: 100, w: 200, h: 150, color: "#00aa00", width: 3 },
      { type: "arrow", x1: 0, y1: 0, x2: 50, y2: 50, color: "#0000ff", width: 5 },
      { type: "text", x: 80, y: 80, text: "Crack here", color: "#ffd400", size: 28 },
      { type: "ellipse", cx: 400, cy: 300, rx: 60, ry: 40, color: "#c8102e", width: 2 },
    ],
  };

  it("round-trips losslessly through validate → serialize → validate", () => {
    const a = validateAnnotationData(sample);
    expect(a).not.toBeNull();
    const b = validateAnnotationData(JSON.stringify(a));
    expect(b).toEqual(a);
  });

  it("preserves image dims and all shape kinds", () => {
    const a = validateAnnotationData(sample)!;
    expect(a.image).toEqual({ width: 1600, height: 1200 });
    expect(a.shapes.map((s) => s.type)).toEqual(["pen", "rect", "arrow", "text", "ellipse"]);
  });

  it("drops unknown shape types and bad pen paths", () => {
    const a = validateAnnotationData({
      version: 1,
      image: { width: 100, height: 100 },
      shapes: [
        { type: "bogus", x: 1 },
        { type: "pen", points: [[1, 1]] }, // <2 points → dropped
        { type: "rect", x: 1, y: 1, w: 2, h: 2 },
      ],
    })!;
    expect(a.shapes.map((s) => s.type)).toEqual(["rect"]);
  });

  it("rejects non-hex colors (no CSS injection) and falls back", () => {
    const a = validateAnnotationData({
      version: 1,
      image: { width: 10, height: 10 },
      shapes: [{ type: "rect", x: 0, y: 0, w: 5, h: 5, color: "url(javascript:alert(1))", width: 2 }],
    })!;
    expect((a.shapes[0] as { color: string }).color).toBe("#c8102e");
  });

  it("escapes text content in the rendered SVG", () => {
    const a = validateAnnotationData({
      version: 1,
      image: { width: 100, height: 100 },
      shapes: [{ type: "text", x: 5, y: 5, text: "<script>x</script>", color: "#ffd400", size: 20 }],
    })!;
    const svg = renderAnnotationShapes(a);
    expect(svg).not.toContain("<script>x</script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("crop changes the composited SVG viewBox without touching the image element", () => {
    const a = validateAnnotationData({
      version: 1,
      image: { width: 1000, height: 800 },
      shapes: [{ type: "crop", x: 100, y: 50, w: 400, h: 300 }],
    })!;
    const svg = renderAnnotatedImageSvg("/api/photos/p1", a);
    expect(svg).toContain('viewBox="100 50 400 300"');
    // The original is referenced at full natural size — never rewritten.
    expect(svg).toContain('width="1000" height="800"');
    expect(svg).toContain('href="/api/photos/p1"');
  });

  it("hasMarkup is false for an empty overlay", () => {
    const empty = validateAnnotationData({ version: 1, image: { width: 10, height: 10 }, shapes: [] })!;
    expect(hasMarkup(empty)).toBe(false);
  });

  it("returns null for unusable input", () => {
    expect(validateAnnotationData(null)).toBeNull();
    expect(validateAnnotationData("not json")).toBeNull();
  });
});

describe("photo report HTML (Sprint 18, S15 pattern)", () => {
  const data: PhotoReportData = {
    company_name: "Columbus Home Solutions, LLC",
    job_display: "JOB-107",
    job_title: "Reed Garage Conversion",
    property_address: "12 Reed Ln, Rogers, AR",
    generated_at: "June 2, 2026",
    date_from: "2026-05-01T10:00:00Z",
    date_to: "2026-05-20T15:00:00Z",
    include_gps: true,
    include_captions: true,
    photos: [
      {
        id: "p1",
        caption: "Demo complete",
        taken_at: "2026-05-01T10:00:00Z",
        photo_type: "before",
        latitude: 36.332,
        longitude: -94.118,
        url: "/api/portal/tok/photos/p1/image",
        annotated_svg: null,
      },
    ],
  };

  it("produces branded printable HTML with the photo + GPS link", () => {
    const html = renderPhotoReportHtml(data);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Photo Report");
    expect(html).toContain("JOB-107");
    expect(html).toContain("/api/portal/tok/photos/p1/image");
    expect(html).toContain("openstreetmap.org"); // GPS link when include_gps
    expect(html).toContain("@media print");
  });

  it("omits captions/GPS when disabled", () => {
    const html = renderPhotoReportHtml({ ...data, include_gps: false, include_captions: false });
    expect(html).not.toContain("openstreetmap.org");
    expect(html).not.toContain("Demo complete");
  });

  it("embeds the annotated SVG when a photo carries one", () => {
    const html = renderPhotoReportHtml({
      ...data,
      photos: [{ ...data.photos[0], annotated_svg: '<svg class="pr-annot"><image href="/x"/></svg>' }],
    });
    expect(html).toContain('<svg class="pr-annot">');
  });

  it("handles an empty selection", () => {
    const html = renderPhotoReportHtml({ ...data, photos: [] });
    expect(html).toContain("No photos selected");
  });
});

describe("project packet HTML (Sprint 18) — distinct from completion package", () => {
  const data: ProjectPacketData = {
    company_name: "Columbus Home Solutions, LLC",
    job_display: "JOB-107",
    job_title: "Reed Garage Conversion",
    client_name: "Sam Reed",
    property_address: "12 Reed Ln, Rogers, AR",
    generated_at: "June 2, 2026",
    scope: "Convert garage to a conditioned office.",
    before_photos: [{ id: "b1", caption: "Before", url: "/api/portal/tok/photos/b1/image" }],
    after_photos: [{ id: "a1", caption: "After", url: "/api/portal/tok/photos/a1/image" }],
    highlight_photos: [],
  };

  it("renders a sales packet with before/after, no financials/warranty", () => {
    const html = renderProjectPacketHtml(data);
    expect(html).toContain("Project Packet");
    expect(html).toContain("Before &amp; After");
    expect(html).toContain("Convert garage");
    // The packet is NOT the completion package — no financial summary / warranty.
    expect(html).not.toContain("Financial Summary");
    expect(html).not.toContain("Warranty");
  });
});

describe("device token masking (Sprint 18, business rule 5)", () => {
  it("never reveals more than the last 4 chars", () => {
    expect(maskToken("abcd1234efgh5678")).toBe("••••5678");
    expect(maskToken("")).toBe("");
  });
});
