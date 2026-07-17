/**
 * Sync a tab (or similar segmented control) with a URL query param.
 * Uses preact-router `route(..., true)` so tab switches replace history entries.
 */

import { getCurrentUrl, route, useRouter } from "preact-router";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

export function currentSearchString(): string {
  const url = getCurrentUrl();
  if (url) return url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return window.location.search.replace(/^\?/, "");
}

export function currentPathname(): string {
  const url = getCurrentUrl();
  if (url) return url.split("?")[0].split("#")[0];
  return window.location.pathname;
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
  route(next, true);
  // Always sync the address bar — preact-router can return true without updating
  // ?tab= on same-path navigations, which breaks refresh persistence.
  window.history.replaceState(null, "", next);
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
  const search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const valid = useMemo(() => new Set(validValues) as ReadonlySet<T>, [validValues]);

  const read = useCallback(
    () => parseQueryParam(search, param, valid, defaultTab),
    [search, param, valid, defaultTab],
  );

  const [tab, setTabState] = useState<T>(read);

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

  const [tab, setTabState] = useState<T>(read);

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
