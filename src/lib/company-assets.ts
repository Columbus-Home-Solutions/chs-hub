/**
 * Static company-wide marketing PDFs (no merge fields).
 * Overwrite the same R2 keys to update — no code change required.
 */
export const COMPANY_ASSET_SLUGS = {
  "one-sheet": {
    r2Key: "company-assets/one-sheet.pdf",
    filename: "CHS-One-Sheet.pdf",
    contentType: "application/pdf",
    label: "One Sheet",
  },
  "price-match-guarantee": {
    r2Key: "company-assets/price-match-guarantee.pdf",
    filename: "CHS-Price-Match-Guarantee.pdf",
    contentType: "application/pdf",
    label: "Price Match Guarantee",
  },
} as const;

export type CompanyAssetSlug = keyof typeof COMPANY_ASSET_SLUGS;

/** Public URL path for a company asset (served by /api/public/company-assets/:slug). */
export function companyAssetPublicPath(slug: CompanyAssetSlug): string {
  return `/api/public/company-assets/${slug}`;
}

/** Absolute public URL for quote-page / email body links. */
export function companyAssetPublicUrl(origin: string, slug: CompanyAssetSlug): string {
  const base = origin.replace(/\/$/, "");
  return `${base}${companyAssetPublicPath(slug)}`;
}
