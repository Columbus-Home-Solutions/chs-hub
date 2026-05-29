import type { ComponentChildren, JSX } from "preact";

interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  /** Render a custom control (e.g. Select, textarea). If omitted, an input is rendered. */
  children?: ComponentChildren;
  inputProps?: JSX.IntrinsicElements["input"];
}

export function FormField({ label, required, error, hint, children, inputProps }: FormFieldProps) {
  return (
    <div class="form-group">
      <label class="form-label">
        {label}
        {required && <span class="form-label__req">*</span>}
      </label>
      {children ?? (
        <input class={`form-input${error ? " form-input--error" : ""}`} {...inputProps} />
      )}
      {hint && !error && <div class="form-hint">{hint}</div>}
      {error && <div class="form-error">{error}</div>}
    </div>
  );
}
