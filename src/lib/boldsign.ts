/**
 * boldsign.ts — BoldSign e-signature API client + webhook HMAC verification.
 *
 * Mode gate mirrors `social-publish.ts` / SOCIAL_PUBLISH_MODE discipline:
 *   - Only the exact value "live" uses real legally-binding signature requests.
 *   - Everything else (default "sandbox") uses the same API but logs [BOLDSIGN SANDBOX].
 *   - Mode is read from env.ESIGNATURE_MODE first, then system_settings 'esignature_mode'.
 *
 * API base URL:
 *   Both sandbox and live use https://api.boldsign.com.
 *   The sandbox API key Tony generates from the BoldSign sandbox account is what
 *   makes requests go to the sandbox environment (watermarked, non-binding).
 *
 * Webhook signature (X-BoldSign-Signature: t=…,s0=…,s1=…):
 *   Parse ALL s0/s1 entries; accept if ANY matches the HMAC-SHA256 of
 *   `${t}.${rawBody}` with BOLDSIGN_WEBHOOK_SECRET. Mirrors the Stripe multi-v1
 *   fix (secret-roll grace: both old and new secret are valid during rollover).
 *
 * Signature field placement decision (Step 0):
 *   We use API-level coordinate-based form fields rather than template text tags.
 *   Fields are placed at the bottom of page 1 (Y≈720) — valid for the current
 *   single-page and short-form templates. When templates are revised, consider
 *   adding BoldSign text tags (e.g. {{Signature_es_:signer1:signature}}) so the
 *   field anchors to the actual signature line regardless of page count/reflow.
 */

import type { Env } from "../env.js";

// ─── Mode gate ────────────────────────────────────────────────────────────────

export type ESignatureMode = "sandbox" | "live";

export const SETTING_ESIGNATURE_MODE = "esignature_mode";
export const BOLDSIGN_API_BASE = "https://api.boldsign.com";

async function getSetting(env: Env, key: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
      .bind(key)
      .first<{ value: string | null }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function normalizeMode(value: string | null | undefined): ESignatureMode {
  return (value ?? "").trim().toLowerCase() === "live" ? "live" : "sandbox";
}

/** Resolves esignature_mode: env var wins, then system_settings, then "sandbox". */
export async function resolveESignatureMode(env: Env): Promise<ESignatureMode> {
  const fromEnv = (env.ESIGNATURE_MODE ?? "").trim();
  if (fromEnv) return normalizeMode(fromEnv);
  const fromSettings = await getSetting(env, SETTING_ESIGNATURE_MODE);
  return normalizeMode(fromSettings);
}

// ─── HMAC verification ────────────────────────────────────────────────────────

/**
 * Parse X-BoldSign-Signature header: `t=<timestamp>,s0=<hex>,s1=<hex>,...`
 * Returns null if the header is malformed.
 */
function parseBoldSignHeader(header: string): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t") timestamp = val;
    else if (key.match(/^s\d+$/)) signatures.push(val);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header_or_secret" | "malformed_header" | "signature_mismatch" };

/** Verify X-BoldSign-Signature HMAC. Accepts if any s0/s1 entry matches. */
export async function verifyBoldSignWebhook(
  rawBody: string,
  sigHeader: string | null,
  secret: string | null,
): Promise<WebhookVerifyResult> {
  if (!sigHeader || !secret) return { ok: false, reason: "missing_header_or_secret" };

  const parsed = parseBoldSignHeader(sigHeader);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  const matched = parsed.signatures.some((s) => timingSafeEqual(expected, s));
  if (!matched) return { ok: false, reason: "signature_mismatch" };

  return { ok: true };
}

// ─── API helpers ──────────────────────────────────────────────────────────────

export interface BoldSignConfig {
  apiKey: string;
  mode: ESignatureMode;
}

export async function getBoldSignConfig(env: Env): Promise<BoldSignConfig | null> {
  const apiKey = (env.BOLDSIGN_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const mode = await resolveESignatureMode(env);
  return { apiKey, mode };
}

async function boldSignRequest(
  config: BoldSignConfig,
  path: string,
  method: string,
  body?: BodyInit,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-API-KEY": config.apiKey,
    ...extraHeaders,
  };
  return fetch(`${BOLDSIGN_API_BASE}${path}`, { method, headers, body });
}

// ─── Send document ────────────────────────────────────────────────────────────

export interface SendDocumentArgs {
  fileBlob: Blob;
  filename: string;
  title: string;
  message: string;
  signerEmail: string;
  signerName: string;
  /** BoldSign template ID. When provided, sends via /v1/template/send so
   *  field positions defined by drag-and-drop in the BoldSign UI are used.
   *  The generated file is attached as an additional file alongside the template. */
  templateId?: string;
}

export interface SendDocumentResult {
  documentId: string;
}

/**
 * Send a document to BoldSign for signature.
 *
 * When a templateId is provided the request goes to /v1/template/send so that
 * signature field positions are inherited from the template (set visually in
 * the BoldSign dashboard). The dynamically-generated DOCX is attached as the
 * primary additional file. RoleIndex 1 maps to the "Client" role.
 *
 * When no templateId is provided we fall back to /v1/document/send with
 * coordinate-based field placement (legacy path).
 */
export async function sendDocumentForSignature(
  config: BoldSignConfig,
  args: SendDocumentArgs,
): Promise<SendDocumentResult> {
  const label = config.mode === "sandbox" ? "[BOLDSIGN SANDBOX]" : "[BOLDSIGN LIVE]";

  let res: Response;

  if (args.templateId) {
    // ── Template-based send (preferred) ──────────────────────────────────────
    // Field positions come from the template; no coordinates needed here.
    const form = new FormData();
    form.append("Title", args.title);
    form.append("Message", args.message);
    form.append("Files", args.fileBlob, args.filename);
    // Role index 1 = "Client" role created in the BoldSign template UI
    form.append("roles[0][roleIndex]", "1");
    form.append("roles[0][signerName]", args.signerName);
    form.append("roles[0][signerEmail]", args.signerEmail);
    form.append("roles[0][signerType]", "Signer");

    console.log(
      `${label} send_document (template=${args.templateId}): file="${args.filename}" signer="${args.signerEmail}"`,
    );
    res = await boldSignRequest(
      config,
      `/v1/template/send?templateId=${encodeURIComponent(args.templateId)}`,
      "POST",
      form,
    );
  } else {
    // ── Legacy coordinate-based send ─────────────────────────────────────────
    const form = new FormData();
    form.append("Title", args.title);
    form.append("Message", args.message);
    form.append("Files", args.fileBlob, args.filename);
    form.append("Signers[0][Name]", args.signerName);
    form.append("Signers[0][EmailAddress]", args.signerEmail);
    form.append("Signers[0][SignerType]", "Signer");
    form.append("Signers[0][FormFields][0][FieldType]", "Signature");
    form.append("Signers[0][FormFields][0][PageNumber]", "2");
    form.append("Signers[0][FormFields][0][Bounds][X]", "420");
    form.append("Signers[0][FormFields][0][Bounds][Y]", "230");
    form.append("Signers[0][FormFields][0][Bounds][Width]", "200");
    form.append("Signers[0][FormFields][0][Bounds][Height]", "30");
    form.append("Signers[0][FormFields][0][IsRequired]", "true");
    form.append("Signers[0][FormFields][1][FieldType]", "DateSigned");
    form.append("Signers[0][FormFields][1][PageNumber]", "2");
    form.append("Signers[0][FormFields][1][Bounds][X]", "420");
    form.append("Signers[0][FormFields][1][Bounds][Y]", "175");
    form.append("Signers[0][FormFields][1][Bounds][Width]", "160");
    form.append("Signers[0][FormFields][1][Bounds][Height]", "22");
    form.append("Signers[0][FormFields][1][IsRequired]", "true");

    console.log(`${label} send_document (coords): file="${args.filename}" signer="${args.signerEmail}"`);
    res = await boldSignRequest(config, "/v1/document/send", "POST", form);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`BoldSign send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = (await res.json()) as { documentId?: string };
  if (!data.documentId) throw new Error("BoldSign send response missing documentId");
  console.log(`${label} send_document: documentId="${data.documentId}"`);
  return { documentId: data.documentId };
}

// ─── Download signed document ─────────────────────────────────────────────────

/** Download the signed PDF from BoldSign (called on Completed webhook). */
export async function downloadSignedDocument(
  config: BoldSignConfig,
  boldSignDocumentId: string,
): Promise<ArrayBuffer> {
  const label = config.mode === "sandbox" ? "[BOLDSIGN SANDBOX]" : "[BOLDSIGN LIVE]";
  console.log(`${label} download_signed: documentId="${boldSignDocumentId}"`);

  const res = await boldSignRequest(
    config,
    `/v1/document/download?documentId=${encodeURIComponent(boldSignDocumentId)}`,
    "GET",
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`BoldSign download failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  return res.arrayBuffer();
}

// ─── Reminder ─────────────────────────────────────────────────────────────────

/** Send a reminder to pending signers. */
export async function sendReminder(
  config: BoldSignConfig,
  boldSignDocumentId: string,
): Promise<void> {
  const label = config.mode === "sandbox" ? "[BOLDSIGN SANDBOX]" : "[BOLDSIGN LIVE]";
  console.log(`${label} send_reminder: documentId="${boldSignDocumentId}"`);

  // BoldSign requires: documentId as query param + JSON body with Message
  const res = await boldSignRequest(
    config,
    `/v1/document/remind?documentId=${encodeURIComponent(boldSignDocumentId)}`,
    "POST",
    JSON.stringify({ Message: "Please sign the document at your earliest convenience." }),
    { "Content-Type": "application/json" },
  );
  if (!res.ok && res.status !== 204) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`BoldSign reminder failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
}

// ─── Embedded signing link ────────────────────────────────────────────────────

export interface EmbeddedSignLinkResult {
  signLink: string;
}

/** Generate an embedded signing URL for the portal quote page. */
export async function getEmbeddedSignLink(
  config: BoldSignConfig,
  documentId: string,
  signerEmail: string,
  redirectUrl?: string,
): Promise<EmbeddedSignLinkResult> {
  const label = config.mode === "sandbox" ? "[BOLDSIGN SANDBOX]" : "[BOLDSIGN LIVE]";
  const params = new URLSearchParams({
    documentId,
    signerEmail,
  });
  if (redirectUrl) params.set("redirectUrl", redirectUrl);

  console.log(`${label} get_embedded_sign_link: documentId="${documentId}" signer="${signerEmail}"`);
  const res = await boldSignRequest(
    config,
    `/v1/document/getEmbeddedSignLink?${params.toString()}`,
    "GET",
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`BoldSign embed link failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = (await res.json()) as { signLink?: string };
  if (!data.signLink) throw new Error("BoldSign embed response missing signLink");
  return { signLink: data.signLink };
}

// ─── Revoke ───────────────────────────────────────────────────────────────────

/** Revoke an outstanding signature request. */
export async function revokeDocument(
  config: BoldSignConfig,
  boldSignDocumentId: string,
  reason: string,
): Promise<void> {
  const label = config.mode === "sandbox" ? "[BOLDSIGN SANDBOX]" : "[BOLDSIGN LIVE]";
  console.log(`${label} revoke_document: documentId="${boldSignDocumentId}"`);

  // BoldSign requires: documentId as query param + JSON body with Message
  const res = await boldSignRequest(
    config,
    `/v1/document/revoke?documentId=${encodeURIComponent(boldSignDocumentId)}`,
    "POST",
    JSON.stringify({ Message: reason }),
    { "Content-Type": "application/json" },
  );
  if (!res.ok && res.status !== 204) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`BoldSign revoke failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
}
