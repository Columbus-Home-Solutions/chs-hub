#!/usr/bin/env node
/**
 * One-shot OAuth helper for the Jobber "CHS Hub" developer app.
 *
 * Reads JOBBER_CLIENT_ID + JOBBER_CLIENT_SECRET from ../.env,
 * opens the browser to Jobber's authorize URL, runs a tiny
 * localhost HTTP server to catch the redirect, exchanges the
 * authorization code for tokens, and appends JOBBER_REFRESH_TOKEN
 * back into ../.env.
 *
 * Run:
 *   node scripts/jobber-oauth.mjs
 *
 * Re-run if the refresh token is ever invalidated (e.g. you rotate
 * the client secret, or the token expires from a long idle period).
 */

import { createServer } from "node:http";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";

const ENV_PATH = new URL("../.env", import.meta.url);
const PORT = 8787;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Must match (or be a subset of) the scopes configured in the Jobber app UI.
const SCOPES = [
  "read_clients",
  "read_jobs",
  "read_quotes",
  "read_invoices",
  "read_payments",
  "read_expenses",
  "read_custom_fields",
  "write_quotes",
  "write_clients",
];

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    env[key] = val.replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

function loadEnv() {
  return parseEnv(readFileSync(ENV_PATH, "utf8"));
}

function upsertEnvLine(key, value) {
  const text = readFileSync(ENV_PATH, "utf8");
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.match(new RegExp(`^${key}=`))) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    updated.push(`${key}=${value}`);
  }
  writeFileSync(ENV_PATH, updated.join("\n"));
}

function die(msg, code = 1) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(code);
}

const env = loadEnv();
const CLIENT_ID = env.JOBBER_CLIENT_ID;
const CLIENT_SECRET = env.JOBBER_CLIENT_SECRET;

if (!CLIENT_ID || CLIENT_ID.includes("PASTE")) {
  die("JOBBER_CLIENT_ID is missing or still a placeholder in .env");
}
if (!CLIENT_SECRET || CLIENT_SECRET.includes("PASTE")) {
  die("JOBBER_CLIENT_SECRET is missing or still a placeholder in .env");
}

const STATE = randomBytes(16).toString("hex");
const AUTHORIZE_URL =
  "https://api.getjobber.com/api/oauth/authorize?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state: STATE,
  }).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found. Waiting for /callback from Jobber…");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    const body = `<h1>Authorization failed</h1><pre>${error}\n\n${errorDescription ?? ""}</pre>`;
    res.writeHead(400, { "content-type": "text/html" });
    res.end(body);
    console.error(`\nAuth error: ${error} — ${errorDescription ?? ""}\n`);
    server.close();
    process.exit(1);
    return;
  }

  if (state !== STATE) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("State mismatch (possible CSRF) — aborting.");
    console.error("\nState mismatch. Re-run the script.\n");
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Missing authorization code");
    return;
  }

  console.log("\n→ Exchanging authorization code for tokens…");

  const tokenRes = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokenRes.ok) {
    const body = `<h1>Token exchange failed</h1><pre>${JSON.stringify(tokens, null, 2)}</pre>`;
    res.writeHead(500, { "content-type": "text/html" });
    res.end(body);
    console.error("\nToken exchange failed:\n", tokens, "\n");
    server.close();
    process.exit(1);
    return;
  }

  upsertEnvLine("JOBBER_REFRESH_TOKEN", tokens.refresh_token);

  console.log("\n===========================================");
  console.log("✅ SUCCESS — Jobber tokens received");
  console.log("===========================================\n");
  console.log(
    `Access token (expires in ${tokens.expires_in}s): ${tokens.access_token.slice(0, 12)}…(truncated)`,
  );
  console.log(`Refresh token written to .env: ${tokens.refresh_token.slice(0, 12)}…(truncated)`);
  console.log(`Scopes granted: ${tokens.scope ?? "(not returned)"}`);
  console.log("\nYou can close the browser tab and return here.\n");

  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!DOCTYPE html>
    <html><head><title>CHS Hub OAuth</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 2rem; color: #0f172a; }
      h1 { color: #059669; }
      .tick { font-size: 3rem; }
    </style></head>
    <body>
      <div class="tick">✓</div>
      <h1>Jobber authorization complete</h1>
      <p>Your refresh token has been saved to <code>.env</code>.</p>
      <p>You can close this tab and return to the terminal.</p>
    </body></html>`,
  );

  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 500);
});

server.listen(PORT, () => {
  console.log(`\nOAuth helper listening on http://localhost:${PORT}`);
  console.log(`Scopes requested: ${SCOPES.join(", ")}`);
  console.log("\nOpening browser to authorize…");

  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

  exec(`${openCmd} "${AUTHORIZE_URL}"`);

  console.log("\nIf the browser didn't open automatically, paste this URL into Chrome/Safari:\n");
  console.log(AUTHORIZE_URL);
  console.log("\nWaiting for callback…\n");
});
