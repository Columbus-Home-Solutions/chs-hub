import type { ComponentChildren } from "preact";

interface CardProps {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  hover?: boolean;
  children?: ComponentChildren;
  bodyClass?: string;
}

export function Card({ title, actions, hover, children, bodyClass }: CardProps) {
  return (
    <div class={`card${hover ? " card--hover" : ""}`}>
      {(title || actions) && (
        <div class="card__header">
          <span class="card__title">{title}</span>
          {actions && <div class="flex gap-sm items-center">{actions}</div>}
        </div>
      )}
      <div class={`card__body${bodyClass ? " " + bodyClass : ""}`}>{children}</div>
    </div>
  );
}
