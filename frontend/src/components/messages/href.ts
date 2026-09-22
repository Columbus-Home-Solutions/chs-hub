import { to } from "../../lib/nav";
import type { InboxTab } from "./types";

export function messagesHref(opts: {
  clientId?: string | null;
  tab?: InboxTab;
  noteId?: string | null;
} = {}): string {
  const params = new URLSearchParams();
  if (opts.tab === "unassigned" || opts.noteId) params.set("tab", "unassigned");
  if (opts.clientId) params.set("client", opts.clientId);
  if (opts.noteId) params.set("note", opts.noteId);
  const qs = params.toString();
  return to("/people/messages") + (qs ? `?${qs}` : "");
}

export function parseMessagesSearch(search: string): {
  tab: InboxTab;
  clientId: string | null;
  noteId: string | null;
} {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const noteId = params.get("note");
  const clientId = params.get("client");
  const tab: InboxTab =
    params.get("tab") === "unassigned" || noteId ? "unassigned" : "clients";
  return { tab, clientId, noteId };
}
