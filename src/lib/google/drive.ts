/**
 * Google Drive API v3 — minimal upload + folder create for Shared Drives.
 *
 * Requires service account in `GOOGLE_SERVICE_ACCOUNT_JSON` with Drive API
 * enabled and the account added to the target Shared Drive (e.g. Content
 * manager). Operator sets DRIVE_SHARED_DRIVE_ID + DRIVE_MIRROR_ROOT_FOLDER_ID
 * in wrangler [vars] so uploads land under a known folder.
 */

import { getGoogleAccessToken } from "./auth.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

function jsonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export async function getDriveAccessToken(serviceAccountJson: string): Promise<string> {
  return getGoogleAccessToken(serviceAccountJson, [DRIVE_SCOPE]);
}

/**
 * Create a child folder, or return existing if name matches in parent.
 * Uses corpora on shared drive.
 */
export async function getOrCreateFolder(params: {
  token: string;
  driveId: string;
  parentId: string;
  name: string;
}): Promise<string> {
  const { token, driveId, parentId, name } = params;
  const q = encodeURIComponent(
    `name='${escapeQuery(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const listUrl = `${DRIVE_BASE}/files?supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive&driveId=${encodeURIComponent(
    driveId,
  )}&q=${q}&pageSize=5&fields=files(id,name)`;
  const listRes = await fetch(listUrl, { headers: { authorization: `Bearer ${token}` } });
  if (!listRes.ok) {
    const t = await listRes.text();
    throw new Error(`Drive list folder failed (${listRes.status}): ${t}`);
  }
  const listJson = (await listRes.json()) as { files?: { id: string }[] };
  if (listJson.files?.[0]?.id) return listJson.files[0].id;

  const createRes = await fetch(
    `${DRIVE_BASE}/files?supportsAllDrives=true&fields=id`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    },
  );
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Drive create folder failed (${createRes.status}): ${t}`);
  }
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

/**
 * Multipart upload (metadata + media) for files up to ~5–10 MB in Workers.
 */
export async function uploadFileMultipart(params: {
  token: string;
  name: string;
  parents: string[];
  body: ArrayBuffer;
  mimeType: string;
}): Promise<string> {
  const { token, name, parents, body, mimeType } = params;
  const meta = { name, parents };
  const boundary = "chs_mpart_" + crypto.randomUUID();
  const metaPart = JSON.stringify(meta);
  const crlf = "\r\n";
  const p1 = `--${boundary}${crlf}Content-Type: application/json; charset=UTF-8${crlf}${crlf}${metaPart}${crlf}`;
  const p2 = `--${boundary}${crlf}Content-Type: ${mimeType}${crlf}${crlf}`;
  const p3 = `${crlf}--${boundary}--${crlf}`;

  const u8 = new TextEncoder();
  const head = u8.encode(p1 + p2);
  const tail = u8.encode(p3);
  const combined = new Uint8Array(head.byteLength + body.byteLength + tail.byteLength);
  combined.set(head, 0);
  combined.set(new Uint8Array(body), head.byteLength);
  combined.set(tail, head.byteLength + body.byteLength);

  const url = `${UPLOAD_BASE}/files?uploadType=multipart&supportsAllDrives=true&fields=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body: combined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${t.slice(0, 500)}`);
  }
  const out = (await res.json()) as { id: string };
  return out.id;
}

function escapeQuery(s: string): string {
  return s.replace(/'/g, "\\'");
}

export function guessMimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}
