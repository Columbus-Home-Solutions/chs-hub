export function relativeTimestamp(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }
  if (diffDays < 365) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function segmentCount(chars: number): string {
  if (chars <= 160) return `${chars} / 160`;
  const segs = Math.ceil(chars / 153);
  return `${chars} chars — ${segs} segments`;
}

export function conversationsUrl(archived: boolean): string {
  return archived ? "/api/sms/conversations?archived=1" : "/api/sms/conversations";
}
