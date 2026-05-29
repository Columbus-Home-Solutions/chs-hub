import type { RoutableProps } from "preact-router";

interface PlaceholderProps extends RoutableProps {
  title: string;
  icon?: string;
}

export function Placeholder({ title, icon = "🚧" }: PlaceholderProps) {
  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">{title}</h1>
          <p class="view-subtitle">This module ships in a later sprint.</p>
        </div>
      </div>
      <div class="empty-state">
        <div class="empty-state__icon">{icon}</div>
        <div class="empty-state__title">Coming soon</div>
        <div>The {title} module isn't built yet.</div>
      </div>
    </div>
  );
}
