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
import { CompanyDocs } from "./views/documents/CompanyDocs";
import { EstimateRequestPipeline } from "./views/estimating/EstimateRequestPipeline";
import { EstimateRequestForm } from "./views/estimating/EstimateRequestForm";
import { EstimateRequestDetail } from "./views/estimating/EstimateRequestDetail";
import { EstimateBuilder } from "./views/estimating/EstimateBuilder";
import { EstimateTemplates } from "./views/estimating/EstimateTemplates";
import { EstimateList } from "./views/estimating/EstimateList";
import { JobPipeline } from "./views/jobs/JobPipeline";
import { JobDetail } from "./views/jobs/JobDetail";
import { CompletionPackageReview } from "./views/jobs/CompletionPackageReview";
import { JobMap } from "./views/jobs/JobMap";
import { ScheduleCalendar } from "./views/jobs/ScheduleCalendar";
import { WarrantyCalls } from "./views/warranty/WarrantyCalls";
import { WarrantyCallDetail } from "./views/warranty/WarrantyCallDetail";
import { NotificationSettings } from "./views/notifications/NotificationSettings";
import { NotificationLogs } from "./views/notifications/NotificationLogs";
import { SocialMedia } from "./views/social/SocialMedia";
import { FinancialDashboard } from "./views/financial/FinancialDashboard";
import { PayerList } from "./views/payers/PayerList";
import { PayerDetail } from "./views/payers/PayerDetail";
import { PhotoLibrary } from "./views/photos/PhotoLibrary";
import { Placeholder } from "./views/Placeholder";
import { VoiceNoteCapture } from "./views/voice/VoiceNoteCapture";
import { UnmatchedVoiceNotes } from "./views/voice/UnmatchedVoiceNotes";

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
      <EstimateList path={`${BASE}/estimates`} />
      <EstimateRequestPipeline path={`${BASE}/estimating`} />
      <EstimateRequestForm path={`${BASE}/estimating/new`} />
      <EstimateTemplates path={`${BASE}/estimating/templates`} />
      <EstimateBuilder path={`${BASE}/estimating/:requestId/estimate`} />
      <EstimateRequestDetail path={`${BASE}/estimating/:id`} />
      <JobPipeline path={`${BASE}/jobs`} />
      <JobMap path={`${BASE}/jobs/map`} />
      <ScheduleCalendar path={`${BASE}/schedule`} />
      <WarrantyCalls path={`${BASE}/warranty-calls`} />
      <WarrantyCallDetail path={`${BASE}/warranty-calls/:id`} />
      <CompletionPackageReview path={`${BASE}/jobs/:id/completion-package`} />
      <JobDetail path={`${BASE}/jobs/:id`} />
      <FinancialDashboard path={`${BASE}/financial`} />
      <PayerList path={`${BASE}/payers`} />
      <PayerDetail path={`${BASE}/payers/:id`} />
      <PhotoLibrary path={`${BASE}/photos`} />
      <HubFiles path={`${BASE}/documents`} />
      <CompanyDocs path={`${BASE}/company-docs`} />
      <SocialMedia path={`${BASE}/social`} />
      <VoiceNoteCapture path={`${BASE}/voice-note`} />
      <UnmatchedVoiceNotes path={`${BASE}/voice-notes/unmatched`} />
      <NotFound default />
    </Router>
  );
}

function NotFound(_props: RoutableProps) {
  return <Placeholder title="Not Found" icon="🔍" />;
}
