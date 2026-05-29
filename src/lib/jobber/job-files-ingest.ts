/**
 * Pull Jobber job note attachment metadata from sync, download bytes, store in R2,
 * insert `job_files` rows (`source = jobber`, `jobber_attachment_id` for idempotency).
 * Drive mirror picks them up like dashboard uploads.
 */

import type { Env } from "../../env.js";
import { getAccessToken } from "./auth.js";

const MAX_BYTES = 32 * 1024 * 1024;

/** Shape returned under Job.noteAttachments / JobNote.fileAttachments (Jobber type `JobNoteFile`). */
export interface JobberNoteAttachmentNode {
  id: string;
  fileName?: string | null;
  mimeType?: string | null;
  /** Public or signed download URL from Jobber. */
  url?: string | null;
}

function displayFileName(n: JobberNoteAttachmentNode): string {
  const raw = (n.fileName || "attachment").trim();
  return raw || "attachment";
}

function extFromFilename(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,8})$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

function docTypeFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "contracts";
  if (m.startsWith("image/")) return "drawings";
  if (m.includes("spreadsheet") || m.includes("excel") || m === "text/csv") return "other";
  if (m.includes("word") || m.includes("document")) return "notes";
  return "other";
}

function safePathSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "file";
}

async function downloadAttachment(
  url: string,
  tokenRef: { current: string },
  env: Env,
): Promise<{ buf: ArrayBuffer; contentType: string | null }> {
  const tryOnce = (headers: Record<string, string>) =>
    fetch(url, {
      redirect: "follow",
      headers,
    });

  let res = await tryOnce({});
  if (res.status === 401 || res.status === 403) {
    res = await tryOnce({ authorization: `Bearer ${tokenRef.current}` });
  }
  if (res.status === 401 || res.status === 403) {
    tokenRef.current = await getAccessToken(env);
    res = await tryOnce({ authorization: `Bearer ${tokenRef.current}` });
  }
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > MAX_BYTES) {
      throw new Error(`file too large (${n} bytes)`);
    }
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`file too large (${buf.byteLength} bytes)`);
  }
  return { buf, contentType: res.headers.get("content-type") };
}

/** Merge root `noteAttachments` and per-note `fileAttachments`; dedupe by Jobber file id. */
export function flattenJobNoteAttachments(job: {
  noteAttachments?: { nodes: (JobberNoteAttachmentNode | null | undefined)[] | null } | null;
  notes?: { nodes: unknown[] | null } | null;
}): JobberNoteAttachmentNode[] {
  const byId = new Map<string, JobberNoteAttachmentNode>();
  for (const n of job.noteAttachments?.nodes ?? []) {
    if (n?.id) byId.set(n.id, n);
  }
  for (const raw of job.notes?.nodes ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as {
      fileAttachments?: { nodes?: (JobberNoteAttachmentNode | null | undefined)[] | null } | null;
      noteAttachments?: { nodes?: (JobberNoteAttachmentNode | null | undefined)[] | null } | null;
    };
    const perNote = obj.fileAttachments?.nodes ?? obj.noteAttachments?.nodes ?? [];
    for (const n of perNote) {
      if (n?.id) byId.set(n.id, n);
    }
  }
  return [...byId.values()];
}

export async function ingestJobberNoteAttachmentsForJob(
  env: Env,
  tokenRef: { current: string },
  jobId: string,
  nodes: JobberNoteAttachmentNode[] | undefined | null,
  stats: { jobber_job_files_written: number; errors: string[] },
): Promise<void> {
  const list = nodes ?? [];
  if (list.length === 0) return;

  for (const node of list) {
    if (!node?.id || !node.url?.trim()) continue;

    const dup = await env.DB.prepare("SELECT 1 AS o FROM job_files WHERE jobber_attachment_id = ?")
      .bind(node.id)
      .first<{ o: number }>();
    if (dup) continue;

    const filename = displayFileName(node);
    const ext = extFromFilename(filename) || ".bin";

    let buf: ArrayBuffer;
    let mime: string;
    try {
      const dl = await downloadAttachment(node.url.trim(), tokenRef, env);
      buf = dl.buf;
      mime =
        (node.mimeType && node.mimeType.trim()) ||
        dl.contentType?.split(";")[0]?.trim() ||
        "application/octet-stream";
    } catch (e) {
      stats.errors.push(`jobber_file ${jobId} ${node.id}: ${(e as Error).message}`);
      continue;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = filename.replace(/\.[^/.]+$/, "").slice(0, 200) || filename.slice(0, 200);
    const docType = docTypeFromMime(mime);
    const r2Key = `job-files/${jobId}/jobber/${safePathSegment(node.id)}${ext}`;

    await env.FILES.put(r2Key, buf, { httpMetadata: { contentType: mime } });
    try {
      await env.DB.prepare(
        `INSERT INTO job_files
          (id, job_id, created_at, updated_at, title, doc_type, r2_key, filename, mime_type, size_bytes, notes, uploaded_by, source, jobber_attachment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'jobber', ?)`,
      )
        .bind(
          id,
          jobId,
          now,
          now,
          title,
          docType,
          r2Key,
          filename,
          mime,
          buf.byteLength,
          "Imported from Jobber (job note attachment)",
          node.id,
        )
        .run();
      stats.jobber_job_files_written++;
    } catch (e) {
      await env.FILES.delete(r2Key).catch(() => undefined);
      stats.errors.push(`jobber_file ${jobId} ${node.id}: ${(e as Error).message}`);
    }
  }
}
