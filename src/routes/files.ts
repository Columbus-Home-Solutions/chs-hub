/**
 * GET /api/files — aggregate index for dashboard file browser (R2-backed
 * photos, receipts, company docs, nightly D1 backups).
 */

import type { Env } from "../env.js";
import { OPEN_JOB_STATUSES } from "./jobs.js";
import { JOB_FILE_TYPES } from "./job-files.js";

const JOB_FILE_DOC_LABEL: Record<string, string> = {
  drawings: "Drawings & plans",
  notes: "Field notes",
  contracts: "Contracts",
  receipts: "Project receipts",
  pay_stub: "Sub / pay records",
  design: "Design & finishes",
  other: "Other",
};

/** Matches `src/routes/company-documents.ts` — filter for Explorer subfolders */
const COMPANY_DOC_TYPES = new Set([
  "sop",
  "insurance",
  "license",
  "contract",
  "w9",
  "safety",
  "hr",
  "tax",
  "marketing",
  "legal",
  "other",
]);

const PHOTO_CATEGORIES = new Set([
  "before",
  "progress",
  "final",
  "issue",
  "marketing",
  "safety",
  "incident",
]);

export interface FileIndexItem {
  kind: "photo" | "receipt" | "company" | "backup" | "job_file";
  id: string;
  title: string;
  subtitle: string | null;
  created_at: string | null;
  href: string;
  thumb_href: string | null;
  doc_type: string | null;
  /** Set for company docs — drives thumbnail vs icon in the file browser UI */
  mime_type: string | null;
  /** Hub Files UI: move/delete (receipts limited to PWA rows) */
  deletable: boolean;
  movable: boolean;
  /** For move dialog defaults (photos, receipts) */
  job_id: string | null;
  /** Photo on-site category */
  category: string | null;
}

export async function handleFilesList(env: Env, url: URL): Promise<FileIndexItem[]> {
  const kind = url.searchParams.get("kind") ?? "all";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(400, Math.max(50, Number(url.searchParams.get("limit")) || 200));
  const companyDocType = url.searchParams.get("doc_type");
  const photoCategory = url.searchParams.get("category");
  /** Browses one job: used when `kind=photo` (per-job site photos) or `kind=job_file` (project files). */
  const scopeJobId = (url.searchParams.get("job_id") ?? "").trim() || null;
  const jobFileDocTypeParam = url.searchParams.get("job_doc_type");
  const jobFileDocTypeFilter =
    kind === "job_file" && jobFileDocTypeParam && JOB_FILE_TYPES.has(jobFileDocTypeParam) ?
      jobFileDocTypeParam
    : null;
  const docTypeFilter =
    kind === "company" && companyDocType && COMPANY_DOC_TYPES.has(companyDocType) ?
      companyDocType
    : null;
  const photoCatFilter =
    kind === "photo" && photoCategory && PHOTO_CATEGORIES.has(photoCategory) ?
      photoCategory
    : null;
  // When browsing all files, do not use category unless explicitly passed for photos (legacy).
  const allPhotoCategoryFilter =
    kind === "all" && photoCategory && PHOTO_CATEGORIES.has(photoCategory) ? photoCategory : null;

  const out: FileIndexItem[] = [];

  const want = (k: string) => kind === "all" || kind === k;

  if (want("photo")) {
    const phW: string[] = [];
    const phB: (string | number)[] = [];
    if (kind === "photo") {
      if (scopeJobId) {
        phW.push("p.job_id = ?");
        phB.push(scopeJobId);
      } else {
        phW.push("p.job_id IS NULL");
      }
      if (photoCatFilter) {
        phW.push("p.category = ?");
        phB.push(photoCatFilter);
      }
    } else if (allPhotoCategoryFilter) {
      phW.push("p.category = ?");
      phB.push(allPhotoCategoryFilter);
    }
    const photoWhere = phW.length > 0 ? `WHERE ${phW.join(" AND ")}` : "";
    const photos = await env.DB.prepare(
      `SELECT p.id, p.created_at, p.taken_at, p.category, p.job_id, p.caption, p.r2_key, j.title AS job_title
       FROM photos p
       LEFT JOIN jobs j ON j.id = p.job_id
       ${photoWhere}
       ORDER BY datetime(p.created_at) DESC
       LIMIT ?`,
    )
      .bind(...[...phB, limit])
      .all<{
        id: string;
        created_at: string;
        taken_at: string | null;
        category: string;
        job_id: string | null;
        caption: string | null;
        r2_key: string;
        job_title: string | null;
      }>();
    for (const p of photos.results ?? []) {
      const title = p.caption?.trim() || `Photo · ${p.category}`;
      const subtitle = p.job_title
        ? `${p.job_title}`
        : p.job_id
          ? `Job ${p.job_id}`
          : "General";
      const item: FileIndexItem = {
        kind: "photo",
        id: p.id,
        title,
        subtitle,
        created_at: p.taken_at ?? p.created_at,
        href: `/api/photos/${encodeURIComponent(p.id)}`,
        thumb_href: `/api/photos/${encodeURIComponent(p.id)}/thumb`,
        doc_type: null,
        mime_type: "image/jpeg",
        deletable: true,
        movable: true,
        job_id: p.job_id,
        category: p.category,
      };
      if (!matchQ(q, item)) continue;
      out.push(item);
    }
  }

  if (want("receipt")) {
    const ex = await env.DB.prepare(
      `SELECT e.id, e.incurred_at, e.synced_at, e.description, e.vendor, e.receipt_r2_key, e.job_id, e.entered_via,
            j.title AS job_title
       FROM expenses e
       LEFT JOIN jobs j ON j.id = e.job_id
       WHERE e.receipt_r2_key IS NOT NULL
       ORDER BY COALESCE(e.incurred_at, e.synced_at) DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all<{
        id: string;
        incurred_at: string | null;
        synced_at: string;
        description: string | null;
        vendor: string | null;
        receipt_r2_key: string;
        job_id: string | null;
        job_title: string | null;
        entered_via: string;
      }>();
    for (const e of ex.results ?? []) {
      const title = e.vendor?.trim() || e.description?.trim() || `Expense ${e.id.slice(0, 8)}`;
      const subtitle = e.job_title ?? (e.job_id ? `Job ${e.job_id}` : "—");
      const pwa = e.entered_via === "pwa";
      const item: FileIndexItem = {
        kind: "receipt",
        id: e.id,
        title: `Receipt · ${title}`,
        subtitle,
        created_at: e.incurred_at ?? e.synced_at,
        href: `/api/expenses/${encodeURIComponent(e.id)}/receipt`,
        thumb_href: `/api/expenses/${encodeURIComponent(e.id)}/receipt`,
        doc_type: null,
        mime_type: "image/jpeg",
        deletable: pwa,
        movable: pwa,
        job_id: e.job_id,
        category: null,
      };
      if (!matchQ(q, item)) continue;
      out.push(item);
    }
  }

  if (want("company")) {
    const coWhere = docTypeFilter ? "WHERE doc_type = ?" : "";
    const docs = await env.DB.prepare(
      `SELECT id, title, doc_type, filename, mime_type, created_at, effective_date, expires_at, notes
       FROM company_documents
       ${coWhere}
       ORDER BY datetime(created_at) DESC
       LIMIT ?`,
    )
      .bind(...(docTypeFilter ? [docTypeFilter, limit] : [limit]))
      .all<{
        id: string;
        title: string;
        doc_type: string;
        filename: string;
        mime_type: string;
        created_at: string;
        effective_date: string | null;
        expires_at: string | null;
        notes: string | null;
      }>();
    for (const d of docs.results ?? []) {
      const item: FileIndexItem = {
        kind: "company",
        id: d.id,
        title: d.title,
        subtitle: [d.doc_type, d.filename, d.effective_date, d.expires_at]
          .filter(Boolean)
          .join(" · "),
        created_at: d.created_at,
        href: `/api/company-documents/${encodeURIComponent(d.id)}/file`,
        thumb_href:
          d.mime_type.startsWith("image/") ?
            `/api/company-documents/${encodeURIComponent(d.id)}/file`
          : null,
        doc_type: d.doc_type,
        mime_type: d.mime_type,
        deletable: true,
        movable: true,
        job_id: null,
        category: null,
      };
      if (!matchQ(q, item)) continue;
      out.push(item);
    }
  }

  if (want("job_file") && !(kind === "job_file" && !scopeJobId)) {
    const jfWhere: string[] = ["1=1"];
    const jfBinds: (string | number)[] = [];
    if (kind === "job_file" && scopeJobId) {
      jfWhere.push("jf.job_id = ?");
      jfBinds.push(scopeJobId);
    }
    // “All files” should not list project files for archived/closed jobs (only active pipeline, same as Jobs tree).
    if (kind === "all") {
      const ph = OPEN_JOB_STATUSES.map(() => "lower(COALESCE(j.status, '')) = ?").join(" OR ");
      jfWhere.push(`(${ph})`);
      for (const s of OPEN_JOB_STATUSES) {
        jfBinds.push(s);
      }
    }
    if (jobFileDocTypeFilter) {
      jfWhere.push("jf.doc_type = ?");
      jfBinds.push(jobFileDocTypeFilter);
    }
    const jfSql = `SELECT jf.id, jf.job_id, jf.created_at, jf.title, jf.doc_type, jf.filename, jf.mime_type,
         jf.notes, j.title AS job_title, j.job_number
       FROM job_files jf
       LEFT JOIN jobs j ON j.id = jf.job_id
       WHERE ${jfWhere.join(" AND ")}
       ORDER BY datetime(jf.created_at) DESC
       LIMIT ?`;
    jfBinds.push(limit);
    const jf = await env.DB.prepare(jfSql)
      .bind(...jfBinds)
      .all<{
        id: string;
        job_id: string;
        created_at: string;
        title: string;
        doc_type: string;
        filename: string;
        mime_type: string;
        notes: string | null;
        job_title: string | null;
        job_number: number | null;
      }>();
    for (const r of jf.results ?? []) {
      const jobLine =
        r.job_number != null && r.job_title ?
          `#${r.job_number} ${r.job_title}`
        : r.job_title || r.job_id;
      const typeLine = JOB_FILE_DOC_LABEL[r.doc_type] ?? r.doc_type;
      const item: FileIndexItem = {
        kind: "job_file",
        id: r.id,
        title: r.title,
        subtitle: [jobLine, typeLine, r.filename, r.notes].filter(Boolean).join(" · "),
        created_at: r.created_at,
        href: `/api/job-files/${encodeURIComponent(r.id)}/file`,
        thumb_href: r.mime_type.startsWith("image/") ? `/api/job-files/${encodeURIComponent(r.id)}/file` : null,
        doc_type: r.doc_type,
        mime_type: r.mime_type,
        deletable: true,
        movable: true,
        job_id: r.job_id,
        category: null,
      };
      if (!matchQ(q, item)) continue;
      out.push(item);
    }
  }

  if (want("backup")) {
    const listed = await env.FILES.list({ prefix: "backups/d1/", limit: 50 });
    for (const o of listed.objects) {
      const key = o.key;
      const name = key.replace(/^.*\//, "");
      const item: FileIndexItem = {
        kind: "backup",
        id: key,
        title: `D1 backup · ${name}`,
        subtitle: o.uploaded ? new Date(o.uploaded).toISOString().slice(0, 19) : null,
        created_at: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        href: `/api/files/backup?key=${encodeURIComponent(key)}`,
        thumb_href: null,
        doc_type: "backup",
        mime_type: "application/gzip",
        deletable: true,
        movable: false,
        job_id: null,
        category: null,
      };
      if (!matchQ(q, item)) continue;
      out.push(item);
    }
  }

  out.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });

  return out.slice(0, limit);
}

function matchQ(q: string, item: FileIndexItem): boolean {
  if (!q) return true;
  const hay = `${item.title} ${item.subtitle ?? ""} ${item.kind} ${item.doc_type ?? ""} ${
    item.job_id ?? ""
  } ${item.id}`.toLowerCase();
  return hay.includes(q);
}

const BACKUP_KEY_PREFIX = "backups/d1/";

/**
 * Stream a nightly D1 backup from R2 (read-only, Access-gated in prod).
 * Only keys under backups/d1/ are allowed.
 */
export async function handleFilesBackupDownload(
  env: Env,
  url: URL,
  method: string,
): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  if (!key.startsWith(BACKUP_KEY_PREFIX) || key.includes("..") || key.includes("\\")) {
    return new Response(JSON.stringify({ error: "invalid_key" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const obj = await env.FILES.get(key);
  if (!obj) {
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }
  const name = key.replace(/^.*\//, "");
  const body = method === "HEAD" ? null : obj.body;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/gzip",
      "content-disposition": `attachment; filename="${encodeURIComponent(name)}"`,
      "cache-control": "private, max-age=60",
    },
  });
}

/**
 * DELETE /api/files/backup?key=... — only keys under backups/d1/ (same rules as download).
 */
export async function handleFilesBackupDelete(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  if (!key.startsWith(BACKUP_KEY_PREFIX) || key.includes("..") || key.includes("\\")) {
    return new Response(JSON.stringify({ error: "invalid_key" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const exists = await env.FILES.head(key);
  if (!exists) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  await env.FILES.delete(key);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
