import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

interface ModalProps {
  open: boolean;
  title?: ComponentChildren;
  onClose: () => void;
  footer?: ComponentChildren;
  children?: ComponentChildren;
  /** Dialog width tier — default 560px, wide 800px, full ~1400px for receipt review. */
  size?: "default" | "wide" | "full";
}

export function Modal({ open, title, onClose, footer, children, size = "default" }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sizeClass = size === "full" ? " modal--full" : size === "wide" ? " modal--wide" : "";

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div
        class={`modal${sizeClass}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
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
