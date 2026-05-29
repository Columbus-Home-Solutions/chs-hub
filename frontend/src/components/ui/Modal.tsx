import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

interface ModalProps {
  open: boolean;
  title?: ComponentChildren;
  onClose: () => void;
  footer?: ComponentChildren;
  children?: ComponentChildren;
}

export function Modal({ open, title, onClose, footer, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal__header">
          <span class="modal__title">{title}</span>
          <button class="modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div class="modal__body">{children}</div>
        {footer && <div class="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
