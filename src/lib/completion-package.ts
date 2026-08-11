/**
 * Job Completion Package compiler — Sprint 15 (Module-Spec-Document-Management
 * §3.6). Cross-module aggregation into a single branded, printable HTML
 * artifact stored in R2 and rendered in the portal (client uses browser
 * "Save as PDF").
 *
 * HTML-FIRST, WORKERS-COMPATIBLE by decision: NO Puppeteer / no heavy Node PDF
 * dep — neither runs in the Workers runtime. If a true binary PDF is ever
 * required it's a separate Workers-compatible add (pdf-lib-style or an external
 * render service), not this module.
 *
 * Sources aggregated:
 *   • Documents — all active job documents grouped by category (Document mgmt).
 *   • Photos    — before / after sets from Photo Capture (rendered via the
 *                 portal image proxy so they load read-only in the portal).
 *   • Financial — contract total, invoiced, paid, balance, approved CO impact
 *                 (Financial module; money is summed from canonical rows, never
 *                 re-derived with new math).
 *
 * The compiler ONLY builds + returns HTML. Persistence and the
 * draft → review → send state machine live in routes/completion-package.ts.
 */

import type { Env } from "../env.js";

export interface CompletionPackageData {
  company_name: string;
  job_display: string;
  job_title: string;
  client_name: string;
  property_address: string;
  generated_at: string;
  financial: {
    contract_total: number;
    change_order_total: number;
    adjusted_total: number;
    total_invoiced: number;
    total_paid: number;
    balance: number;
  };
  documents: Array<{ category: string; items: Array<{ title: string }> }>;
  before_photos: Array<{ id: string; caption: string | null; url: string }>;
  after_photos: Array<{ id: string; caption: string | null; url: string }>;
  warranty_text: string;
}

const USD = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CATEGORY_LABELS: Record<string, string> = {
  contract: "Contracts",
  change_order: "Change Orders",
  permit: "Permits",
  plan_drawing: "Plans & Drawings",
  invoice: "Invoices",
  lien_waiver: "Lien Waivers",
  photo_report: "Photo Reports",
  other: "Other Documents",
};

/** Gather every input the package needs. Pure reads — no writes, no mutation. */
export async function buildCompletionPackageData(
  env: Env,
  jobId: string,
): Promise<CompletionPackageData | null> {
  const job = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.client_id, j.contract_total, j.portal_token,
            j.property_address, j.property_city, j.property_state, j.property_zip,
            j.warranty_expiration,
            c.name AS client_name, c.first_name, c.last_name
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      id: string;
      job_number: number | null;
      title: string | null;
      client_id: string | null;
      contract_total: number | null;
      portal_token: string | null;
      property_address: string | null;
      property_city: string | null;
      property_state: string | null;
      property_zip: string | null;
      warranty_expiration: string | null;
      client_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>();
  if (!job) return null;

  const company = await env.DB.prepare("SELECT value FROM system_settings WHERE key='company_name'")
    .first<{ value: string | null }>()
    .then((r) => (r?.value ?? "").trim() || "Columbus Home Solutions, LLC")
    .catch(() => "Columbus Home Solutions, LLC");

  // ── Financial summary (canonical sums; mirrors the portal landing math) ──
  const contractTotal = job.contract_total ?? 0;
  const coRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS co FROM change_orders WHERE job_id = ? AND applied_at IS NOT NULL",
  )
    .bind(jobId)
    .first<{ co: number }>();
  const changeOrderTotal = coRow?.co ?? 0;
  const invRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(COALESCE(total_due, amount, 0)),0) AS inv FROM invoices WHERE job_id = ? AND status != 'draft' AND status != 'void'",
  )
    .bind(jobId)
    .first<{ inv: number }>();
  const paidRow = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE job_id = ?")
    .bind(jobId)
    .first<{ paid: number }>();
  const totalInvoiced = invRow?.inv ?? 0;
  const totalPaid = paidRow?.paid ?? 0;
  const adjustedTotal = contractTotal + changeOrderTotal;
  const balance = Math.max(0, adjustedTotal - totalPaid);

  // ── Documents by category ──
  const docRows = (
    await env.DB.prepare(
      `SELECT title, document_category FROM documents
        WHERE job_id = ? AND COALESCE(is_active,1)=1
          AND document_category NOT IN ('receipt','completion_package','project_packet')
        ORDER BY document_category ASC, datetime(created_at) ASC`,
    )
      .bind(jobId)
      .all<{ title: string; document_category: string }>()
  ).results ?? [];
  const grouped: Record<string, Array<{ title: string }>> = {};
  for (const d of docRows) (grouped[d.document_category] ??= []).push({ title: d.title });
  const documents = Object.entries(grouped).map(([category, items]) => ({ category, items }));

  // ── Before / after photos (rendered via the portal image proxy) ──
  const token = job.portal_token ?? "";
  const photoUrl = (id: string) => `/api/portal/${encodeURIComponent(token)}/photos/${id}/image`;
  const beforeRows = (
    await env.DB.prepare(
      `SELECT id, caption FROM photos
        WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
          AND (lower(COALESCE(category,''))='before' OR COALESCE(is_before_photo,0)=1)
        ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 12`,
    )
      .bind(jobId)
      .all<{ id: string; caption: string | null }>()
  ).results ?? [];
  const afterRows = (
    await env.DB.prepare(
      `SELECT id, caption FROM photos
        WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
          AND (lower(COALESCE(category,''))='final' OR COALESCE(is_after_photo,0)=1)
        ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 12`,
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
    financial: {
      contract_total: contractTotal,
      change_order_total: changeOrderTotal,
      adjusted_total: adjustedTotal,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      balance,
    },
    documents,
    before_photos: beforeRows.map((p) => ({ id: p.id, caption: p.caption, url: photoUrl(p.id) })),
    after_photos: afterRows.map((p) => ({ id: p.id, caption: p.caption, url: photoUrl(p.id) })),
    warranty_text:
      "Columbus Home Solutions provides a five-year workmanship warranty on completed work beginning at project completion. Full exclusions and limitation of liability are set forth in the Warranty Certificate issued with your completion package.",
  };
}

/** Assemble the branded, printable HTML artifact from the gathered data. */
export function renderCompletionPackageHtml(d: CompletionPackageData): string {
  const docSections = d.documents
    .map((g) => {
      const label = CATEGORY_LABELS[g.category] ?? g.category;
      const items = g.items.map((i) => `<li>${esc(i.title)}</li>`).join("");
      return `<div class="doc-group"><h3>${esc(label)}</h3><ul>${items}</ul></div>`;
    })
    .join("");

  const photoGrid = (photos: CompletionPackageData["before_photos"]) =>
    photos.length === 0
      ? `<p class="muted">No photos on file.</p>`
      : `<div class="photo-grid">${photos
          .map(
            (p) =>
              `<figure><img src="${esc(p.url)}" alt="${esc(p.caption || "Project photo")}" loading="lazy"><figcaption>${esc(p.caption || "")}</figcaption></figure>`,
          )
          .join("")}</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.job_title)} — Completion Package</title>
<style>
  :root{--ink:#1d2733;--muted:#5b6b7b;--accent:#c8102e;--line:#e3e8ee;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4f6f8;line-height:1.5}
  .page{max-width:840px;margin:0 auto;background:var(--bg);box-shadow:0 4px 24px rgba(0,0,0,.06)}
  header{background:var(--ink);color:#fff;padding:36px 40px}
  header .co{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9fb0c0}
  header h1{margin:6px 0 4px;font-size:26px}
  header .meta{font-size:14px;color:#cdd7e0}
  section{padding:28px 40px;border-bottom:1px solid var(--line)}
  h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 16px}
  h3{font-size:15px;margin:18px 0 6px}
  ul{margin:6px 0;padding-left:20px}li{margin:2px 0}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:15px}
  td{padding:8px 0;border-bottom:1px solid var(--line)}
  td.r{text-align:right;font-variant-numeric:tabular-nums}
  tr.total td{font-weight:700;border-bottom:none;padding-top:14px}
  .photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
  figure{margin:0}figure img{width:100%;height:140px;object-fit:cover;border-radius:8px;background:#eef2f6}
  figcaption{font-size:12px;color:var(--muted);margin-top:4px}
  footer{padding:24px 40px;font-size:12px;color:var(--muted)}
  @media print{body{background:#fff}.page{box-shadow:none}section{break-inside:avoid}}
</style></head>
<body><div class="page">
  <header>
    <div class="co">${esc(d.company_name)}</div>
    <h1>Project Completion Package</h1>
    <div class="meta">${esc(d.job_display)}${d.job_title ? ` · ${esc(d.job_title)}` : ""} · Prepared ${esc(d.generated_at)}</div>
  </header>

  <section>
    <h2>Project</h2>
    <table>
      <tr><td>Client</td><td class="r">${esc(d.client_name)}</td></tr>
      <tr><td>Property</td><td class="r">${esc(d.property_address)}</td></tr>
      <tr><td>Project</td><td class="r">${esc(d.job_title)}</td></tr>
    </table>
  </section>

  <section>
    <h2>Financial Summary</h2>
    <table>
      <tr><td>Contract total</td><td class="r">${USD(d.financial.contract_total)}</td></tr>
      <tr><td>Approved change orders</td><td class="r">${USD(d.financial.change_order_total)}</td></tr>
      <tr><td>Adjusted total</td><td class="r">${USD(d.financial.adjusted_total)}</td></tr>
      <tr><td>Total invoiced</td><td class="r">${USD(d.financial.total_invoiced)}</td></tr>
      <tr><td>Total paid</td><td class="r">${USD(d.financial.total_paid)}</td></tr>
      <tr class="total"><td>Balance</td><td class="r">${USD(d.financial.balance)}</td></tr>
    </table>
  </section>

  <section>
    <h2>Project Documents</h2>
    ${docSections || `<p class="muted">No documents on file.</p>`}
  </section>

  <section>
    <h2>Before</h2>
    ${photoGrid(d.before_photos)}
  </section>

  <section>
    <h2>After</h2>
    ${photoGrid(d.after_photos)}
  </section>

  <section>
    <h2>Warranty</h2>
    <p>${esc(d.warranty_text)}</p>
  </section>

  <footer>${esc(d.company_name)} · This completion package was generated by the Columbus Home Solutions platform.</footer>
</div></body></html>`;
}
