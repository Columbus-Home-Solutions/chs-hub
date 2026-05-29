import type { JSX } from "preact";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<JSX.HTMLAttributes<HTMLSelectElement>, "onChange"> {
  options: SelectOption[];
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
}

export function Select({ options, value, placeholder, onChange, class: className, ...rest }: SelectProps) {
  return (
    <select
      class={`form-select${className ? " " + className : ""}`}
      value={value}
      onChange={(e) => onChange?.((e.target as HTMLSelectElement).value)}
      {...rest}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
