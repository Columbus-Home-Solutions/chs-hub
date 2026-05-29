import type { ComponentChildren } from "preact";

type Tone = "neutral" | "success" | "warning" | "error" | "info" | "brand";

interface BadgeProps {
  /** A semantic tone, or a raw status key (e.g. "in_progress") for status colors. */
  tone?: Tone;
  status?: string;
  children: ComponentChildren;
}

export function Badge({ tone, status, children }: BadgeProps) {
  const modifier = status ? status : (tone ?? "neutral");
  return <span class={`badge badge--${modifier}`}>{children}</span>;
}
