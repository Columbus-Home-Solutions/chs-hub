import { useEffect, useRef, useState } from "preact/hooks";
import { route } from "preact-router";
import { api } from "../../api";
import { formatDateTime } from "../../lib/format";
import type { InboxNotification } from "../../types";

interface InboxResponse {
  unread_count: number;
  notifications: InboxNotification[];
}

const POLL_MS = 30_000;

/**
 * In-app notification bell. Polls /api/notifications/inbox on an interval
 * (no WebSocket — polling matches the spec's allowance and Workers' model),
 * renders an unread-count badge, and opens a dropdown of recent in_app
 * notifications. Clicking an item marks it read and navigates to its record.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<InboxNotification[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await api.get<InboxResponse>("/api/notifications/inbox");
      setUnread(r.unread_count);
      setItems(r.notifications);
    } catch {
      /* unauthenticated / offline — leave the bell quiet */
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const openItem = async (n: InboxNotification) => {
    if (!n.is_read) {
      try {
        await api.put(`/api/notifications/${n.id}/read`, {});
      } catch {
        /* best-effort */
      }
    }
    setOpen(false);
    void load();
    if (n.link_path) route(n.link_path);
  };

  const markAll = async () => {
    try {
      await api.put("/api/notifications/read-all", {});
    } catch {
      /* best-effort */
    }
    void load();
  };

  return (
    <div class="notif-bell" ref={ref}>
      <button
        class="topnav__bell"
        aria-label="Notifications"
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {unread > 0 && <span class="topnav__bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div class="notif-dropdown" role="menu">
          <div class="notif-dropdown__head">
            <span>Notifications</span>
            {unread > 0 && (
              <button class="notif-dropdown__mark" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          <div class="notif-dropdown__list">
            {items.length === 0 ? (
              <div class="notif-dropdown__empty">You're all caught up.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  class={`notif-item${n.is_read ? "" : " notif-item--unread"}`}
                  onClick={() => openItem(n)}
                >
                  <div class="notif-item__body">{n.body}</div>
                  <div class="notif-item__meta">{formatDateTime(n.created_at)}</div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
