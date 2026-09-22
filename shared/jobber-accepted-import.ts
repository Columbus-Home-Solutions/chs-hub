/**
 * Jobber-accepted estimate recreation (transition-period, not bulk CSV import).
 *
 * Historical Jobber CSV rows already use data_source = 'jobber_import'.
 * Live recreations of a quote that was signed in Jobber use a distinct value
 * so they never look like a native CHS BoldSign-signed estimate.
 */

export const JOBBER_ACCEPTED_IMPORT = "jobber_accepted_import";
export const JOBBER_IMPORT = "jobber_import";
export const IMPORTED_SIGNED_BADGE = "Imported — Signed via Jobber";

export function isJobberAcceptedImport(dataSource: string | null | undefined): boolean {
  return dataSource === JOBBER_ACCEPTED_IMPORT;
}

/** True when CHS must not create or poll a BoldSign envelope for this estimate. */
export function shouldSkipBoldSignForEstimate(dataSource: string | null | undefined): boolean {
  return isJobberAcceptedImport(dataSource);
}

export function importedEstimateStatusLabel(
  dataSource: string | null | undefined,
  status: string | null | undefined,
): string | null {
  if (!isJobberAcceptedImport(dataSource)) return null;
  if (status === "approved") return null;
  return IMPORTED_SIGNED_BADGE;
}
