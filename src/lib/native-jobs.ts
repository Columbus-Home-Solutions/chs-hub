/**
 * Native CHS platform jobs — created via quote-to-job or Quick Job.
 * Excludes legacy Jobber-synced rows (source = 'QUOTE_CONVERT', etc.).
 */
export const NATIVE_JOB_SOURCES_SQL = "('estimate', 'quick_job')";

export function nativeJobSourceWhere(column = "source"): string {
  return `${column} IN ${NATIVE_JOB_SOURCES_SQL}`;
}

export function nativeJobSourceWhereAliased(alias: string): string {
  return nativeJobSourceWhere(`${alias}.source`);
}

/**
 * Calendar and Job Health. Native jobs stay. One scheduled Jobber import
 * is included. Invoicing and close keep nativeJobSourceWhere().
 */
export function scheduledImportVisibleWhere(alias: string): string {
  const p = `${alias}.`;
  return `(${nativeJobSourceWhereAliased(alias)} OR (${p}source = 'jobber_import' AND ${p}status = 'scheduled'))`;
}
