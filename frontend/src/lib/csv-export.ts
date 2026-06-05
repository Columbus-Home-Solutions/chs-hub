/** Client-side CSV download from an array of row objects. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[], columns: { key: string; label: string }[]): void {
  if (rows.length === 0) return;
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => esc(row[c.key])).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
