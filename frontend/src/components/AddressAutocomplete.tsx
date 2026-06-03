import {
  useAddressAutocomplete,
  type AddressResult,
  type Suggestion,
} from "../hooks/useAddressAutocomplete";

interface Props {
  onSelect: (result: AddressResult) => void;
  initialValue?: string;
  label?: string;
  required?: boolean;
  error?: boolean;
  onInputChange?: (value: string) => void;
}

export function AddressAutocomplete({
  onSelect,
  initialValue = "",
  label,
  required,
  error,
  onInputChange,
}: Props) {
  const {
    inputValue,
    suggestions,
    showDropdown,
    activeSuggestionIndex,
    selectSuggestion,
    isLoading,
    handleInput,
    handleKeyDown,
    handleFocus,
    handleBlur,
    mapsReady,
  } = useAddressAutocomplete(onSelect, initialValue, onInputChange);

  return (
    <div class="address-autocomplete">
      {label && (
        <label class="form-label">
          {label}
          {required && <span class="form-label__req">*</span>}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <input
          type="text"
          class={`form-input${error ? " form-input--error" : ""}`}
          value={inputValue}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={mapsReady ? "Start typing an address…" : "Enter address"}
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
        />
        {isLoading && (
          <span
            style={{
              position: "absolute",
              right: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--color-text-muted)",
              fontSize: "0.75rem",
            }}
          >
            …
          </span>
        )}
        {showDropdown && suggestions.length > 0 && (
          <ul
            role="listbox"
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              zIndex: 1000,
              margin: "2px 0 0",
              padding: 0,
              listStyle: "none",
              background: "var(--color-surface-elevated, #1a1f2e)",
              backdropFilter: "none",
              opacity: 1,
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
              maxHeight: "240px",
              overflowY: "auto",
            }}
          >
            {suggestions.map((s: Suggestion, i: number) => (
              <li
                key={s.placeId}
                role="option"
                aria-selected={i === activeSuggestionIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void selectSuggestion(s);
                }}
                style={{
                  padding: "0.625rem 0.875rem",
                  cursor: "pointer",
                  borderBottom:
                    i < suggestions.length - 1 ? "1px solid var(--color-border-subtle)" : "none",
                  background:
                    i === activeSuggestionIndex ? "var(--color-surface-hover)" : "transparent",
                }}
              >
                <div
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--color-text-primary)",
                    fontWeight: 500,
                  }}
                >
                  {s.mainText}
                </div>
                {s.secondaryText && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-text-muted)",
                      marginTop: "1px",
                    }}
                  >
                    {s.secondaryText}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
