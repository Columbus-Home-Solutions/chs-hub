/**
 * Job portal tokens are minted at quote-to-job conversion. An imported job
 * can reach the completion package with none. The send mints one then, and
 * never replaces a token that already exists.
 */

export function mintPortalToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function completionPackageUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/portal/${token}/completion-package`;
}

export async function ensureJobPortalToken(
  db: D1Database,
  jobId: string,
  existing: string | null | undefined,
): Promise<string> {
  const current = (existing ?? "").trim();
  if (current) return current;
  const token = mintPortalToken();
  await db
    .prepare(
      `UPDATE jobs
          SET portal_token = COALESCE(NULLIF(TRIM(portal_token), ''), ?),
              updated_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(token, jobId)
    .run();
  const row = await db
    .prepare("SELECT portal_token FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ portal_token: string | null }>();
  return (row?.portal_token ?? "").trim() || token;
}
