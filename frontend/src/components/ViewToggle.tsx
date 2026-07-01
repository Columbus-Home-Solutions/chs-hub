export type ViewMode = "list" | "kanban" | "health";

interface Props {
  value: ViewMode;
  onChange: (view: ViewMode) => void;
  /** Set to true to show the Health pill (Jobs page only). */
  showHealth?: boolean;
}

/** Kanban / list / health toggle — uses segmented control styling from the design system. */
export function ViewToggle({ value, onChange, showHealth = false }: Props) {
  return (
    <div class="segmented view-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        class={`segmented__btn${value === "list" ? " segmented__btn--active" : ""}`}
        onClick={() => onChange("list")}
      >
        ≡ List
      </button>
      <button
        type="button"
        class={`segmented__btn${value === "kanban" ? " segmented__btn--active" : ""}`}
        onClick={() => onChange("kanban")}
      >
        ▦ Kanban
      </button>
      {showHealth && (
        <button
          type="button"
          class={`segmented__btn${value === "health" ? " segmented__btn--active" : ""}`}
          onClick={() => onChange("health")}
        >
          ♥ Health
        </button>
      )}
    </div>
  );
}
