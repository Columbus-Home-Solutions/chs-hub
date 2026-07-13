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
