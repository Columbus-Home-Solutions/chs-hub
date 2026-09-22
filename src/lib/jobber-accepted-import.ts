/**
 * Helpers for recreating a Jobber-accepted quote as a real CHS estimate.
 * Conversion itself still goes through convertQuoteToJob — this only gets a
 * standalone New Estimate onto that path (backing estimate_request) and
 * records an honest import paper trail.
 */

import type { Env } from "../env.js";
import { JOBBER_ACCEPTED_IMPORT } from "../../shared/jobber-accepted-import.js";

export {
  JOBBER_ACCEPTED_IMPORT,
  JOBBER_IMPORT,
  IMPORTED_SIGNED_BADGE,
  isJobberAcceptedImport,
  shouldSkipBoldSignForEstimate,
} from "../../shared/jobber-accepted-import.js";

export interface ImportPropertyInput {
  address: string;
  city: string;
  state?: string | null;
  zip: string;
  jobType?: string | null;
  jobTypeDetail?: string | null;
  propertyId?: string | null;
}

export function resolveImportProperty(opts: {
  bodyAddress?: string | null;
  bodyCity?: string | null;
  bodyState?: string | null;
  bodyZip?: string | null;
  bodyJobType?: string | null;
  existing?: {
    property_address?: string | null;
    property_city?: string | null;
    property_state?: string | null;
    property_zip?: string | null;
    job_type?: string | null;
    property_id?: string | null;
  } | null;
  clientProperty?: {
    id: string;
    address: string;
    city: string;
    state: string | null;
    zip: string;
  } | null;
  clientMailing?: {
    mailing_address?: string | null;
    mailing_city?: string | null;
    mailing_state?: string | null;
    mailing_zip?: string | null;
  } | null;
}): ImportPropertyInput | { error: string } {
  const address =
    (opts.bodyAddress ?? "").trim() ||
    (opts.existing?.property_address ?? "").trim() ||
    (opts.clientProperty?.address ?? "").trim() ||
    (opts.clientMailing?.mailing_address ?? "").trim();
  const city =
    (opts.bodyCity ?? "").trim() ||
    (opts.existing?.property_city ?? "").trim() ||
    (opts.clientProperty?.city ?? "").trim() ||
    (opts.clientMailing?.mailing_city ?? "").trim();
  const state =
    (opts.bodyState ?? "").trim() ||
    (opts.existing?.property_state ?? "").trim() ||
    (opts.clientProperty?.state ?? "").trim() ||
    (opts.clientMailing?.mailing_state ?? "").trim() ||
    "Arkansas";
  const zip =
    (opts.bodyZip ?? "").trim() ||
    (opts.existing?.property_zip ?? "").trim() ||
    (opts.clientProperty?.zip ?? "").trim() ||
    (opts.clientMailing?.mailing_zip ?? "").trim();
  if (!address || !city || !zip) {
    return { error: "Property address, city, and ZIP are required to convert this estimate into a job." };
  }
  return {
    address,
    city,
    state,
    zip,
    jobType: (opts.bodyJobType ?? opts.existing?.job_type ?? "").trim() || "Remodel",
    propertyId: opts.existing?.property_id ?? opts.clientProperty?.id ?? null,
  };
}

/**
 * convertQuoteToJob keys off estimate_requests. New Estimate quick-create
 * inserts standalone estimates (request_id NULL). Create a backing request
 * so the existing conversion path can run unmodified — no lead SMS, no
 * second job-creation door.
 */
export async function ensureEstimateRequestForConversion(
  env: Env,
  estimateId: string,
  property: ImportPropertyInput,
  createdByEmail: string,
): Promise<{ requestId: string; created: boolean }> {
  const est = await env.DB.prepare(
    "SELECT id, request_id, client_id, title FROM estimates WHERE id = ?",
  )
    .bind(estimateId)
    .first<{ id: string; request_id: string | null; client_id: string | null; title: string | null }>();
  if (!est) throw new Error("estimate not found");
  if (est.request_id) return { requestId: est.request_id, created: false };
  if (!est.client_id) throw new Error("estimate has no client");

  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
  ).first<{ n: number }>();
  const requestNumber = (max?.n ?? 0) + 1;
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  const jobType = property.jobType || "Remodel";
  const jobTypeDetail = property.jobTypeDetail || est.title || null;

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
       id, request_number, status, client_id,
       property_id, property_address, property_city, property_state, property_zip,
       job_type, job_type_detail, lead_source, source,
       visit_notes, estimate_id, sent_date,
       created_at, updated_at, created_by
     ) VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, 'repeat', 'manual', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      requestId,
      requestNumber,
      est.client_id,
      property.propertyId ?? null,
      property.address,
      property.city,
      property.state || "Arkansas",
      property.zip,
      jobType,
      jobTypeDetail,
      "Backing request for Jobber-accepted estimate imported into CHS. No CHS lead outreach.",
      estimateId,
      now,
      now,
      now,
      createdByEmail,
    )
    .run();

  await env.DB.prepare(
    "UPDATE estimates SET request_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(requestId, now, estimateId)
    .run();

  return { requestId, created: true };
}

export async function loadClientPropertyForImport(
  env: Env,
  clientId: string,
): Promise<{
  property: { id: string; address: string; city: string; state: string | null; zip: string } | null;
  mailing: {
    mailing_address: string | null;
    mailing_city: string | null;
    mailing_state: string | null;
    mailing_zip: string | null;
  } | null;
}> {
  const [property, mailing] = await Promise.all([
    env.DB.prepare(
      `SELECT id, address, city, state, zip FROM properties
        WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(clientId)
      .first<{ id: string; address: string; city: string; state: string | null; zip: string }>(),
    env.DB.prepare(
      `SELECT mailing_address, mailing_city, mailing_state, mailing_zip FROM clients WHERE id = ?`,
    )
      .bind(clientId)
      .first<{
        mailing_address: string | null;
        mailing_city: string | null;
        mailing_state: string | null;
        mailing_zip: string | null;
      }>(),
  ]);
  return { property: property ?? null, mailing: mailing ?? null };
}
