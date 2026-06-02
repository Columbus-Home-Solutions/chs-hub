import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encryptToken,
  decryptToken,
  getValidAccessToken,
  QboReconnectError,
} from "../src/lib/qbo-auth.js";
import type { Env } from "../src/env.js";

/**
 * Hand-written D1 stub for the QBO connection row. It only understands the
 * three statements qbo-auth issues against integration_connections
 * (SELECT load, INSERT…ON CONFLICT writeTokens, UPDATE setConnectionError),
 * which is enough to prove the token lifecycle + atomic rotation.
 */
function makeEnv(initial: {
  status: string;
  encAccess: string | null;
  encRefresh: string | null;
  expiry: string | null;
}): { env: Env; state: typeof initial } {
  const state = { ...initial, account_id: "REALM-1", configuration: JSON.stringify({ environment: "sandbox" }) } as any;

  const db = {
    prepare(sql: string) {
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes("SELECT") && sql.includes("integration_connections")) {
            return {
              id: "c1",
              status: state.status,
              access_token: state.encAccess,
              refresh_token: state.encRefresh,
              token_expiry: state.expiry,
              account_id: state.account_id,
              configuration: state.configuration,
              last_sync: null,
              last_error: null,
            };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO integration_connections")) {
            // bind order: uuid, service, status, encAccess, encRefresh, expiry, ...
            state.status = this._args[2] as string;
            state.encAccess = this._args[3] as string;
            state.encRefresh = this._args[4] as string;
            state.expiry = this._args[5] as string;
          } else if (sql.includes("status = 'error'")) {
            state.status = "error";
          }
          return { success: true };
        },
      };
    },
  };

  const env = { QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key", QBO_CLIENT_ID: "id", QBO_CLIENT_SECRET: "secret", DB: db } as unknown as Env;
  return { env, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getValidAccessToken — proactive refresh + ⭐ atomic rotation", () => {
  it("refreshes an expired token and PERSISTS the rotated refresh token", async () => {
    const { env, state } = makeEnv({
      status: "connected",
      encAccess: await encryptToken({ QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as Env, "old-access"),
      encRefresh: await encryptToken({ QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as Env, "refresh-v1"),
      expiry: new Date(Date.now() - 60_000).toISOString(), // already expired
    });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "refresh-v2-ROTATED", expires_in: 3600 }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await getValidAccessToken(env);
    expect(token).toBe("new-access");
    // The NEW refresh token must be persisted (the documented #1 failure mode is
    // not persisting it). Decrypt the stored value and confirm it rotated.
    expect(await decryptToken(env, state.encRefresh)).toBe("refresh-v2-ROTATED");
    expect(await decryptToken(env, state.encAccess)).toBe("new-access");
  });

  it("does NOT refresh a token that is still comfortably valid", async () => {
    const { env } = makeEnv({
      status: "connected",
      encAccess: await encryptToken({ QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as Env, "still-good"),
      encRefresh: await encryptToken({ QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as Env, "refresh-v1"),
      expiry: new Date(Date.now() + 60 * 60_000).toISOString(), // 1h out
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const token = await getValidAccessToken(env);
    expect(token).toBe("still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a Reconnect error (no silent retry) when the refresh token is revoked", async () => {
    const { env, state } = makeEnv({
      status: "connected",
      encAccess: null,
      encRefresh: await encryptToken({ QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as Env, "revoked-refresh"),
      expiry: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getValidAccessToken(env)).rejects.toBeInstanceOf(QboReconnectError);
    expect(state.status).toBe("error");
  });
});
