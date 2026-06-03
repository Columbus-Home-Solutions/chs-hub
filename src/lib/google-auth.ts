/**
 * Google service account OAuth2 for Cloudflare Workers.
 * Uses Web Crypto API only — no Node.js crypto, no SDK.
 */

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export async function getGoogleAccessToken(
  clientEmail: string,
  privateKeyPem: string,
  scope: string,
): Promise<string> {
  const now = Date.now();

  if (tokenCache && tokenCache.expiresAt > now + 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const token = await fetchNewToken(clientEmail, privateKeyPem, scope);

  tokenCache = {
    token,
    expiresAt: now + 55 * 60 * 1000,
  };

  return token;
}

async function fetchNewToken(
  clientEmail: string,
  privateKeyPem: string,
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const toB64Url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const headerB64 = toB64Url(header);
  const claimsB64 = toB64Url(claims);
  const signingInput = `${headerB64}.${claimsB64}`;

  const privateKey = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${signingInput}.${signatureB64}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google token exchange failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const contents = normalized
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binary = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
