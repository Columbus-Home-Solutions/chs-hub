import type { RoutableProps } from "preact-router";
import { useAuth } from "../store/auth";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { go } from "../lib/nav";

export function Dashboard(_props: RoutableProps) {
  const { user } = useAuth();
  const name = user?.first_name || "there";
  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Welcome back, {name}</h1>
          <p class="view-subtitle">
            The CHS platform foundation is live. Clients and subcontractors are ready to use.
          </p>
        </div>
      </div>

      <div class="detail-grid">
        <Card title="Getting started">
          <p class="text--secondary" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
            This is the new internal app, running alongside the existing dashboard. The full
            dashboard home screen — KPIs, pipeline, and quick capture — is built in a later sprint.
          </p>
          <div class="flex gap-sm mt-md flex-wrap">
            <Button variant="primary" onClick={() => go("/clients")}>
              View clients
            </Button>
            <Button variant="secondary" onClick={() => go("/subcontractors")}>
              View subcontractors
            </Button>
            <Button variant="tertiary" onClick={() => go("/settings")}>
              Settings
            </Button>
          </div>
        </Card>

        <Card title="Status">
          <div class="kv">
            <div class="kv__row">
              <span class="kv__label">Clients</span>
              <span class="kv__value">Live</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Subcontractors</span>
              <span class="kv__value">Live</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Jobs / Estimates</span>
              <span class="kv__value text--muted">Coming soon</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
