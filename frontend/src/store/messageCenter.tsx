/**
 * Message Center global state (Sprint 24).
 *
 * Provides a context that lets any component open/close the slide-out panel
 * and optionally jump to a specific client's thread. The panel is rendered
 * once at the app-shell level so it's available on every screen.
 */
import { createContext } from "preact";
import { useState, useContext, useCallback } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  parseDismissedIds,
  serializeDismissedIds,
  UNASSIGNED_VOICE_NOTES_DISMISS_KEY,
} from "@chs/shared/message-center-unassigned";

function loadDismissed(): Set<string> {
  try {
    return parseDismissedIds(localStorage.getItem(UNASSIGNED_VOICE_NOTES_DISMISS_KEY));
  } catch {
    return new Set();
  }
}

function persistDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(UNASSIGNED_VOICE_NOTES_DISMISS_KEY, serializeDismissedIds(ids));
  } catch {
    /* private mode / quota — keep in-memory only */
  }
}

interface MessageCenterState {
  isOpen: boolean;
  activeClientId: string | null;
  /** Set when openCompose() was called; MessageCenter reads and clears this on mount. */
  pendingCompose: boolean;
  dismissedUnassignedIds: Set<string>;
  dismissUnassigned: (id: string) => void;
  open: (clientId?: string) => void;
  /** Open the panel directly to the New Message compose screen. */
  openCompose: () => void;
  clearPendingCompose: () => void;
  close: () => void;
  toggle: () => void;
}

const MessageCenterContext = createContext<MessageCenterState>({
  isOpen: false,
  activeClientId: null,
  pendingCompose: false,
  dismissedUnassignedIds: new Set(),
  dismissUnassigned: () => {},
  open: () => {},
  openCompose: () => {},
  clearPendingCompose: () => {},
  close: () => {},
  toggle: () => {},
});

export function MessageCenterProvider({ children }: { children: ComponentChildren }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const [pendingCompose, setPendingCompose] = useState(false);
  const [dismissedUnassignedIds, setDismissedUnassignedIds] = useState<Set<string>>(loadDismissed);

  const open = useCallback((clientId?: string) => {
    setActiveClientId(clientId ?? null);
    setPendingCompose(false);
    setIsOpen(true);
  }, []);

  const openCompose = useCallback(() => {
    setActiveClientId(null);
    setPendingCompose(true);
    setIsOpen(true);
  }, []);

  const clearPendingCompose = useCallback(() => setPendingCompose(false), []);

  const dismissUnassigned = useCallback((id: string) => {
    setDismissedUnassignedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persistDismissed(next);
      return next;
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Keep activeClientId in place until next open so re-open animation doesn't flash.
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  return (
    <MessageCenterContext.Provider
      value={{
        isOpen,
        activeClientId,
        pendingCompose,
        dismissedUnassignedIds,
        dismissUnassigned,
        open,
        openCompose,
        clearPendingCompose,
        close,
        toggle,
      }}
    >
      {children}
    </MessageCenterContext.Provider>
  );
}

export function useMessageCenter() {
  return useContext(MessageCenterContext);
}
