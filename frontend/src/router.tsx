import Router from "preact-router";
import type { RoutableProps } from "preact-router";
import { BASE } from "./lib/nav";
import { Dashboard } from "./views/Dashboard";
import { ClientList } from "./views/clients/ClientList";
import { ClientDetail } from "./views/clients/ClientDetail";
import { SubcontractorList } from "./views/subcontractors/SubcontractorList";
import { Settings } from "./views/settings/Settings";
import { Placeholder } from "./views/Placeholder";

export function AppRouter() {
  return (
    <Router>
      <Dashboard path={BASE} />
      <Dashboard path={`${BASE}/`} />
      <ClientList path={`${BASE}/clients`} />
      <ClientDetail path={`${BASE}/clients/:id`} />
      <SubcontractorList path={`${BASE}/subcontractors`} />
      <Settings path={`${BASE}/settings`} />
      <Placeholder path={`${BASE}/jobs`} title="Jobs" />
      <Placeholder path={`${BASE}/estimates`} title="Estimates" />
      <Placeholder path={`${BASE}/financial`} title="Financial" />
      <Placeholder path={`${BASE}/photos`} title="Photos" />
      <Placeholder path={`${BASE}/documents`} title="Documents" />
      <Placeholder path={`${BASE}/social`} title="Social" />
      <NotFound default />
    </Router>
  );
}

function NotFound(_props: RoutableProps) {
  return <Placeholder title="Not Found" icon="🔍" />;
}
