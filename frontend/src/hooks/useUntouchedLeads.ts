import { useEffect, useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { api } from "../api";
import { untouchedIsAmber } from "../lib/untouched-leads";

export interface UntouchedLeads {
  count: number;
  amber: boolean;
}

const listeners = new Set<(snap: UntouchedLeads) => void>();
let current: UntouchedLeads = { count: 0, amber: false };
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.get<{ count: number; oldest_created_at: string | null }>(
        "/api/estimate-requests/untouched",
      );
      const next: UntouchedLeads = {
        count: res.count ?? 0,
        amber: untouchedIsAmber(res.oldest_created_at),
      };
      current = next;
      listeners.forEach((listen) => listen(next));
    } catch {
      /* Keep the last count if a refresh fails. */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function onVisible(): void {
  if (document.visibilityState === "visible") void refresh();
}

function ensureTimer(): void {
  if (timer != null) return;
  timer = setInterval(() => void refresh(), 60_000);
  document.addEventListener("visibilitychange", onVisible);
}

function stopTimer(): void {
  if (timer != null) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

/** Shared across nav surfaces so the 60s poll runs once. */
export function useUntouchedLeads(): UntouchedLeads {
  const [state, setState] = useState(current);
  const [{ url }] = useRouter();

  useEffect(() => {
    listeners.add(setState);
    setState(current);
    if (listeners.size === 1) ensureTimer();
    return () => {
      listeners.delete(setState);
      if (listeners.size === 0) stopTimer();
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [url]);

  return state;
}
