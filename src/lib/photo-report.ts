/**
 * Photo report compiler — Sprint 18 (deliverable C; Photo Capture §3.8).
 *
 * Branded, printable HTML built EXACTLY like the S15 completion package:
 * HTML-first, Workers-compatible, NO Puppeteer / NO binary-PDF dependency. The
 * artifact is stored in R2 and registered as a `documents` row with
 * document_category='photo_report'; the owner/client uses the browser's
 * "Save as PDF". Shareable via the existing /api/documents/:id/share → /share/:token.
 *
 * Annotated photos are composited from (original + annotation_data) via the one
 * shared overlay contract (src/lib/annotation.ts) so the report renders markup
 * identically to the web view. The stored original is never modified.
 *
 * The compiler ONLY builds + returns HTML. Persistence lives in
 * routes/photo-report.ts.
 */

import type { Env } from "../env.js";
import { validateAnnotationData, renderAnnotatedImageSvg } from "./annotation.js";

export interface PhotoReportOptions {
  photoIds: string[];
  includeGps: boolean;
  includeCaptions: boolean;
}

export interface PhotoReportPhoto {
  id: string;
  caption: string | null;
  taken_at: string | null;
  photo_type: string | null;
  latitude: number | null;
  longitude: number | null;
  url: string;
  annotated_svg: string | null;
}

export interface PhotoReportData {
  company_name: string;
  job_display: string;
  job_title: string;
  property_address: string;
  generated_at: string;
  date_from: string | null;
  date_to: string | null;
  include_gps: boolean;
  include_captions: boolean;
  photos: PhotoReportPhoto[];
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Gather everything the report needs. Pure reads — no writes, no mutation. */
export async function buildPhotoReportData(
  env: Env,
  jobId: string,
  opts: PhotoReportOptions,
): Promise<PhotoReportData | null> {
  const job = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.portal_token,
            j.property_address, j.property_city, j.property_state, j.property_zip
       FROM jobs j WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      id: string;
      job_number: number | null;
      title: string | null;
      portal_token: string | null;
      property_address: string | null;
      property_city: string | null;
      property_state: string | null;
      property_zip: string | null;
    }>();
  if (!job) return null;

  const company = await env.DB.prepare("SELECT value FROM system_settings WHERE key='company_name'")
    .first<{ value: string | null }>()
    .then((r) => (r?.value ?? "").trim() || "Columbus Home Solutions, LLC")
    .catch(() => "Columbus Home Solutions, LLC");

  // Image URL: prefer the portal proxy (works in a shared/public /share view);
  // fall back to the Access-gated dashboard stream for owner-only previews.
  const token = job.portal_token ?? "";
  const imageUrl = (id: string) =>
    token ? `/api/portal/${encodeURIComponent(token)}/photos/${id}/image` : `/api/photos/${id}`;

  const ids = opts.photoIds.filter(Boolean);
  let photos: PhotoReportPhoto[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows =
      (
        await env.DB.prepare(
          `SELECT id, caption, photo_type, COALESCE(taken_at, created_at) AS taken_at,
                  COALESCE(latitude, gps_lat) AS latitude, COALESCE(longitude, gps_lng) AS longitude,
                  annotation_data, is_annotated
             FROM photos
            WHERE id IN (${placeholders}) AND job_id = ? AND COALESCE(is_active,1)=1
              AND COALESCE(photo_type,'') != 'receipt'
            ORDER BY COALESCE(taken_at, created_at) ASC`,
        )
          .bind(...ids, jobId)
          .all<{
            id: string;
            caption: string | null;
            photo_type: string | null;
            taken_at: string | null;
            latitude: number | null;
            longitude: number | null;
            annotation_data: string | null;
            is_annotated: number | null;
          }>()
      ).results ?? [];
    photos = rows.map((r) => {
      const url = imageUrl(r.id);
      let annotated_svg: string | null = null;
      if (r.is_annotated && r.annotation_data) {
        const data = validateAnnotationData(r.annotation_data);
        if (data) annotated_svg = renderAnnotatedImageSvg(url, data, { className: "pr-annot" });
      }
      return {
        id: r.id,
        caption: r.caption,
        taken_at: r.taken_at,
        photo_type: r.photo_type,
        latitude: r.latitude,
        longitude: r.longitude,
        url,
        annotated_svg,
      };
    });
  }

  const dates = photos.map((p) => p.taken_at).filter(Boolean) as string[];
  return {
    company_name: company,
    job_display: job.job_number != null ? `JOB-${String(job.job_number).padStart(3, "0")}` : "",
    job_title: job.title ?? "",
    property_address: [job.property_address, job.property_city, job.property_state, job.property_zip]
      .filter(Boolean)
      .join(", "),
    generated_at: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    date_from: dates.length ? dates[0] : null,
    date_to: dates.length ? dates[dates.length - 1] : null,
    include_gps: opts.includeGps,
    include_captions: opts.includeCaptions,
    photos,
  };
}

/** Assemble the branded, printable HTML artifact. */
export function renderPhotoReportHtml(d: PhotoReportData): string {
  const range =
    d.date_from && d.date_to
      ? `${fmtDate(d.date_from)}${d.date_to !== d.date_from ? ` – ${fmtDate(d.date_to)}` : ""}`
      : "";

  const cards = d.photos
    .map((p) => {
      const alt = d.include_captions && p.caption ? p.caption : "Project photo";
      const media = p.annotated_svg
        ? p.annotated_svg
        : `<img src="${esc(p.url)}" alt="${esc(alt)}" loading="lazy">`;
      const cap = d.include_captions && p.caption ? `<div class="pr-cap">${esc(p.caption)}</div>` : "";
      const ts = p.taken_at ? `<span>${esc(fmtDate(p.taken_at))}</span>` : "";
      const gps =
        d.include_gps && p.latitude != null && p.longitude != null
          ? `<a class="pr-gps" href="https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=18/${p.latitude}/${p.longitude}" target="_blank" rel="noopener">📍 ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}</a>`
          : "";
      return `<figure class="pr-card">
        <div class="pr-media">${media}</div>
        ${cap}
        <div class="pr-meta">${ts}${gps}</div>
      </figure>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.job_title || "Photo Report")} — Photo Report</title>
<style>
  :root{--ink:#1d2733;--muted:#5b6b7b;--accent:#c8102e;--line:#e3e8ee;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4f6f8;line-height:1.5}
  .page{max-width:900px;margin:0 auto;background:var(--bg);box-shadow:0 4px 24px rgba(0,0,0,.06)}
  header{background:var(--ink);color:#fff;padding:36px 40px}
  header .co{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9fb0c0}
  header h1{margin:6px 0 4px;font-size:26px}
  header .meta{font-size:14px;color:#cdd7e0}
  section{padding:28px 40px}
  .pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px}
  .pr-card{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
  .pr-media{background:#eef2f6;line-height:0}
  .pr-media img,.pr-media svg{width:100%;height:auto;display:block}
  .pr-cap{padding:8px 12px 0;font-size:14px}
  .pr-meta{padding:6px 12px 12px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .pr-gps{color:var(--accent);text-decoration:none}
  .muted{color:var(--muted)}
  footer{padding:24px 40px;font-size:12px;color:var(--muted);border-top:1px solid var(--line)}
  @media print{body{background:#fff}.page{box-shadow:none}.pr-card{break-inside:avoid}}
</style></head>
<body><div class="page">
  <header>
    <div class="co">${esc(d.company_name)}</div>
    <h1>Photo Report</h1>
    <div class="meta">${esc(d.job_display)}${d.job_title ? ` · ${esc(d.job_title)}` : ""}${
      d.property_address ? ` · ${esc(d.property_address)}` : ""
    } · Prepared ${esc(d.generated_at)}${range ? ` · ${esc(range)}` : ""}</div>
  </header>
  <section>
    ${
      d.photos.length === 0
        ? `<p class="muted">No photos selected for this report.</p>`
        : `<div class="pr-grid">${cards}</div>`
    }
  </section>
  <footer>${esc(d.company_name)} · ${d.photos.length} photo${d.photos.length === 1 ? "" : "s"} · Generated by the Columbus Home Solutions platform.</footer>
</div></body></html>`;
}
