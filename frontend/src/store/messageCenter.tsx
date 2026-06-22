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
  open: (clientId?: string) => void;
  close: () => void;
  toggle: () => void;
}

const MessageCenterContext = createContext<MessageCenterState>({
  isOpen: false,
  activeClientId: null,
  open: () => {},
  close: () => {},
  toggle: () => {},
});

export function MessageCenterProvider({ children }: { children: ComponentChildren }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);

  const open = useCallback((clientId?: string) => {
    setActiveClientId(clientId ?? null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Keep activeClientId in place until next open so re-open animation doesn't flash.
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  return (
    <MessageCenterContext.Provider value={{ isOpen, activeClientId, open, close, toggle }}>
      {children}
    </MessageCenterContext.Provider>
  );
}

export function useMessageCenter() {
  return useContext(MessageCenterContext);
}
