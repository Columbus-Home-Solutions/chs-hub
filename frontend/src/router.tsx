import Router from "preact-router";
import type { RoutableProps } from "preact-router";
import { BASE } from "./lib/nav";
import { Dashboard } from "./views/Dashboard";
import { ClientList } from "./views/clients/ClientList";
import { ClientDetail } from "./views/clients/ClientDetail";
import { SubcontractorList } from "./views/subcontractors/SubcontractorList";
import { SubcontractorDetail } from "./views/subcontractors/SubcontractorDetail";
import { Settings } from "./views/settings/Settings";
import { Integrations } from "./views/settings/Integrations";
import { DocumentTemplates } from "./views/settings/DocumentTemplates";
import { HubFiles } from "./views/documents/HubFiles";
import { EstimateRequestPipeline } from "./views/estimating/EstimateRequestPipeline";
import { EstimateRequestForm } from "./views/estimating/EstimateRequestForm";
import { EstimateRequestDetail } from "./views/estimating/EstimateRequestDetail";
import { EstimateBuilder } from "./views/estimating/EstimateBuilder";
import { EstimateTemplates } from "./views/estimating/EstimateTemplates";
import { JobPipeline } from "./views/jobs/JobPipeline";
import { JobDetail } from "./views/jobs/JobDetail";
import { ScheduleCalendar } from "./views/jobs/ScheduleCalendar";
import { NotificationSettings } from "./views/notifications/NotificationSettings";
import { NotificationLogs } from "./views/notifications/NotificationLogs";
import { SocialMedia } from "./views/social/SocialMedia";
import { Placeholder } from "./views/Placeholder";

export function AppRouter() {
  return (
    <Router>
      <Dashboard path={BASE} />
      <Dashboard path={`${BASE}/`} />
      <ClientList path={`${BASE}/clients`} />
      <ClientDetail path={`${BASE}/clients/:id`} />
      <SubcontractorList path={`${BASE}/subcontractors`} />
      <SubcontractorDetail path={`${BASE}/subcontractors/:id`} />
      <Settings path={`${BASE}/settings`} />
      <Integrations path={`${BASE}/settings/integrations`} />
      <DocumentTemplates path={`${BASE}/settings/documents`} />
      <NotificationSettings path={`${BASE}/settings/notifications`} />
      <NotificationLogs path={`${BASE}/settings/notifications/logs`} />
      <EstimateRequestPipeline path={`${BASE}/estimating`} />
      <EstimateRequestForm path={`${BASE}/estimating/new`} />
      <EstimateTemplates path={`${BASE}/estimating/templates`} />
      <EstimateBuilder path={`${BASE}/estimating/:requestId/estimate`} />
      <EstimateRequestDetail path={`${BASE}/estimating/:id`} />
      <JobPipeline path={`${BASE}/jobs`} />
      <ScheduleCalendar path={`${BASE}/schedule`} />
      <JobDetail path={`${BASE}/jobs/:id`} />
      <Placeholder path={`${BASE}/financial`} title="Financial" />
      <Placeholder path={`${BASE}/photos`} title="Photos" />
      <HubFiles path={`${BASE}/documents`} />
      <SocialMedia path={`${BASE}/social`} />
      <NotFound default />
    </Router>
  );
}

function NotFound(_props: RoutableProps) {
  return <Placeholder title="Not Found" icon="🔍" />;
}
