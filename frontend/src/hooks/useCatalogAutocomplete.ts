import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { CatalogItem } from "../views/settings/CatalogTab";

/** Debounced search against GET /api/catalog?q= (200ms, min 1 character). */
export function useCatalogAutocomplete(query: string) {
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setLoading(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      const reqId = ++reqIdRef.current;
      setLoading(true);
      void api
        .get<{ items: CatalogItem[] }>(`/api/catalog?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (reqId === reqIdRef.current) setResults(r.items);
        })
        .catch(() => {
          if (reqId === reqIdRef.current) setResults([]);
        })
        .finally(() => {
          if (reqId === reqIdRef.current) setLoading(false);
        });
    }, 200);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  return { results, loading };
}
