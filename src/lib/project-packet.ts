/**
 * Project packet compiler — Sprint 18 (deliverable D; Photo Capture §3.5.5).
 *
 * A lean SALES-PRESENTATION artifact: the job's story told with before/after
 * photos prioritized, the scope, and a few select details. Branded printable
 * HTML, S15 pattern (HTML-first, no Puppeteer / no binary-PDF dep), stored in R2
 * + a `documents` row with document_category='project_packet'.
 *
 * Deliberately DISTINCT from the completion package: no financial summary, no
 * warranty, no document inventory — this is a marketing/sales piece, not the
 * client's closeout record. Owner-generated, shareable via /share/:token.
 */

import type { Env } from "../env.js";

export interface ProjectPacketData {
  company_name: string;
  job_display: string;
  job_title: string;
  client_name: string;
  property_address: string;
  generated_at: string;
  scope: string | null;
  before_photos: Array<{ id: string; caption: string | null; url: string }>;
  after_photos: Array<{ id: string; caption: string | null; url: string }>;
  highlight_photos: Array<{ id: string; caption: string | null; url: string }>;
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function buildProjectPacketData(env: Env, jobId: string): Promise<ProjectPacketData | null> {
  const job = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.notes, j.portal_token, j.client_id,
            j.property_address, j.property_city, j.property_state, j.property_zip,
            c.name AS client_name, c.first_name, c.last_name
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      id: string;
      job_number: number | null;
      title: string | null;
      notes: string | null;
      portal_token: string | null;
      property_address: string | null;
      property_city: string | null;
      property_state: string | null;
      property_zip: string | null;
      client_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>();
  if (!job) return null;

  const company = await env.DB.prepare("SELECT value FROM system_settings WHERE key='company_name'")
    .first<{ value: string | null }>()
    .then((r) => (r?.value ?? "").trim() || "Columbus Home Solutions, LLC")
    .catch(() => "Columbus Home Solutions, LLC");

  const token = job.portal_token ?? "";
  const photoUrl = (id: string) =>
    token ? `/api/portal/${encodeURIComponent(token)}/photos/${id}/image` : `/api/photos/${id}`;

  const before =
    (
      await env.DB.prepare(
        `SELECT id, caption FROM photos
          WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
            AND (lower(COALESCE(category,''))='before' OR COALESCE(is_before_photo,0)=1)
          ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 8`,
      )
        .bind(jobId)
        .all<{ id: string; caption: string | null }>()
    ).results ?? [];
  const after =
    (
      await env.DB.prepare(
        `SELECT id, caption FROM photos
          WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
            AND (lower(COALESCE(category,''))='final' OR COALESCE(is_after_photo,0)=1)
          ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 8`,
      )
        .bind(jobId)
        .all<{ id: string; caption: string | null }>()
    ).results ?? [];
  // A few social-ready / progress highlights when before/after is thin.
  const highlights =
    (
      await env.DB.prepare(
        `SELECT id, caption FROM photos
          WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
            AND COALESCE(is_social_ready,0)=1
          ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 6`,
      )
        .bind(jobId)
        .all<{ id: string; caption: string | null }>()
    ).results ?? [];

  return {
    company_name: company,
    job_display: job.job_number != null ? `JOB-${String(job.job_number).padStart(3, "0")}` : "",
    job_title: job.title ?? "",
    client_name:
      [job.first_name, job.last_name].filter(Boolean).join(" ").trim() || (job.client_name ?? "").trim(),
    property_address: [job.property_address, job.property_city, job.property_state, job.property_zip]
      .filter(Boolean)
      .join(", "),
    generated_at: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    scope: job.notes ?? null,
    before_photos: before.map((p) => ({ id: p.id, caption: p.caption, url: photoUrl(p.id) })),
    after_photos: after.map((p) => ({ id: p.id, caption: p.caption, url: photoUrl(p.id) })),
    highlight_photos: highlights.map((p) => ({ id: p.id, caption: p.caption, url: photoUrl(p.id) })),
  };
}

export function renderProjectPacketHtml(d: ProjectPacketData): string {
  const grid = (photos: ProjectPacketData["before_photos"]) =>
    photos.length === 0
      ? `<p class="muted">—</p>`
      : `<div class="pk-grid">${photos
          .map(
            (p) =>
              `<figure><img src="${esc(p.url)}" alt="${esc(p.caption || "Project photo")}" loading="lazy"><figcaption>${esc(p.caption || "")}</figcaption></figure>`,
          )
          .join("")}</div>`;

  const beforeAfter =
    d.before_photos.length || d.after_photos.length
      ? `<section><h2>Before &amp; After</h2>
          <div class="pk-ba">
            <div><h3>Before</h3>${grid(d.before_photos)}</div>
            <div><h3>After</h3>${grid(d.after_photos)}</div>
          </div>
         </section>`
      : "";
  const highlights = d.highlight_photos.length
    ? `<section><h2>Highlights</h2>${grid(d.highlight_photos)}</section>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.job_title || "Project")} — Project Packet</title>
<style>
  :root{--ink:#1d2733;--muted:#5b6b7b;--accent:#c8102e;--line:#e3e8ee;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4f6f8;line-height:1.5}
  .page{max-width:900px;margin:0 auto;background:var(--bg);box-shadow:0 4px 24px rgba(0,0,0,.06)}
  header{background:var(--ink);color:#fff;padding:44px 40px}
  header .co{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9fb0c0}
  header h1{margin:6px 0 6px;font-size:30px}
  header .meta{font-size:14px;color:#cdd7e0}
  section{padding:28px 40px;border-bottom:1px solid var(--line)}
  h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 16px}
  h3{font-size:15px;margin:0 0 10px}
  .muted{color:var(--muted)}
  .pk-ba{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .pk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  figure{margin:0}figure img{width:100%;height:130px;object-fit:cover;border-radius:8px;background:#eef2f6}
  figcaption{font-size:12px;color:var(--muted);margin-top:4px}
  footer{padding:24px 40px;font-size:12px;color:var(--muted)}
  @media print{body{background:#fff}.page{box-shadow:none}section{break-inside:avoid}.pk-ba{grid-template-columns:1fr 1fr}}
</style></head>
<body><div class="page">
  <header>
    <div class="co">${esc(d.company_name)}</div>
    <h1>${esc(d.job_title || "Project Packet")}</h1>
    <div class="meta">${esc(d.job_display)}${d.client_name ? ` · ${esc(d.client_name)}` : ""}${
      d.property_address ? ` · ${esc(d.property_address)}` : ""
    } · ${esc(d.generated_at)}</div>
  </header>
  ${d.scope ? `<section><h2>Scope</h2><p>${esc(d.scope)}</p></section>` : ""}
  ${beforeAfter}
  ${highlights}
  <footer>${esc(d.company_name)} · Project packet generated by the Columbus Home Solutions platform.</footer>
</div></body></html>`;
}
