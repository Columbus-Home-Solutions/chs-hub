/**
 * API client — thin fetch wrapper. Normalizes the platform's error response
 * shape ({ error, details? }) into a thrown ApiError, and returns parsed JSON
 * on success.
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

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, data?.details, data);
  }
  return data as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const api = {
  async get<T>(url: string): Promise<T> {
    return parse<T>(await fetch(url, { headers: { Accept: "application/json" } }));
  },
  async post<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) }),
    );
  },
  async put<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await fetch(url, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) }),
    );
  },
  async patch<T>(url: string, body?: unknown): Promise<T> {
    return parse<T>(
      await fetch(url, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) }),
    );
  },
  async del<T>(url: string): Promise<T> {
    return parse<T>(await fetch(url, { method: "DELETE", headers: { Accept: "application/json" } }));
  },
};
