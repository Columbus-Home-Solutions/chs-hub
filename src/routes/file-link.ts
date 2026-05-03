/**
 * Time-limited signed URLs for sharing Hub file blobs in email / external tools.
 * POST /api/file-link  (logged-in, CF Access) — body { kind, id, ttl_sec? }
 * GET  /api/f?t=…      (public — HMAC; use workers.dev or add Access skip for this path on dashboard)
 */

import type { Env } from "../env.js";
import { handleCompanyDocumentFile } from "./company-documents.js";
import { handleExpenseReceipt } from "./expenses.js";
import { handleJobFileStream } from "./job-files.js";
import { handlePhotoStream } from "./photos.js";

const KINDS = new Set(["job_file", "company", "photo", "receipt"]);

type PayloadV1 = { v: 1; k: "job_file" | "company" | "photo" | "receipt"; i: string; e: number };

function jsonErr(status: number, code: string, message?: string): Response {
  return new Response(JSON.stringify({ error: code, message: message ?? code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function b64uEncode(data: string): string {
  return btoa(data)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64uDecode(s: string): string {
  const pad = 4 - (s.length % 4 || 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + (pad < 4 ? "=".repeat(pad) : "");
  return atob(b64);
}

async function hmacB64u(secret: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)),
  );
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return b64uEncode(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let o = 0;
  for (let i = 0; i < a.length; i++) o |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return o === 0;
}

function getSecret(env: Env): string | null {
  const s = (env as { FILE_LINK_SECRET?: string }).FILE_LINK_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

function getLinkOrigin(request: URL, env: Env): string {
  const o = (env as { HUB_FILE_LINK_ORIGIN?: string }).HUB_FILE_LINK_ORIGIN?.trim();
  if (o) return o.replace(/\/$/, "");
  return request.origin;
}

async function verifyExists(
  env: Env,
  k: "job_file" | "company" | "photo" | "receipt",
  id: string,
): Promise<boolean> {
  if (k === "job_file") {
    const r = await env.DB.prepare("SELECT 1 AS o FROM job_files WHERE id = ?")
      .bind(id)
      .first<{ o: number }>();
    return !!r;
  }
  if (k === "company") {
    const r = await env.DB.prepare("SELECT 1 AS o FROM company_documents WHERE id = ?")
      .bind(id)
      .first<{ o: number }>();
    return !!r;
  }
  if (k === "photo") {
    const r = await env.DB.prepare("SELECT 1 AS o FROM photos WHERE id = ?")
      .bind(id)
      .first<{ o: number }>();
    return !!r;
  }
  const h = await env.DB.prepare("SELECT receipt_r2_key FROM expenses WHERE id = ?")
    .bind(id)
    .first<{ receipt_r2_key: string | null }>();
  return !!h?.receipt_r2_key;
}

export async function handleFileLinkCreate(env: Env, request: Request, requestUrl: URL): Promise<Response> {
  if (request.method !== "POST") {
    return jsonErr(405, "method_not_allowed");
  }
  const user = request.headers.get("cf-access-authenticated-user-email");
  if (!user) {
    return jsonErr(401, "unauthorized", "File links require a logged-in Hub session (Cloudflare Access).");
  }
  const sec = getSecret(env);
  if (!sec) {
    return jsonErr(503, "file_link_unconfigured", "Set the FILE_LINK_SECRET wrangler secret (≥16 chars) to enable shareable links.");
  }
  let body: { kind?: string; id?: string; ttl_sec?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!KINDS.has(kind) || !id) {
    return jsonErr(400, "bad_request", "kind (job_file|company|photo|receipt) and id are required.");
  }
  const k = kind as "job_file" | "company" | "photo" | "receipt";
  if (!(await verifyExists(env, k, id))) {
    return jsonErr(404, "not_found", "File not found or (for receipts) no image attached.");
  }
  const ttl = Math.min(7 * 24 * 3600, Math.max(60, Number(body.ttl_sec) || 86400));
  const e = Math.floor(Date.now() / 1000) + ttl;
  const p: PayloadV1 = { v: 1, k, i: id, e };
  const j = b64uEncode(JSON.stringify(p));
  const sig = await hmacB64u(sec, j);
  const token = `${j}.${sig}`;
  const origin = getLinkOrigin(requestUrl, env);
  const u = new URL("/api/f", origin);
  u.searchParams.set("t", token);
  return new Response(
    JSON.stringify({
      url: u.toString(),
      expires_at: new Date(e * 1000).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

const corsFileHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
};

export async function handleFileLinkResolve(
  env: Env,
  request: Request,
  requestUrl: URL,
  method: string,
): Promise<Response> {
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsFileHeaders,
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-max-age": "86400",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return jsonErr(405, "method_not_allowed");
  }
  const sec = getSecret(env);
  if (!sec) {
    return jsonErr(503, "file_link_unconfigured");
  }
  const token = (requestUrl.searchParams.get("t") ?? "").trim();
  if (!token.includes(".")) {
    return jsonErr(400, "invalid_token");
  }
  const dot = token.indexOf(".");
  const j = token.slice(0, dot);
  const sigB64u = token.slice(dot + 1);
  const expect = await hmacB64u(sec, j);
  if (!timingSafeEqual(sigB64u, expect)) {
    return jsonErr(403, "invalid_signature");
  }
  let p: PayloadV1;
  try {
    p = JSON.parse(b64uDecode(j)) as PayloadV1;
  } catch {
    return jsonErr(400, "invalid_token");
  }
  if (p.v !== 1 || !KINDS.has(p.k) || typeof p.i !== "string" || !p.i || typeof p.e !== "number") {
    return jsonErr(400, "invalid_token");
  }
  if (p.e < Math.floor(Date.now() / 1000)) {
    return jsonErr(410, "expired", "This link has expired. Create a new one from Hub Files.");
  }
  if (!(await verifyExists(env, p.k, p.i))) {
    return jsonErr(404, "not_found");
  }

  async function withCors(res: Response, m: string): Promise<Response> {
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", "*");
    h.set("cache-control", "private, max-age=60");
    const body = m === "HEAD" ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
  }

  if (p.k === "job_file") {
    return withCors(await handleJobFileStream(env, p.i, method), method);
  }
  if (p.k === "company") {
    return withCors(await handleCompanyDocumentFile(env, p.i, method), method);
  }
  if (p.k === "photo") {
    return withCors(await handlePhotoStream(env, p.i, "original"), method);
  }
  return withCors(await handleExpenseReceipt(env, p.i), method);
}
