import { useState, useEffect, useCallback } from "preact/hooks";
import { api, ApiError } from "../api";

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Data-fetching hook with loading/error/refetch. Pass null to skip fetching. */
export function useApi<T>(url: string | null): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(url != null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (url == null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(url));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, loading, error, refetch: run };
}
