/**
 * Sync a tab (or similar segmented control) with a URL query param.
 * Uses preact-router `route(..., true)` so tab switches replace history entries.
 */

import { getCurrentUrl, route, useRouter } from "preact-router";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

export function currentSearchString(): string {
  if (typeof window !== "undefined" && window.location.search) {
    return window.location.search.replace(/^\?/, "");
  }
  const url = getCurrentUrl();
  if (url) return url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return "";
}

export function currentPathname(): string {
  if (typeof window !== "undefined" && window.location.pathname) {
    return window.location.pathname;
  }
  const url = getCurrentUrl();
  if (url) return url.split("?")[0].split("#")[0];
  return "";
}

export function parseQueryParam<T extends string>(
  search: string,
  param: string,
  valid: ReadonlySet<T>,
  fallback: T,
): T {
  const value = new URLSearchParams(search).get(param);
  if (value && valid.has(value as T)) return value as T;
  return fallback;
}

export function replaceQueryParams(update: (params: URLSearchParams) => void): void {
  const pathname = currentPathname();
  const params = new URLSearchParams(currentSearchString());
  update(params);
  const qs = params.toString();
  const next = qs ? `${pathname}?${qs}` : pathname;
  // Write the address bar first — this is what refresh reads.
  window.history.replaceState(null, "", next);
  route(next, true);
}

export function setQueryParam(name: string, value: string | null | undefined): void {
  replaceQueryParams((params) => {
    if (value == null || value === "") params.delete(name);
    else params.set(name, value);
  });
}

/** App-shell views: read/write ?tab= (or custom param) via preact-router. */
export function useUrlTab<T extends string>(
  validValues: readonly T[],
  defaultTab: T,
  param = "tab",
): [T, (next: T) => void] {
  const [{ url }] = useRouter();
  const search = currentSearchString() || (url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
  const valid = useMemo(() => new Set(validValues) as ReadonlySet<T>, [validValues]);

  const read = useCallback(
    () => parseQueryParam(search, param, valid, defaultTab),
    [search, param, valid, defaultTab],
  );

  const [tab, setTabState] = useState<T>(() => read());

  useEffect(() => {
    setTabState(read());
  }, [read]);

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      setQueryParam(param, next === defaultTab ? null : next);
    },
    [defaultTab, param],
  );

  return [tab, setTab];
}

/** Client portal — no preact-router; sync via location + popstate. */
export function usePortalUrlTab<T extends string>(
  validValues: readonly T[],
  defaultTab: T,
  param = "tab",
): [T, (next: T) => void] {
  const valid = useMemo(() => new Set(validValues) as ReadonlySet<T>, [validValues]);

  const read = useCallback(() => {
    return parseQueryParam(currentSearchString(), param, valid, defaultTab);
  }, [param, valid, defaultTab]);

  const [tab, setTabState] = useState<T>(() => read());

  useEffect(() => {
    const sync = () => setTabState(read());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [read]);

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      const pathname = window.location.pathname;
      const params = new URLSearchParams(window.location.search);
      if (next === defaultTab) params.delete(param);
      else params.set(param, next);
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [defaultTab, param],
  );

  return [tab, setTab];
}
