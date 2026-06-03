import { describe, it, expect } from "vitest";
import { buildPhotoReportData, renderPhotoReportHtml } from "../src/lib/photo-report.js";
import { buildProjectPacketData, renderProjectPacketHtml } from "../src/lib/project-packet.js";
import { validateAnnotationData } from "../src/lib/annotation.js";
import type { Env } from "../src/env.js";

/**
 * Sprint 18 photo-lifecycle coverage at the data-shaping layer: a photo gets
 * annotated, paired before/after, then compiled into a photo report + a project
 * packet — exercising the build* aggregators (incl. the annotation-compositing
 * path) against a SQL-aware mock D1. Complements the live cross-module smoke.
 */

const ANNOTATED = JSON.stringify(
  validateAnnotationData({
    version: 1,
    image: { width: 1000, height: 800 },
    shapes: [{ type: "arrow", x1: 10, y1: 10, x2: 100, y2: 100, color: "#c8102e", width: 4 }],
  }),
);

const JOB = {
  id: "job-1",
  job_number: 170,
  title: "Nair Bathroom Remodel",
  notes: "Full gut + tile.",
  portal_token: "tok123",
  client_id: "cli-1",
  property_address: "9 Oak St",
  property_city: "Rogers",
  property_state: "AR",
  property_zip: "72758",
  contract_total: 40000,
  warranty_expiration: null,
  client_name: "Nair Family",
  first_name: "Asha",
  last_name: "Nair",
};

const PHOTOS = [
  { id: "ph-before", caption: "Before demo", photo_type: "before", taken_at: "2026-05-01T10:00:00Z", latitude: 36.3, longitude: -94.1, annotation_data: null, is_annotated: 0, is_before_photo: 1, is_after_photo: 0, is_social_ready: 0, category: "before" },
  { id: "ph-after", caption: "Finished", photo_type: "after", taken_at: "2026-05-20T15:00:00Z", latitude: 36.3, longitude: -94.1, annotation_data: ANNOTATED, is_annotated: 1, is_before_photo: 0, is_after_photo: 1, is_social_ready: 1, category: "final" },
];

function mockEnv(): Env {
  const db = {
    prepare(sql: string) {
      return {
        _sql: sql,
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          if (this._sql.includes("system_settings")) return { value: "Columbus Home Solutions, LLC" };
          if (this._sql.includes("FROM jobs")) return JOB;
          return null;
        },
        async all() {
          const s = this._sql;
          if (s.includes("WHERE id IN")) {
            // photo-report: photos by id for this job, ordered by taken_at.
            return {
              results: PHOTOS.map((p) => ({
                id: p.id,
                caption: p.caption,
                photo_type: p.photo_type,
                taken_at: p.taken_at,
                latitude: p.latitude,
                longitude: p.longitude,
                annotation_data: p.annotation_data,
                is_annotated: p.is_annotated,
              })),
            };
          }
          if (s.includes("is_before_photo")) return { results: [{ id: "ph-before", caption: "Before demo" }] };
          if (s.includes("is_after_photo")) return { results: [{ id: "ph-after", caption: "Finished" }] };
          if (s.includes("is_social_ready")) return { results: [{ id: "ph-after", caption: "Finished" }] };
          return { results: [] };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe("photo report lifecycle (Sprint 18)", () => {
  it("builds report data, composites the annotated photo, and renders HTML", async () => {
    const data = await buildPhotoReportData(mockEnv(), "job-1", {
      photoIds: ["ph-before", "ph-after"],
      includeGps: true,
      includeCaptions: true,
    });
    expect(data).not.toBeNull();
    expect(data!.job_display).toBe("JOB-170");
    expect(data!.photos).toHaveLength(2);
    // The annotated "after" photo carries a composited SVG (image + overlay).
    const after = data!.photos.find((p) => p.id === "ph-after")!;
    expect(after.annotated_svg).toContain("<svg");
    expect(after.annotated_svg).toContain("/api/portal/tok123/photos/ph-after/image");
    // The plain "before" photo has no overlay.
    expect(data!.photos.find((p) => p.id === "ph-before")!.annotated_svg).toBeNull();

    const html = renderPhotoReportHtml(data!);
    expect(html).toContain("Photo Report");
    expect(html).toContain("Nair Bathroom Remodel");
    expect(html).toContain("pr-annot"); // annotated svg embedded
  });
});

describe("project packet lifecycle (Sprint 18)", () => {
  it("builds packet data with before/after + scope and renders distinct HTML", async () => {
    const data = await buildProjectPacketData(mockEnv(), "job-1");
    expect(data).not.toBeNull();
    expect(data!.scope).toContain("Full gut");
    expect(data!.before_photos).toHaveLength(1);
    expect(data!.after_photos).toHaveLength(1);
    const html = renderProjectPacketHtml(data!);
    expect(html).toContain("Project Packet");
    expect(html).toContain("Before &amp; After");
    expect(html).not.toContain("Financial Summary"); // distinct from completion package
  });
});
