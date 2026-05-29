import { useToast } from "../../store/toast";

/** Renders the active toast stack. Mount once near the app root. */
export function ToastViewport() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div class="toast-container">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
