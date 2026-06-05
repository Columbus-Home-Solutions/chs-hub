import { useState } from "preact/hooks";

export type SortDir = "asc" | "desc";

export function useClientSort<T>(
  rows: T[],
  defaultKey: keyof T & string,
  defaultDir: SortDir = "desc",
) {
  const [sortKey, setSortKey] = useState<string>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const toggle = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey as keyof T];
    const bv = b[sortKey as keyof T];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === "asc" ? cmp : -cmp;
  });

  return { sorted, sortKey, sortDir, toggle };
}

export function truncate(s: string | null | undefined, max = 40): string {
  const t = s ?? "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function loadStoredView(key: string): "list" | "kanban" {
  try {
    const v = localStorage.getItem(key);
    if (v === "list" || v === "kanban") return v;
  } catch {
    /* ignore */
  }
  return "kanban";
}

export function storeView(key: string, view: "list" | "kanban"): void {
  try {
    localStorage.setItem(key, view);
  } catch {
    /* ignore */
  }
}
