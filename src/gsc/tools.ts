import { z } from "zod";
import {
  actionAnnotations,
  execute,
  mapWithConcurrency,
  readAnnotations,
  writeAnnotations
} from "../shared/mcp";
import { assertUrlBelongsToGscProperty } from "../shared/scope";
import {
  compareSearchRows,
  defaultBrandPattern,
  findCannibalization,
  findCtrOpportunities,
  findStrikingDistance,
  flattenSearchRows,
  GSC_DATE_PATTERN,
  sortRows,
  splitBrandQueries,
  summarizeInspection,
  totals,
  type SearchMetric,
  type SearchRow
} from "./analytics-shaping";
import { gscSite, type GscToolContext } from "./context";
import * as gsc from "./gsc-client";

const dateSchema = z.string().regex(GSC_DATE_PATTERN, "Use YYYY-MM-DD.");
const jsonObjectSchema = z.record(z.string(), z.unknown());
const changeSummary = z
  .string()
  .min(5)
  .max(500)
  .describe("Plain-language summary of the change, shown with the approval request.");
const metricSchema = z.enum(["clicks", "impressions", "ctr", "position"]);
const countrySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Use a 3-letter ISO 3166-1 alpha-3 code such as SAU, EGY, USA.")
  .transform((value) => value.toLowerCase());
const deviceSchema = z.enum(["DESKTOP", "MOBILE", "TABLET"]);
const filterSchema = z.object({
  dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
  operator: z.enum(gsc.FILTER_OPERATORS).default("contains"),
  expression: z.string().min(1).max(500)
});

/** Filters shared by the shaped tools. */
const commonFilters = {
  startDate: dateSchema.optional().describe("Defaults to 28 days ago."),
  endDate: dateSchema.optional().describe("Defaults to 3 days ago (Search Console data lags ~2-3 days)."),
  country: countrySchema.optional(),
  device: deviceSchema.optional(),
  pageContains: z.string().max(500).optional(),
  queryContains: z.string().max(500).optional(),
  queryRegex: z.string().max(500).optional().describe("RE2 regex applied to queries (includingRegex)."),
  searchType: z.enum(gsc.SEARCH_TYPES).default("web"),
  dataState: z.enum(gsc.DATA_STATES).optional(),
  extraFilters: z.array(filterSchema).max(10).optional()
};

type CommonFilters = z.infer<z.ZodObject<typeof commonFilters>>;

function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function defaultRange(input: { startDate?: string | undefined; endDate?: string | undefined }) {
  const endDate = input.endDate ?? isoDaysAgo(3);
  const startDate = input.startDate ?? isoDaysAgo(30);
  if (startDate > endDate) throw new Error("startDate must not be after endDate.");
  return { startDate, endDate };
}

function previousRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  const lengthDays = Math.round((end - start) / 86_400_000) + 1;
  const previousEnd = new Date(start - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (lengthDays - 1) * 86_400_000);
  return {
    startDate: previousStart.toISOString().slice(0, 10),
    endDate: previousEnd.toISOString().slice(0, 10)
  };
}

function buildFilters(input: CommonFilters): gsc.DimensionFilter[] {
  const filters: gsc.DimensionFilter[] = [];
  if (input.country) filters.push({ dimension: "country", operator: "equals", expression: input.country });
  if (input.device) filters.push({ dimension: "device", operator: "equals", expression: input.device });
  if (input.pageContains) filters.push({ dimension: "page", operator: "contains", expression: input.pageContains });
  if (input.queryContains) filters.push({ dimension: "query", operator: "contains", expression: input.queryContains });
  if (input.queryRegex) filters.push({ dimension: "query", operator: "includingRegex", expression: input.queryRegex });
  for (const extra of input.extraFilters ?? []) filters.push(extra);
  return filters;
}

async function queryRows(
  context: GscToolContext,
  dimensions: readonly gsc.SearchDimension[],
  input: CommonFilters,
  range: { startDate: string; endDate: string },
  rowLimit: number,
  extraFilters: gsc.DimensionFilter[] = []
): Promise<SearchRow[]> {
  const response = await gsc.searchAnalytics(context.key, gscSite(context), {
    ...range,
    dimensions,
    type: input.searchType,
    dataState: input.dataState,
    filters: [...buildFilters(input), ...extraFilters],
    rowLimit
  });
  return flattenSearchRows(response, dimensions);
}

function rankedResult(
  rows: SearchRow[],
  dimensions: readonly string[],
  sortBy: SearchMetric,
  descending: boolean,
  limit: number,
  range: { startDate: string; endDate: string }
) {
  const sorted = sortRows(rows, sortBy, descending).slice(0, limit);
  return {
    dateRange: range,
    dimensions,
    sortedBy: `${sortBy} ${descending ? "desc" : "asc"}`,
    fetchedRows: rows.length,
    totals: totals(rows),
    rows: sorted
  };
}

export function registerGscTools(context: GscToolContext): void {
  const { server, key, website, name, lock } = context;

  // --- Raw API --------------------------------------------------------------

  server.registerTool(
    name("list_sites"),
    {
      title: "List sites",
      description: `The Search Console property this Worker is locked to, with the service account's permission level. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () =>
      execute(async () => {
        const site = gscSite(context);
        const result = await gsc.listSites(key);
        const entries = Array.isArray(result.siteEntry) ? result.siteEntry : [];
        const filtered = entries.filter(
          (entry) => (entry as Record<string, unknown> | null)?.siteUrl === site
        );
        if (!filtered.length) {
          throw new Error(
            `Configured Search Console property "${site}" is not visible to the service account. Add the service account as a Full user.`
          );
        }
        return { siteEntry: filtered };
      })
  );

  server.registerTool(
    name("get_site_details"),
    {
      title: "Get site details",
      description: `Permission level of the service account on the configured property. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => gsc.getSite(key, gscSite(context)))
  );

  server.registerTool(
    name("search_analytics"),
    {
      title: "Search analytics (raw)",
      description: `Raw searchAnalytics.query: clicks, impressions, CTR, and position grouped by any dimensions with full filter control. Returns Google's response unchanged. ${lock}`,
      inputSchema: z.object({
        startDate: dateSchema,
        endDate: dateSchema,
        dimensions: z.array(z.enum(gsc.SEARCH_DIMENSIONS)).optional(),
        type: z.enum(gsc.SEARCH_TYPES).optional(),
        dataState: z.enum(gsc.DATA_STATES).optional(),
        aggregationType: z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]).optional(),
        dimensionFilterGroups: z.array(jsonObjectSchema).optional(),
        filters: z.array(filterSchema).max(10).optional().describe("Simple AND filters; alternative to dimensionFilterGroups."),
        rowLimit: z.number().int().min(1).max(25_000).optional(),
        startRow: z.number().int().nonnegative().optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => gsc.searchAnalytics(key, gscSite(context), input))
  );

  server.registerTool(
    name("inspect_url"),
    {
      title: "Inspect URL",
      description: `Index status, canonical, robots, rich results, and crawl details for one URL of the property. Spends URL-inspection quota (2,000/day). ${lock}`,
      inputSchema: z.object({
        inspectionUrl: z.string().url(),
        languageCode: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional(),
        compact: z.boolean().default(true).describe("Return a summary instead of the full Google response.")
      }),
      annotations: actionAnnotations
    },
    async ({ inspectionUrl, languageCode, compact }) =>
      execute(async () => {
        const site = gscSite(context);
        const url = assertUrlBelongsToGscProperty(inspectionUrl, site, "inspectionUrl");
        const result = await gsc.inspectUrl(key, site, url, languageCode);
        return compact ? summarizeInspection(url, result) : result;
      })
  );

  server.registerTool(
    name("inspect_urls"),
    {
      title: "Inspect several URLs",
      description: `Inspect up to 20 URLs of the property (3 in parallel) and return a compact status per URL plus a verdict summary. Spends 1 inspection-quota unit per URL. ${lock}`,
      inputSchema: z.object({
        urls: z.array(z.string().url()).min(1).max(20),
        languageCode: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional()
      }),
      annotations: actionAnnotations
    },
    async ({ urls, languageCode }) =>
      execute(async () => {
        const site = gscSite(context);
        const safe = urls.map((url) => assertUrlBelongsToGscProperty(url, site, "url"));
        const results = await mapWithConcurrency(safe, 3, async (url) =>
          summarizeInspection(url, await gsc.inspectUrl(key, site, url, languageCode))
        );
        const summary: Record<string, number> = {};
        const rows = results.map((result) => {
          if (!result.ok) return { url: safe[result.index], error: result.error };
          const verdict = String(result.value.coverageState ?? result.value.verdict ?? "UNKNOWN");
          summary[verdict] = (summary[verdict] ?? 0) + 1;
          return result.value;
        });
        return { inspected: rows.length, summary, results: rows };
      })
  );

  server.registerTool(
    name("list_sitemaps"),
    {
      title: "List sitemaps",
      description: `Submitted sitemaps with status, URL counts, errors, and warnings. ${lock}`,
      inputSchema: z.object({ sitemapIndex: z.string().url().optional() }),
      annotations: readAnnotations
    },
    async ({ sitemapIndex }) =>
      execute(() => {
        const site = gscSite(context);
        return gsc.listSitemaps(
          key,
          site,
          sitemapIndex ? assertUrlBelongsToGscProperty(sitemapIndex, site, "sitemapIndex") : undefined
        );
      })
  );

  server.registerTool(
    name("get_sitemap"),
    {
      title: "Get sitemap",
      description: `Details for one submitted sitemap. ${lock}`,
      inputSchema: z.object({ feedpath: z.string().url().describe("The full sitemap URL.") }),
      annotations: readAnnotations
    },
    async ({ feedpath }) =>
      execute(() => {
        const site = gscSite(context);
        return gsc.getSitemap(key, site, assertUrlBelongsToGscProperty(feedpath, site, "feedpath"));
      })
  );

  server.registerTool(
    name("submit_sitemap"),
    {
      title: "Submit sitemap",
      description: `Submit or resubmit a sitemap to Search Console. Requires approval. ${lock}`,
      inputSchema: z.object({
        feedpath: z.string().url().describe("The full sitemap URL."),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ feedpath }) =>
      execute(() => {
        const site = gscSite(context);
        return gsc.submitSitemap(key, site, assertUrlBelongsToGscProperty(feedpath, site, "feedpath"));
      })
  );

  server.registerTool(
    name("delete_sitemap"),
    {
      title: "Remove sitemap submission",
      description: `Remove a sitemap submission from Search Console (the file itself is untouched). Requires approval. ${lock}`,
      inputSchema: z.object({
        feedpath: z.string().url().describe("The full sitemap URL."),
        confirm: z.literal(true).describe("Must be true to confirm removing the sitemap submission."),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ feedpath }) =>
      execute(() => {
        const site = gscSite(context);
        return gsc.deleteSitemap(key, site, assertUrlBelongsToGscProperty(feedpath, site, "feedpath"));
      })
  );

  // --- Shaped performance tools --------------------------------------------

  const rankedInput = {
    ...commonFilters,
    sortBy: metricSchema.default("clicks"),
    descending: z.boolean().default(true),
    limit: z.number().int().min(1).max(1000).default(25),
    fetchRows: z
      .number()
      .int()
      .min(1)
      .max(25_000)
      .default(5000)
      .describe("Rows fetched from Google before sorting; totals are computed over these.")
  };

  const rankedTools: Array<{ tool: string; title: string; description: string; dimensions: gsc.SearchDimension[] }> = [
    {
      tool: "get_top_queries",
      title: "Top queries",
      description: "Search queries ranked by clicks (or another metric) with impressions, CTR, and position.",
      dimensions: ["query"]
    },
    {
      tool: "get_top_pages",
      title: "Top pages",
      description: "Pages ranked by clicks (or another metric) with impressions, CTR, and position.",
      dimensions: ["page"]
    },
    {
      tool: "get_query_page_pairs",
      title: "Query and page pairs",
      description: "Which page ranks for which query, ranked by the chosen metric.",
      dimensions: ["query", "page"]
    },
    {
      tool: "get_country_breakdown",
      title: "Countries",
      description: "Performance per country (ISO alpha-3 codes).",
      dimensions: ["country"]
    },
    {
      tool: "get_device_breakdown",
      title: "Devices",
      description: "Performance per device type.",
      dimensions: ["device"]
    },
    {
      tool: "get_device_country_breakdown",
      title: "Device x country",
      description: "Performance per country and device combination.",
      dimensions: ["country", "device"]
    },
    {
      tool: "get_search_appearance_breakdown",
      title: "Search appearance",
      description: "Performance per rich-result / appearance type (merchant listings, product snippets, videos...). Cannot be combined with other dimensions.",
      dimensions: ["searchAppearance"]
    }
  ];

  for (const spec of rankedTools) {
    server.registerTool(
      name(spec.tool),
      {
        title: spec.title,
        description: `${spec.description} Filter by country, device, page, or query. ${lock}`,
        inputSchema: z.object(rankedInput),
        annotations: readAnnotations
      },
      async (input) =>
        execute(async () => {
          const range = defaultRange(input);
          const rows = await queryRows(context, spec.dimensions, input, range, input.fetchRows);
          return rankedResult(rows, spec.dimensions, input.sortBy, input.descending, input.limit, range);
        })
    );
  }

  server.registerTool(
    name("get_page_queries"),
    {
      title: "Queries for one page",
      description: `Every query that drives impressions to a specific page. ${lock}`,
      inputSchema: z.object({ page: z.string().url(), ...rankedInput }),
      annotations: readAnnotations
    },
    async ({ page, ...input }) =>
      execute(async () => {
        const site = gscSite(context);
        const range = defaultRange(input);
        const rows = await queryRows(context, ["query"], input, range, input.fetchRows, [
          { dimension: "page", operator: "equals", expression: assertUrlBelongsToGscProperty(page, site, "page") }
        ]);
        return { page, ...rankedResult(rows, ["query"], input.sortBy, input.descending, input.limit, range) };
      })
  );

  server.registerTool(
    name("get_query_pages"),
    {
      title: "Pages for one query",
      description: `Every page that ranks for a specific query (exact match), useful to spot cannibalisation. ${lock}`,
      inputSchema: z.object({ query: z.string().min(1).max(500), ...rankedInput }),
      annotations: readAnnotations
    },
    async ({ query, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, ["page"], input, range, input.fetchRows, [
          { dimension: "query", operator: "equals", expression: query }
        ]);
        return { query, ...rankedResult(rows, ["page"], input.sortBy, input.descending, input.limit, range) };
      })
  );

  server.registerTool(
    name("get_daily_trend"),
    {
      title: "Daily trend",
      description: `Clicks, impressions, CTR, and position per day. Set dataState=all to include the freshest partial days. ${lock}`,
      inputSchema: z.object(commonFilters),
      annotations: readAnnotations
    },
    async (input) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, ["date"], input, range, 1000);
        return { dateRange: range, totals: totals(rows), rows: [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date))) };
      })
  );

  server.registerTool(
    name("get_hourly_performance"),
    {
      title: "Hourly performance",
      description: `Clicks and impressions per hour for the last days (Google keeps hourly data ~10 days; dataState hourly_all is applied). ${lock}`,
      inputSchema: z.object({
        startDate: dateSchema.optional().describe("Defaults to 7 days ago."),
        endDate: dateSchema.optional().describe("Defaults to today."),
        country: countrySchema.optional(),
        device: deviceSchema.optional(),
        searchType: z.enum(gsc.SEARCH_TYPES).default("web")
      }),
      annotations: readAnnotations
    },
    async (input) =>
      execute(async () => {
        const range = { startDate: input.startDate ?? isoDaysAgo(7), endDate: input.endDate ?? isoDaysAgo(0) };
        const rows = await queryRows(
          context,
          ["hour"],
          { ...input, dataState: "hourly_all" },
          range,
          1000
        );
        return { dateRange: range, totals: totals(rows), rows: [...rows].sort((a, b) => String(a.hour).localeCompare(String(b.hour))) };
      })
  );

  server.registerTool(
    name("compare_periods"),
    {
      title: "Compare two periods",
      description: `Per-query, per-page, per-country, per-device, or total comparison of two date ranges with deltas. The previous period defaults to the same length immediately before. ${lock}`,
      inputSchema: z.object({
        dimension: z.enum(["query", "page", "country", "device", "total"]).default("query"),
        ...commonFilters,
        compareStartDate: dateSchema.optional(),
        compareEndDate: dateSchema.optional(),
        sortBy: metricSchema.default("clicks"),
        show: z.enum(["losers", "gainers", "absolute"]).default("losers"),
        limit: z.number().int().min(1).max(1000).default(25),
        fetchRows: z.number().int().min(1).max(25_000).default(5000)
      }),
      annotations: readAnnotations
    },
    async ({ dimension, compareStartDate, compareEndDate, sortBy, show, limit, fetchRows, ...input }) =>
      execute(async () => {
        const current = defaultRange(input);
        const previous =
          compareStartDate && compareEndDate
            ? { startDate: compareStartDate, endDate: compareEndDate }
            : previousRange(current.startDate, current.endDate);
        const dimensions: gsc.SearchDimension[] = dimension === "total" ? [] : [dimension];
        const [currentRows, previousRows] = await Promise.all([
          queryRows(context, dimensions, input, current, fetchRows),
          queryRows(context, dimensions, input, previous, fetchRows)
        ]);
        return {
          current,
          previous,
          dimension,
          ...compareSearchRows(currentRows, previousRows, dimensions, sortBy, limit, show)
        };
      })
  );

  server.registerTool(
    name("find_striking_distance_keywords"),
    {
      title: "Striking-distance keywords",
      description: `Queries ranking just off page one (position 8-20 by default) with meaningful impressions: the quickest ranking wins. Optionally include the ranking page. ${lock}`,
      inputSchema: z.object({
        ...commonFilters,
        minPosition: z.number().min(1).max(100).default(8),
        maxPosition: z.number().min(1).max(100).default(20),
        minImpressions: z.number().int().min(0).default(50),
        includePage: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(50)
      }),
      annotations: readAnnotations
    },
    async ({ minPosition, maxPosition, minImpressions, includePage, limit, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const dimensions: gsc.SearchDimension[] = includePage ? ["query", "page"] : ["query"];
        const rows = await queryRows(context, dimensions, input, range, 25_000);
        return {
          dateRange: range,
          criteria: { minPosition, maxPosition, minImpressions },
          rows: findStrikingDistance(rows, minPosition, maxPosition, minImpressions, limit)
        };
      })
  );

  server.registerTool(
    name("find_ctr_opportunities"),
    {
      title: "CTR opportunities",
      description: `Queries (or pages) whose CTR is below what their position normally earns, ranked by estimated extra clicks if the title/snippet improved. ${lock}`,
      inputSchema: z.object({
        ...commonFilters,
        dimension: z.enum(["query", "page"]).default("query"),
        minImpressions: z.number().int().min(0).default(100),
        limit: z.number().int().min(1).max(500).default(50)
      }),
      annotations: readAnnotations
    },
    async ({ dimension, minImpressions, limit, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, [dimension], input, range, 25_000);
        return {
          dateRange: range,
          note: "expectedCtr is an industry position curve used only for ranking; estimatedExtraClicks = impressions x (expectedCtr - ctr).",
          rows: findCtrOpportunities(rows, minImpressions, limit)
        };
      })
  );

  server.registerTool(
    name("find_query_cannibalization"),
    {
      title: "Query cannibalisation",
      description: `Queries where two or more pages of the site compete for impressions, with each competing page's metrics. ${lock}`,
      inputSchema: z.object({
        ...commonFilters,
        minImpressionsPerPage: z.number().int().min(1).default(20),
        limit: z.number().int().min(1).max(200).default(30)
      }),
      annotations: readAnnotations
    },
    async ({ minImpressionsPerPage, limit, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, ["query", "page"], input, range, 25_000);
        return { dateRange: range, results: findCannibalization(rows, minImpressionsPerPage, limit) };
      })
  );

  server.registerTool(
    name("get_brand_vs_nonbrand"),
    {
      title: "Brand vs non-brand",
      description: `Splits query performance into brand and non-brand using a regex (defaults to the brand label and domain), with totals, share, and top queries on each side. ${lock}`,
      inputSchema: z.object({
        ...commonFilters,
        brandPattern: z.string().max(500).optional().describe("Case-insensitive regex identifying brand queries."),
        topN: z.number().int().min(1).max(200).default(15)
      }),
      annotations: readAnnotations
    },
    async ({ brandPattern, topN, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, ["query"], input, range, 25_000);
        const pattern = brandPattern ?? defaultBrandPattern(website.label, gscSite(context));
        return { dateRange: range, ...splitBrandQueries(rows, pattern, topN) };
      })
  );

  server.registerTool(
    name("get_discover_performance"),
    {
      title: "Discover and Google News performance",
      description: `Clicks and impressions from Google Discover or Google News, by page or day. ${lock}`,
      inputSchema: z.object({
        surface: z.enum(["discover", "googleNews"]).default("discover"),
        breakdown: z.enum(["page", "date", "country"]).default("page"),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        limit: z.number().int().min(1).max(1000).default(25)
      }),
      annotations: readAnnotations
    },
    async ({ surface, breakdown, limit, ...input }) =>
      execute(async () => {
        const range = defaultRange(input);
        const rows = await queryRows(context, [breakdown], { ...input, searchType: surface }, range, 5000);
        return { surface, ...rankedResult(rows, [breakdown], "clicks", true, limit, range) };
      })
  );

  // --- Sitemap and indexing audits ------------------------------------------

  server.registerTool(
    name("audit_sitemap"),
    {
      title: "Audit sitemap",
      description: `Search Console status of a sitemap plus a live download of the file: type, URL count, child sitemaps, and any parse problems. Defaults to /sitemap.xml. ${lock}`,
      inputSchema: z.object({
        feedpath: z.string().url().optional(),
        maxUrls: z.number().int().min(1).max(50_000).default(5000),
        sampleUrls: z.number().int().min(0).max(50).default(10)
      }),
      annotations: readAnnotations
    },
    async ({ feedpath, maxUrls, sampleUrls }) =>
      execute(async () => {
        const site = gscSite(context);
        const target = feedpath ?? `${website.siteUrl.replace(/\/$/, "")}/sitemap.xml`;
        const safe = assertUrlBelongsToGscProperty(target, site, "feedpath");
        const [consoleStatus, live] = await Promise.all([
          gsc.getSitemap(key, site, safe).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error)
          })),
          gsc.fetchSitemap(site, safe, maxUrls)
        ]);
        return {
          sitemap: safe,
          searchConsole: consoleStatus,
          live: {
            kind: live.kind,
            urlCount: live.urls.length,
            childSitemaps: live.childSitemaps,
            truncated: live.truncated,
            sampleUrls: live.urls.slice(0, sampleUrls)
          }
        };
      })
  );

  server.registerTool(
    name("get_index_coverage_sample"),
    {
      title: "Index coverage sample",
      description: `Downloads the sitemap(s), samples up to 20 URLs (evenly spaced or random), inspects them, and summarises indexed vs not-indexed with reasons. Spends 1 inspection-quota unit per sampled URL. ${lock}`,
      inputSchema: z.object({
        sitemapUrl: z.string().url().optional().describe("Defaults to every submitted sitemap."),
        sampleSize: z.number().int().min(1).max(20).default(10),
        sampling: z.enum(["spaced", "random", "first"]).default("spaced"),
        urlContains: z.string().max(200).optional().describe("Only sample URLs containing this text (e.g. /products/)."),
        maxUrls: z.number().int().min(1).max(50_000).default(20_000)
      }),
      annotations: actionAnnotations
    },
    async ({ sitemapUrl, sampleSize, sampling, urlContains, maxUrls }) =>
      execute(async () => {
        const site = gscSite(context);
        const roots = sitemapUrl
          ? [assertUrlBelongsToGscProperty(sitemapUrl, site, "sitemapUrl")]
          : await submittedSitemapPaths(key, site);
        const collected = await gsc.collectSitemapUrls(site, roots, 25, maxUrls);
        let candidates = [...collected.urls];
        if (urlContains) candidates = candidates.filter((url) => url.includes(urlContains));
        const sample = pickSample(candidates, sampleSize, sampling);
        const results = await mapWithConcurrency(sample, 3, async (url) =>
          summarizeInspection(url, await gsc.inspectUrl(key, site, url))
        );
        const byCoverage: Record<string, number> = {};
        const rows = results.map((result) => {
          if (!result.ok) return { url: sample[result.index], error: result.error };
          const state = String(result.value.coverageState ?? result.value.verdict ?? "UNKNOWN");
          byCoverage[state] = (byCoverage[state] ?? 0) + 1;
          return result.value;
        });
        return {
          sitemaps: collected.sitemapsFetched,
          sitemapErrors: collected.errors,
          urlsInSitemaps: collected.urls.size,
          candidates: candidates.length,
          truncated: collected.truncated,
          sampled: sample.length,
          byCoverage,
          results: rows
        };
      })
  );

  server.registerTool(
    name("find_orphan_pages"),
    {
      title: "Pages missing from sitemaps",
      description: `Pages that received impressions in Search but are not listed in any submitted sitemap (candidates for the sitemap or for noindex), and sitemap URLs with zero impressions. ${lock}`,
      inputSchema: z.object({
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        minImpressions: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(1000).default(100),
        maxUrls: z.number().int().min(1).max(50_000).default(20_000)
      }),
      annotations: readAnnotations
    },
    async ({ minImpressions, limit, maxUrls, ...input }) =>
      execute(async () => {
        const site = gscSite(context);
        const range = defaultRange(input);
        const [rows, roots] = await Promise.all([
          queryRows(context, ["page"], { searchType: "web" }, range, 25_000),
          submittedSitemapPaths(key, site)
        ]);
        const collected = await gsc.collectSitemapUrls(site, roots, 25, maxUrls);
        const normalize = (url: string) => url.replace(/\/$/, "").toLowerCase();
        const inSitemap = new Set([...collected.urls].map(normalize));
        const searchPages = new Map<string, SearchRow>();
        for (const row of rows) searchPages.set(normalize(String(row.page ?? "")), row);
        const notInSitemap = rows
          .filter((row) => row.impressions >= minImpressions && !inSitemap.has(normalize(String(row.page ?? ""))))
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, limit);
        const zeroImpressionSitemapUrls = [...collected.urls]
          .filter((url) => !searchPages.has(normalize(url)))
          .slice(0, limit);
        return {
          dateRange: range,
          sitemaps: collected.sitemapsFetched,
          sitemapErrors: collected.errors,
          truncated: collected.truncated,
          pagesWithImpressions: rows.length,
          urlsInSitemaps: collected.urls.size,
          pagesNotInSitemaps: notInSitemap,
          sitemapUrlsWithoutImpressions: { count: zeroImpressionSitemapUrls.length, sample: zeroImpressionSitemapUrls }
        };
      })
  );

  // --- Universal scoped read ------------------------------------------------

  server.registerTool(
    name("gsc_api_read"),
    {
      title: "Read any scoped Search Console resource",
      description: `Universal read for the configured property. Paths: "sites/~", "sites/~/sitemaps", "sites/~/sitemaps/{feedpath}" (GET), "sites/~/searchAnalytics/query" or "urlInspection/index:inspect" (POST). "~" stands for the configured property; siteUrl is always forced. ${lock}`,
      inputSchema: z.object({
        method: z.enum(["GET", "POST"]).default("GET"),
        path: z.string().min(1).max(1000),
        query: jsonObjectSchema.default({}),
        body: jsonObjectSchema.default({})
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => gsc.gscApiRead(key, gscSite(context), input))
  );
}

async function submittedSitemapPaths(key: string, site: string): Promise<string[]> {
  const listed = await gsc.listSitemaps(key, site);
  const entries = Array.isArray(listed.sitemap) ? listed.sitemap : [];
  const paths = entries
    .map((entry) => (entry as Record<string, unknown> | null)?.path)
    .filter((path): path is string => typeof path === "string");
  if (!paths.length) throw new Error("No sitemaps are submitted for this property. Pass sitemapUrl explicitly.");
  return paths;
}

function pickSample(urls: string[], size: number, mode: "spaced" | "random" | "first"): string[] {
  if (urls.length <= size) return urls;
  if (mode === "first") return urls.slice(0, size);
  if (mode === "random") {
    const copy = [...urls];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = crypto.getRandomValues(new Uint32Array(1))[0]! % (index + 1);
      [copy[index], copy[swap]] = [copy[swap] as string, copy[index] as string];
    }
    return copy.slice(0, size);
  }
  const step = urls.length / size;
  return Array.from({ length: size }, (_, index) => urls[Math.floor(index * step)] as string);
}
