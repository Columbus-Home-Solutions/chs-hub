/**
 * Google service-account authentication for Cloudflare Workers.
 *
 * Exchanges a JWT (signed with the service account's RS256 private key) for
 * a short-lived OAuth2 access token. No Node crypto here — everything uses
 * the Web Crypto API that ships with Workers.
 *
 * Tokens are cached in-memory for the lifetime of the isolate (50 min) so we
 * don't hit Google's token endpoint on every request.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Tokens are per-scope-set so a caller that needs only Sheets does not reuse
// a token minted for Drive (and vice versa).
const tokenCache = new Map<string, CachedToken>();

function tokenCacheKey(scopes: string[]): string {
  return [...scopes].sort().join(" ");
}

export async function getGoogleAccessToken(
  serviceAccountJson: string,
  scopes: string[],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKeyStr = tokenCacheKey(scopes);
  const hit = tokenCache.get(cacheKeyStr);
  if (hit && hit.expiresAt > now + 60) {
    return hit.token;
  }

  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";

  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(" "),
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claim}`;

  const privateKey = await importPrivateKey(sa.private_key);
  const signatureBuf = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const signature = base64urlBytes(new Uint8Array(signatureBuf));
  const assertion = `${signingInput}.${signature}`;

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Google token exchange failed (${resp.status}): ${body}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  const entry = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600),
  };
  tokenCache.set(cacheKeyStr, entry);
  return entry.token;
}

// ── helpers ──────────────────────────────────────────────────────────

function base64url(input: string): string {
  return base64urlBytes(new TextEncoder().encode(input));
}

function base64urlBytes(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM header/footer/newlines → raw base64 → ArrayBuffer
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bin.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
