import type { ComponentChildren, JSX } from "preact";

type Variant = "primary" | "secondary" | "tertiary" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends Omit<JSX.IntrinsicElements["button"], "size"> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  children?: ComponentChildren;
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  children,
  class: className,
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    `btn--${variant}`,
    size !== "md" ? `btn--${size}` : "",
    block ? "btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button class={classes} {...rest}>
      {children}
    </button>
  );
}
