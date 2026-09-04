export function normalizePropertyId(value: string | number): string {
  const text = String(value).trim();
  const id = text.startsWith("properties/") ? text.slice("properties/".length) : text;
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `Invalid propertyId "${text}". Use a numeric GA4 property ID or "properties/{id}".`
    );
  }
  return `properties/${id}`;
}

export function normalizeSiteUrl(value: string): string {
  const text = value.trim();
  if (text.startsWith("sc-domain:")) {
    const domain = text.slice("sc-domain:".length).trim().toLowerCase();
    if (!domain || /[/?#]/.test(domain)) {
      throw new Error(`Invalid Search Console domain property "${text}".`);
    }
    return `sc-domain:${domain}`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `Invalid siteUrl "${text}". Use a URL-prefix property or "sc-domain:example.com".`
    );
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid Search Console URL-prefix property "${text}".`);
  }
  url.hash = "";
  return url.href;
}

export function assertUrlBelongsToGscProperty(
  value: string,
  siteUrl: string,
  label = "URL"
): string {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (
    !["http:", "https:"].includes(candidate.protocol) ||
    candidate.username ||
    candidate.password ||
    candidate.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials or a fragment.`);
  }

  const property = normalizeSiteUrl(siteUrl);
  if (property.startsWith("sc-domain:")) {
    const domain = property.slice("sc-domain:".length);
    const hostname = candidate.hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      throw new Error(`${label} is outside Search Console property "${property}".`);
    }
  } else if (!candidate.href.startsWith(property)) {
    throw new Error(`${label} is outside Search Console property "${property}".`);
  }
  return candidate.href;
}
