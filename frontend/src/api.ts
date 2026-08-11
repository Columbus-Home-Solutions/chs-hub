/**
 * API client — thin fetch wrapper. Normalizes the platform's error response
 * shape ({ error, details? }) into a thrown ApiError, and returns parsed JSON
 * on success.
 *
 * Cloudflare Access sits in front of the dashboard host. When the Access
 * session is missing/expired, `/api/*` returns a 302 to cloudflareaccess.com.
 * A normal `fetch` follows that cross-origin redirect and the browser surfaces
 * a opaque TypeError ("Failed to fetch") — which is what Jobs Pipeline was
 * showing. We use `redirect: "manual"` so we can detect that and throw a clear
 * session error instead.
 */

export class ApiError extends Error {
  status: number;
  details?: string;
  body: unknown;
  constructor(message: string, status: number, details?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.body = body;
  }
}

const SESSION_EXPIRED_MSG =
  "Session expired — reload the page to sign in again";

function isAccessRedirect(res: Response): boolean {
  if (res.type === "opaqueredirect") return true;
  if (res.status < 300 || res.status >= 400) return false;
  const loc = res.headers.get("Location") ?? "";
  return (
    loc.includes("cloudflareaccess.com") ||
    loc.includes("/cdn-cgi/access/") ||
    // Same-host Access bounce with relative redirect_url only
    loc.includes("redirect_url=")
  );
}

async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "manual",
    });
  } catch (err) {
    // Network down, CORS after a followed redirect (older callers), offline, etc.
    if (err instanceof TypeError) {
      throw new ApiError(
        "Network error — check your connection, or reload to re-authenticate",
        0,
        (err as Error).message,
      );
    }
    throw err;
  }

  if (isAccessRedirect(res)) {
    throw new ApiError(SESSION_EXPIRED_MSG, 401);
  }

  // Other redirects are unexpected for JSON APIs — don't silently follow.
  if (res.status >= 300 && res.status < 400) {
    throw new ApiError(
      `Unexpected redirect (${res.status})`,
      res.status,
      res.headers.get("Location") ?? undefined,
    );
  }

  return res;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. HTML error page) — keep raw text in details.
      if (!res.ok) {
        throw new ApiError(
          `Request failed: ${res.status}`,
          res.status,
          text.slice(0, 200),
        );
      }
      throw new ApiError("Invalid JSON response", res.status, text.slice(0, 200));
    }
  }
  if (!res.ok) {
    const msg =
      (data && (data.details || data.message || data.error)) || `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, data?.details ?? data?.message, data);
  }
  return data as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const api = {
  async get<T>(url: string): Promise<T> {
    return parse<T>(await rawFetch(url));
  },
  async post<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await rawFetch(url, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body ?? {}),
      }),
    );
  },
  async put<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await rawFetch(url, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(body ?? {}),
      }),
    );
  },
  async patch<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await rawFetch(url, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body ?? {}),
      }),
    );
  },
  async del<T>(url: string): Promise<T> {
    return parse<T>(await rawFetch(url, { method: "DELETE" }));
  },
};
