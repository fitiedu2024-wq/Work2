import { normalizePropertyId, normalizeSiteUrl } from "./scope";

export type WebsiteConfig = {
  slug: string;
  label: string;
  siteUrl: string;
  gaAccountId: string;
  gaAccountName: string;
  gaPropertyId: string;
  gscSiteUrl: string;
};

type WebsiteEnv = Pick<
  Env,
  | "BRAND_SLUG"
  | "BRAND_LABEL"
  | "BRAND_SITE_URL"
  | "GA_ACCOUNT_ID"
  | "GA_ACCOUNT_NAME"
  | "GA_PROPERTY_ID"
  | "GSC_SITE_URL"
>;

export function websiteFromEnv(env: WebsiteEnv): WebsiteConfig {
  const slug = env.BRAND_SLUG.trim();
  const label = env.BRAND_LABEL.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error("BRAND_SLUG must contain lowercase letters, numbers, _ or -.");
  }
  if (!label) throw new Error("BRAND_LABEL must be configured.");

  return {
    slug,
    label,
    siteUrl: env.BRAND_SITE_URL.trim(),
    gaAccountId: env.GA_ACCOUNT_ID.trim(),
    gaAccountName: env.GA_ACCOUNT_NAME.trim(),
    gaPropertyId: env.GA_PROPERTY_ID.trim(),
    gscSiteUrl: env.GSC_SITE_URL.trim()
  };
}

export function requireGaProperty(website: WebsiteConfig): string {
  if (!website.gaPropertyId) {
    const account = website.gaAccountId
      ? ` Account ${website.gaAccountId}${
          website.gaAccountName ? ` (${website.gaAccountName})` : ""
        } is configured for discovery.`
      : "";
    throw new Error(
      `Worker "${website.slug}" has no GA_PROPERTY_ID.${account} Set it in the Wrangler environment before running property tools.`
    );
  }
  return normalizePropertyId(website.gaPropertyId);
}

export function requireGscProperty(website: WebsiteConfig): string {
  const configured = website.gscSiteUrl || website.siteUrl;
  if (!configured) {
    throw new Error(
      `Worker "${website.slug}" has no GSC_SITE_URL or BRAND_SITE_URL. Set it in the Wrangler environment before running Search Console tools.`
    );
  }
  return normalizeSiteUrl(configured);
}
