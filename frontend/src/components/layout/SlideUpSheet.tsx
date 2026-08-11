import type { ComponentChildren } from "preact";

/**
 * Shared slide-up sheet chrome (backdrop + handle + title).
 * Reuses `.more-nav-sheet*` styles from the mobile/tablet nav More menu.
 */
export function SlideUpSheet({
  open,
  onClose,
  title,
  ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  ariaLabel?: string;
  children: ComponentChildren;
}) {
  return (
    <>
      <div
        class={`more-nav-sheet__backdrop${open ? " more-nav-sheet__backdrop--open" : ""}`}
        onClick={open ? onClose : undefined}
        role="presentation"
        aria-hidden={!open}
      />
      <div
        class={`more-nav-sheet${open ? " more-nav-sheet--open" : ""}`}
        role="dialog"
        aria-label={ariaLabel ?? title}
        aria-hidden={!open}
      >
        <div class="more-nav-sheet__handle" />
        <h2 class="more-nav-sheet__title">{title}</h2>
        {children}
      </div>
    </>
  );
}
