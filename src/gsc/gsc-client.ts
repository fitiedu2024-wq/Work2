import { fetchGoogleJson } from "../shared/google-api";

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

export type SearchAnalyticsInput = {
  startDate: string;
  endDate: string;
  dimensions?:
    | Array<
        | "query"
        | "page"
        | "country"
        | "device"
        | "date"
        | "hour"
        | "searchAppearance"
      >
    | undefined;
  type?:
    | "web"
    | "image"
    | "video"
    | "news"
    | "discover"
    | "googleNews"
    | undefined;
  dataState?: "final" | "all" | "hourly_all" | undefined;
  aggregationType?:
    | "auto"
    | "byPage"
    | "byProperty"
    | "byNewsShowcasePanel"
    | undefined;
  dimensionFilterGroups?: JsonObject[] | undefined;
  rowLimit?: number | undefined;
  startRow?: number | undefined;
};

export async function searchAnalytics(
  key: string,
  siteUrl: string,
  input: SearchAnalyticsInput
): Promise<JsonObject> {
  const body: JsonObject = {
    startDate: input.startDate,
    endDate: input.endDate
  };
  if (input.dimensions) body.dimensions = input.dimensions;
  if (input.type) body.type = input.type;
  if (input.dataState) body.dataState = input.dataState;
  if (input.aggregationType) body.aggregationType = input.aggregationType;
  if (input.dimensionFilterGroups) {
    body.dimensionFilterGroups = input.dimensionFilterGroups;
  }
  if (input.rowLimit !== undefined) body.rowLimit = input.rowLimit;
  if (input.startRow !== undefined) body.startRow = input.startRow;

  return request(
    key,
    `${WEBMASTERS_BASE}/sites/${sitePath(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify(body) }
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
