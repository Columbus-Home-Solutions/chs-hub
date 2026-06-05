/** Read URL search params from the current location (client-only). */
export function readSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function searchParam(key: string): string | null {
  return readSearchParams().get(key);
}
