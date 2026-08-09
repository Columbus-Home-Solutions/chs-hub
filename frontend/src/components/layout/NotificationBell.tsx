import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { route } from "preact-router";
import { api } from "../../api";
import { formatDateTime } from "../../lib/format";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { InboxNotification } from "../../types";

interface InboxResponse {
  unread_count: number;
  notifications: InboxNotification[];
}

const POLL_MS = 30_000;

/**
 * In-app notification bell. Polls /api/notifications/inbox on an interval,
 * renders an unread-count badge, and opens the inbox:
 * - desktop: fixed dropdown anchored under the bell
 * - mobile: full-screen panel (topnav overflow used to clip the old absolute dropdown)
 */
export function NotificationBell() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [desktopPos, setDesktopPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

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

  // Bottom nav (and other shells) ask overlays to dismiss via this event.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("chs:close-overlays", close);
    return () => window.removeEventListener("chs:close-overlays", close);
  }, []);

  // Desktop: anchor the fixed dropdown under the bell; re-measure on resize/scroll.
  useLayoutEffect(() => {
    if (!open || isMobile) {
      setDesktopPos(null);
      return;
    }
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setDesktopPos({
        top: Math.round(r.bottom + 8),
        right: Math.round(window.innerWidth - r.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    // Capture scroll from any scrollport (content area, etc.).
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, isMobile]);

  // Desktop: close dropdown on outside click.
  useEffect(() => {
    if (!open || isMobile) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, isMobile]);

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

  const clearAll = async () => {
    const n = unread > 0 ? unread : items.filter((i) => !i.is_read).length;
    const label = n > 0 ? `Clear all ${n} notifications?` : "Clear all notifications?";
    if (!confirm(label)) return;
    try {
      await api.put("/api/notifications/read-all", {});
      setUnread(0);
      setItems([]);
    } catch {
      void load();
      return;
    }
  };

  const list = (
    <div class={isMobile ? "notif-panel__list" : "notif-dropdown__list"}>
      {items.length === 0 ? (
        <div class={isMobile ? "notif-panel__empty" : "notif-dropdown__empty"}>
          You're all caught up.
        </div>
      ) : (
        items.map((n) => (
          <button
            key={n.id}
            type="button"
            class={`notif-item${n.is_read ? "" : " notif-item--unread"}`}
            onClick={() => openItem(n)}
          >
            <div class="notif-item__body">{n.body}</div>
            <div class="notif-item__meta">{formatDateTime(n.created_at)}</div>
          </button>
        ))
      )}
    </div>
  );

  return (
    <div class="notif-bell" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        class="topnav__bell"
        aria-label="Notifications"
        title="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {unread > 0 && <span class="topnav__bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && !isMobile && desktopPos && (
        <div
          class="notif-dropdown"
          role="menu"
          style={{ top: `${desktopPos.top}px`, right: `${desktopPos.right}px` }}
        >
          <div class="notif-dropdown__head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button class="notif-dropdown__clear" type="button" onClick={() => void clearAll()}>
                Clear All
              </button>
            )}
          </div>
          {list}
        </div>
      )}

      {open && isMobile && (
        <div class="notif-panel" role="dialog" aria-label="Notifications">
          <div class="notif-panel__bar">
            <button
              type="button"
              class="notif-panel__back"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
            >
              ←
            </button>
            <span class="notif-panel__title">Notifications</span>
            {items.length > 0 ? (
              <button
                class="notif-panel__clear"
                type="button"
                onClick={() => void clearAll()}
              >
                Clear
              </button>
            ) : (
              <span class="notif-panel__clear-spacer" />
            )}
          </div>
          {list}
        </div>
      )}
    </div>
  );
}
