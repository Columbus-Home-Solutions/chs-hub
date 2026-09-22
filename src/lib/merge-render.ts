/**
 * Shared {{token}} renderer for customer-facing SMS/email copy.
 *
 * Used by the notification engine, lead outreach, quote follow-ups, and
 * review follow-ups so missing merge fields behave the same everywhere.
 *
 * Natural-language fallbacks:
 *   {{client_first_name}} — nameless leads render as "there" so
 *     "Hey {{client_first_name}}," becomes "Hey there,".
 *   {{job_type}} — missing/empty/generic "other" never prints the word
 *     "Other". Templates that already say "project" (Lead Outreach
 *     "your {{job_type}} project") drop the token so the phrase reads
 *     "your project"; otherwise the token renders as "project".
 * Other missing tokens still render empty.
 */

const FIRST_NAME_FALLBACK = "there";
const GENERIC_JOB_TYPE_FALLBACK = "project";

function tokenValue(key: string, ctx: Record<string, string>): string | undefined {
  const raw = ctx[key];
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim();
  return v === "" ? undefined : v;
}

/** True when job_type was never captured, or is the generic catch-all category. */
function isGenericJobType(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const n = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return n === "" || n === "other";
}

/**
 * Keep surrounding copy grammatical when job_type has no real value.
 * "your {{job_type}} project" → empty (template already says "project").
 * "your estimate for {{job_type}}." → "project".
 * "{{job_type}} Estimate Coming Soon" → empty (noun already present).
 */
function genericJobTypeReplacement(afterMatch: string): string {
  const m = afterMatch.match(/^\s*(\S+)/);
  const next = (m?.[1] ?? "").replace(/[.,!?;:]+$/g, "");
  if (!next) return GENERIC_JOB_TYPE_FALLBACK;
  if (/^project$/i.test(next)) return "";
  const first = next[0];
  if (first !== first.toLowerCase()) return "";
  return GENERIC_JOB_TYPE_FALLBACK;
}

function tidyHorizontalWhitespace(text: string): string {
  return text.replace(/[^\S\n]{2,}/g, " ").replace(/^[^\S\n]+|[^\S\n]+$/gm, "");
}

/** Replace {{token}} tokens; unknown tokens render empty and are reported. */
export function renderTemplate(
  template: string,
  ctx: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const replaced = template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (match: string, key: string, offset: number, full: string) => {
      const v = tokenValue(key, ctx);
      if (key === "client_first_name") return v ?? FIRST_NAME_FALLBACK;
      if (key === "job_type" && isGenericJobType(v)) {
        return genericJobTypeReplacement(full.slice(offset + match.length));
      }
      if (v !== undefined) return v;
      missing.push(key);
      return "";
    },
  );
  return { text: tidyHorizontalWhitespace(replaced), missing };
}

export function renderTemplateText(template: string, ctx: Record<string, string>): string {
  return renderTemplate(template, ctx).text;
}
