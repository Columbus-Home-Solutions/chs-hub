import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { useToast } from "../../store/toast";
import { conversationIsUnread } from "@chs/shared/sms-conversation-state";
import type { ConversationStatePatch } from "@chs/shared/sms-conversation-state";

export function ConversationMenu({
  clientId,
  archived,
  flagged,
  pinned,
  unreadCount,
  unreadOverride,
  onChanged,
}: {
  clientId: string;
  archived: boolean;
  flagged: boolean;
  pinned: boolean;
  unreadCount: number;
  unreadOverride: boolean;
  onChanged: (patch: ConversationStatePatch) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const isUnread = conversationIsUnread({ unread_count: unreadCount, unread_override: unreadOverride });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = async (patch: ConversationStatePatch) => {
    setOpen(false);
    try {
      await api.patch(`/api/sms/conversations/${clientId}`, patch);
      onChanged(patch);
    } catch {
      toast.push("error", "Couldn’t update conversation");
    }
  };

  return (
    <div class="mc-menu" ref={wrapRef}>
      <button
        type="button"
        class="mc-icon-btn mc-menu__trigger"
        aria-label="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div class="mc-menu__dropdown" role="menu">
          <button
            type="button"
            class="mc-menu__item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              void apply({ archived: !archived });
            }}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
          <button
            type="button"
            class="mc-menu__item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              void apply({ flagged: !flagged });
            }}
          >
            {flagged ? "Unflag" : "Flag"}
          </button>
          <button
            type="button"
            class="mc-menu__item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              void apply({ pinned: !pinned });
            }}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
          {!isUnread && (
            <button
              type="button"
              class="mc-menu__item"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                void apply({ unread: true });
              }}
            >
              Mark unread
            </button>
          )}
        </div>
      )}
    </div>
  );
}
