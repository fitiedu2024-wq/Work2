import { fetchGoogleJson, GOOGLE_REQUEST_TIMEOUT_MS } from "../shared/google-api";
import { assertUrlBelongsToGscProperty } from "../shared/scope";

const SCOPE = "https://www.googleapis.com/auth/webmasters";
const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCH_CONSOLE_BASE = "https://searchconsole.googleapis.com/v1";

type JsonObject = Record<string, unknown>;

async function request(
  key: string,
  url: string,
  init: RequestInit = {}
): Promise<JsonObject> {
  return fetchGoogleJson(key, SCOPE, url, init);
}

function sitePath(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

export async function listSites(key: string): Promise<JsonObject> {
  return request(key, `${WEBMASTERS_BASE}/sites`);
}

export async function getSite(key: string, siteUrl: string): Promise<JsonObject> {
  return request(key, `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}`);
}

export const SEARCH_DIMENSIONS = [
  "query",
  "page",
  "country",
  "device",
  "date",
  "hour",
  "searchAppearance"
] as const;
export type SearchDimension = (typeof SEARCH_DIMENSIONS)[number];

export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const DATA_STATES = ["final", "all", "hourly_all"] as const;
export type DataState = (typeof DATA_STATES)[number];

export const FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex"
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type DimensionFilter = {
  dimension: "query" | "page" | "country" | "device" | "searchAppearance";
  operator: FilterOperator;
  expression: string;
};

export type SearchAnalyticsInput = {
  startDate: string;
  endDate: string;
  dimensions?: readonly SearchDimension[] | undefined;
  type?: SearchType | undefined;
  dataState?: DataState | undefined;
  aggregationType?: "auto" | "byPage" | "byProperty" | "byNewsShowcasePanel" | undefined;
  dimensionFilterGroups?: JsonObject[] | undefined;
  /** Convenience: a single AND group of simple filters. */
  filters?: readonly DimensionFilter[] | undefined;
  rowLimit?: number | undefined;
  startRow?: number | undefined;
};

export function buildSearchAnalyticsBody(input: SearchAnalyticsInput): JsonObject {
  const body: JsonObject = {
    startDate: input.startDate,
    endDate: input.endDate
  };
  if (input.dimensions?.length) body.dimensions = [...input.dimensions];
  if (input.type) body.type = input.type;
  if (input.dataState) body.dataState = input.dataState;
  if (input.aggregationType) body.aggregationType = input.aggregationType;
  const groups: JsonObject[] = [...(input.dimensionFilterGroups ?? [])];
  if (input.filters?.length) {
    groups.push({
      groupType: "and",
      filters: input.filters.map((filter) => ({
        dimension: filter.dimension,
        operator: filter.operator,
        expression: filter.expression
      }))
    });
  }
  if (groups.length) body.dimensionFilterGroups = groups;
  if (input.rowLimit !== undefined) body.rowLimit = input.rowLimit;
  if (input.startRow !== undefined) body.startRow = input.startRow;
  return body;
}

export async function searchAnalytics(
  key: string,
  siteUrl: string,
  input: SearchAnalyticsInput
): Promise<JsonObject> {
  return request(
    key,
    `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify(buildSearchAnalyticsBody(input)) }
  );
}

export async function inspectUrl(
  key: string,
  siteUrl: string,
  inspectionUrl: string,
  languageCode?: string
): Promise<JsonObject> {
  return request(key, `${SEARCH_CONSOLE_BASE}/urlInspection/index:inspect`, {
    method: "POST",
    body: JSON.stringify({
      inspectionUrl,
      siteUrl,
      ...(languageCode ? { languageCode } : {})
    })
  });
}

export async function listSitemaps(
  key: string,
  siteUrl: string,
  sitemapIndex?: string
): Promise<JsonObject> {
  const url = new URL(`${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/sitemaps`);
  if (sitemapIndex) url.searchParams.set("sitemapIndex", sitemapIndex);
  return request(key, url.href);
}

export async function getSitemap(
  key: string,
  siteUrl: string,
  feedpath: string
): Promise<JsonObject> {
  return request(
    key,
    `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`
  );
}

export async function submitSitemap(
  key: string,
  siteUrl: string,
  feedpath: string
): Promise<JsonObject> {
  return request(
    key,
    `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    { method: "PUT" }
  );
}

export async function deleteSitemap(
  key: string,
  siteUrl: string,
  feedpath: string
): Promise<JsonObject> {
  return request(
    key,
    `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// Sitemap XML fetching (the brand's own site, not Google)
// ---------------------------------------------------------------------------

const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;

export type SitemapContents = {
  url: string;
  kind: "index" | "urlset" | "unknown";
  childSitemaps: string[];
  urls: string[];
  truncated: boolean;
};

export function parseSitemapXml(url: string, xml: string, maxUrls: number): SitemapContents {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<urlset[\s>]/i.test(xml);
  const locs: string[] = [];
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  let truncated = false;
  while ((match = pattern.exec(xml)) !== null) {
    if (locs.length >= maxUrls) {
      truncated = true;
      break;
    }
    const loc = match[1];
    if (loc) {
      locs.push(
        loc
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      );
    }
  }
  return {
    url,
    kind: isIndex ? "index" : isUrlset ? "urlset" : "unknown",
    childSitemaps: isIndex ? locs : [],
    urls: isIndex ? [] : locs,
    truncated
  };
}

/** Downloads a sitemap that belongs to the configured property and parses its <loc> entries. */
export async function fetchSitemap(
  siteUrl: string,
  sitemapUrl: string,
  maxUrls: number
): Promise<SitemapContents> {
  const safeUrl = assertUrlBelongsToGscProperty(sitemapUrl, siteUrl, "sitemap URL");
  let response: Response;
  try {
    response = await fetch(safeUrl, {
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1", "User-Agent": "Work2-GSC-MCP/2.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `Could not download ${safeUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`Sitemap ${safeUrl} returned HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (length > SITEMAP_MAX_BYTES) {
    throw new Error(`Sitemap ${safeUrl} is larger than ${SITEMAP_MAX_BYTES / 1024 / 1024} MB.`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > SITEMAP_MAX_BYTES) {
    throw new Error(`Sitemap ${safeUrl} is larger than ${SITEMAP_MAX_BYTES / 1024 / 1024} MB.`);
  }
  let xml: string;
  if (safeUrl.endsWith(".gz") || response.headers.get("Content-Type")?.includes("gzip")) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    xml = await new Response(stream).text();
  } else {
    xml = new TextDecoder().decode(buffer);
  }
  return parseSitemapXml(safeUrl, xml, maxUrls);
}

/**
 * Collects page URLs from a sitemap, descending into a sitemap index. Bounded by
 * maxSitemaps downloads and maxUrls collected URLs.
 */
export async function collectSitemapUrls(
  siteUrl: string,
  rootSitemaps: readonly string[],
  maxSitemaps: number,
  maxUrls: number
): Promise<{ urls: Set<string>; sitemapsFetched: string[]; truncated: boolean; errors: string[] }> {
  const queue = [...rootSitemaps];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const sitemapsFetched: string[] = [];
  const errors: string[] = [];
  let truncated = false;
  while (queue.length && sitemapsFetched.length < maxSitemaps && urls.size < maxUrls) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      const contents = await fetchSitemap(siteUrl, next, maxUrls - urls.size);
      sitemapsFetched.push(next);
      if (contents.truncated) truncated = true;
      for (const child of contents.childSitemaps) queue.push(child);
      for (const url of contents.urls) urls.add(url);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (queue.length) truncated = true;
  return { urls, sitemapsFetched, truncated, errors };
}

// ---------------------------------------------------------------------------
// Universal scoped read
// ---------------------------------------------------------------------------

export type GscApiReadInput = {
  method: "GET" | "POST";
  path: string;
  query: JsonObject;
  body: JsonObject;
};

/**
 * Validates a caller-supplied Search Console path. Allowed shapes:
 *   sites/{site}                      (GET)
 *   sites/{site}/sitemaps[/{feedpath}] (GET)
 *   sites/{site}/searchAnalytics/query (POST)
 *   urlInspection/index:inspect        (POST; siteUrl forced from config)
 * `{site}` may be written as "~" to mean the configured property.
 */
export function resolveScopedGscPath(
  rawPath: string,
  siteUrl: string,
  method: "GET" | "POST"
): { url: string; forceSiteUrl: boolean } {
  const path = rawPath.trim().replace(/^\/+/, "");
  if (!path || path.length > 1000 || path.includes("..") || path.includes("?") || path.includes("#") || path.includes("://")) {
    throw new Error("The path is invalid. Pass the resource path only, without host or query string.");
  }
  if (path === "urlInspection/index:inspect") {
    if (method !== "POST") throw new Error("urlInspection/index:inspect requires POST.");
    return { url: `${SEARCH_CONSOLE_BASE}/urlInspection/index:inspect`, forceSiteUrl: true };
  }
  const match = /^sites\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) {
    throw new Error('The path must start with "sites/~" (the configured property) or be "urlInspection/index:inspect".');
  }
  const siteSegment = match[1] ?? "";
  const rest = match[2] ?? "";
  let requestedSite: string;
  try {
    requestedSite = siteSegment === "~" ? siteUrl : decodeURIComponent(siteSegment);
  } catch {
    throw new Error("The site segment is not valid URL encoding.");
  }
  if (requestedSite !== siteUrl) {
    throw new Error(`The path must stay inside the configured property ${siteUrl}.`);
  }
  if (rest === "" || rest === "/sitemaps" || /^\/sitemaps\/[^/]+$/.test(rest)) {
    if (method !== "GET") throw new Error("Only GET is allowed for site and sitemap resources here.");
  } else if (rest === "/searchAnalytics/query") {
    if (method !== "POST") throw new Error("searchAnalytics/query requires POST.");
  } else {
    throw new Error("Unsupported Search Console path.");
  }
  return { url: `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}${rest}`, forceSiteUrl: false };
}

export async function gscApiRead(
  key: string,
  siteUrl: string,
  input: GscApiReadInput
): Promise<JsonObject> {
  const { url, forceSiteUrl } = resolveScopedGscPath(input.path, siteUrl, input.method);
  const target = new URL(url);
  for (const [name, value] of Object.entries(input.query)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) throw new Error(`Invalid query parameter: ${name}`);
    if (value === null || typeof value === "object") throw new Error(`Query parameter ${name} must be scalar.`);
    target.searchParams.set(name, String(value));
  }
  if (input.method === "GET") return request(key, target.href);
  const body: JsonObject = { ...input.body };
  if (forceSiteUrl) {
    body.siteUrl = siteUrl;
    if (typeof body.inspectionUrl === "string") {
      body.inspectionUrl = assertUrlBelongsToGscProperty(body.inspectionUrl, siteUrl, "inspectionUrl");
    }
  }
  return request(key, target.href, { method: "POST", body: JSON.stringify(body) });
}
