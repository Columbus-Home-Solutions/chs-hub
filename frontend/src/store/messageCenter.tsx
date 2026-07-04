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

interface MessageCenterState {
  isOpen: boolean;
  activeClientId: string | null;
  /** Set when openCompose() was called; MessageCenter reads and clears this on mount. */
  pendingCompose: boolean;
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

  const close = useCallback(() => {
    setIsOpen(false);
    // Keep activeClientId in place until next open so re-open animation doesn't flash.
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  return (
    <MessageCenterContext.Provider
      value={{ isOpen, activeClientId, pendingCompose, open, openCompose, clearPendingCompose, close, toggle }}
    >
      {children}
    </MessageCenterContext.Provider>
  );
}

export function useMessageCenter() {
  return useContext(MessageCenterContext);
}
