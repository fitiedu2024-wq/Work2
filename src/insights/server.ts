import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GaToolContext } from "../ga/context";
import { gaProperty } from "../ga/context";
import * as ga from "../ga/ga-client";
import {
  buildShapedReport,
  GA_DATE_PATTERN,
  ORGANIC_SEARCH_FILTER,
  simplifyReport,
  type SimplifiedRow
} from "../ga/report-shaping";
import { gaCapabilities, registerGaTools } from "../ga/server";
import {
  compareSearchRows,
  flattenSearchRows,
  GSC_DATE_PATTERN,
  totals,
  urlToPath,
  type SearchRow
} from "../gsc/analytics-shaping";
import type { GscToolContext } from "../gsc/context";
import { gscSite } from "../gsc/context";
import * as gsc from "../gsc/gsc-client";
import { gscCapabilities, registerGscToolSet } from "../gsc/server";
import { execute, readAnnotations, writeAnnotations } from "../shared/mcp";
import { websiteFromEnv } from "../shared/website";

export const GA_PREFIX = "ga_";
export const GSC_PREFIX = "gsc_";

const isoDate = z.string().regex(GSC_DATE_PATTERN, "Use YYYY-MM-DD.");

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function previousRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  const lengthDays = Math.round((end - start) / 86_400_000) + 1;
  const previousEnd = new Date(start - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (lengthDays - 1) * 86_400_000);
  return { startDate: previousStart.toISOString().slice(0, 10), endDate: previousEnd.toISOString().slice(0, 10) };
}

type Range = { startDate: string; endDate: string };

function resolveRange(input: { startDate?: string | undefined; endDate?: string | undefined }): Range {
  const endDate = input.endDate ?? isoDaysAgo(3);
  const startDate = input.startDate ?? isoDaysAgo(30);
  if (!GA_DATE_PATTERN.test(startDate) || !GA_DATE_PATTERN.test(endDate)) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  if (startDate > endDate) throw new Error("startDate must not be after endDate.");
  return { startDate, endDate };
}

/** GA landing-page metrics for organic-search sessions, keyed by path. */
async function gaOrganicLandingPages(
  context: GaToolContext,
  range: Range,
  limit: number
): Promise<Map<string, SimplifiedRow>> {
  const request = buildShapedReport("landing_pages", {
    ...range,
    limit,
    descending: true,
    organicOnly: true
  });
  const response = await ga.runReport(context.key, gaProperty(context), request);
  const simplified = simplifyReport(response);
  const byPath = new Map<string, SimplifiedRow>();
  for (const row of simplified.rows) {
    const path = String(row.landingPage ?? "");
    if (path && path !== "(not set)") byPath.set(normalizePath(path), row);
  }
  return byPath;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
}

async function gscPages(context: GscToolContext, range: Range, rowLimit: number): Promise<SearchRow[]> {
  const response = await gsc.searchAnalytics(context.key, gscSite(context), {
    ...range,
    dimensions: ["page"],
    rowLimit
  });
  return flattenSearchRows(response, ["page"]);
}

async function gaOrganicTotals(context: GaToolContext, range: Range): Promise<SimplifiedRow> {
  const response = await ga.runReport(context.key, gaProperty(context), {
    dateRanges: [range],
    dimensions: [],
    metrics: [
      "sessions",
      "totalUsers",
      "newUsers",
      "engagementRate",
      "keyEvents",
      "sessionKeyEventRate",
      "ecommercePurchases",
      "purchaseRevenue"
    ],
    dimensionFilter: ORGANIC_SEARCH_FILTER
  });
  return simplifyReport(response).rows[0] ?? {};
}

function registerCrossSourceTools(server: McpServer, gaContext: GaToolContext, gscContext: GscToolContext): void {
  const lock = gaContext.lock;

  server.registerTool(
    "get_organic_overview",
    {
      title: "Organic search overview (GSC + GA)",
      description: `One-call SEO dashboard: Search Console clicks, impressions, CTR, and position next to GA organic sessions, engagement, key events, purchases, and revenue, each compared with the previous period. ${lock}`,
      inputSchema: z.object({
        startDate: isoDate.optional().describe("Defaults to 30 days ago."),
        endDate: isoDate.optional().describe("Defaults to 3 days ago.")
      }),
      annotations: readAnnotations
    },
    async (input) =>
      execute(async () => {
        const current = resolveRange(input);
        const previous = previousRange(current.startDate, current.endDate);
        const [gscCurrent, gscPrevious, gaCurrent, gaPrevious] = await Promise.all([
          gsc.searchAnalytics(gscContext.key, gscSite(gscContext), { ...current, dimensions: [] }),
          gsc.searchAnalytics(gscContext.key, gscSite(gscContext), { ...previous, dimensions: [] }),
          gaOrganicTotals(gaContext, current),
          gaOrganicTotals(gaContext, previous)
        ]);
        const searchNow = totals(flattenSearchRows(gscCurrent, []));
        const searchBefore = totals(flattenSearchRows(gscPrevious, []));
        const gaDelta: Record<string, { current: number; previous: number; deltaPercent: number | "new" }> = {};
        for (const metric of Object.keys(gaCurrent)) {
          const now = Number(gaCurrent[metric] ?? 0);
          const before = Number(gaPrevious[metric] ?? 0);
          gaDelta[metric] = {
            current: now,
            previous: before,
            deltaPercent: before === 0 ? (now === 0 ? 0 : "new") : Number((((now - before) / before) * 100).toFixed(2))
          };
        }
        return {
          current,
          previous,
          searchConsole: compareSearchRows([searchNow], [searchBefore], [], "clicks", 1, "absolute").totals,
          analyticsOrganic: gaDelta,
          derived: {
            revenuePerOrganicClick: searchNow.clicks
              ? Number((Number(gaCurrent.purchaseRevenue ?? 0) / searchNow.clicks).toFixed(2))
              : null,
            clickToSessionRatio: searchNow.clicks
              ? Number((Number(gaCurrent.sessions ?? 0) / searchNow.clicks).toFixed(2))
              : null
          }
        };
      })
  );

  server.registerTool(
    "get_landing_page_seo_overview",
    {
      title: "Landing page SEO overview (GSC + GA)",
      description: `Joins Search Console page performance (clicks, impressions, CTR, position) with GA organic landing-page outcomes (sessions, engagement, key events, revenue) by URL path. Sort by any of these to find pages with traffic but no revenue, or revenue but weak rankings. ${lock}`,
      inputSchema: z.object({
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        sortBy: z
          .enum(["clicks", "impressions", "position", "sessions", "keyEvents", "purchaseRevenue", "revenuePerClick"])
          .default("clicks"),
        limit: z.number().int().min(1).max(500).default(25),
        pathContains: z.string().max(200).optional()
      }),
      annotations: readAnnotations
    },
    async ({ sortBy, limit, pathContains, ...input }) =>
      execute(async () => {
        const range = resolveRange(input);
        const [pages, landing] = await Promise.all([
          gscPages(gscContext, range, 5000),
          gaOrganicLandingPages(gaContext, range, 5000)
        ]);
        const rows = pages
          .map((page) => {
            const path = normalizePath(urlToPath(String(page.page ?? "")));
            const analytics = landing.get(path);
            const revenue = Number(analytics?.purchaseRevenue ?? 0);
            return {
              page: String(page.page ?? ""),
              path,
              clicks: page.clicks,
              impressions: page.impressions,
              ctr: page.ctr,
              position: page.position,
              sessions: Number(analytics?.sessions ?? 0),
              engagementRate: analytics?.engagementRate ?? null,
              keyEvents: Number(analytics?.keyEvents ?? 0),
              purchaseRevenue: revenue,
              revenuePerClick: page.clicks ? Number((revenue / page.clicks).toFixed(2)) : 0,
              matchedInAnalytics: Boolean(analytics)
            };
          })
          .filter((row) => !pathContains || row.path.includes(pathContains.toLowerCase()));
        const direction = sortBy === "position" ? 1 : -1;
        rows.sort((a, b) => (Number(a[sortBy]) - Number(b[sortBy])) * direction);
        const unmatched = rows.filter((row) => !row.matchedInAnalytics).length;
        return {
          dateRange: range,
          pagesFromSearch: pages.length,
          landingPagesFromAnalytics: landing.size,
          unmatchedPages: unmatched,
          note: "Join key is the URL path; GA landingPage drops query strings and may report (not set) for some sessions.",
          rows: rows.slice(0, limit)
        };
      })
  );

  server.registerTool(
    "find_pages_losing_organic_traffic",
    {
      title: "Pages losing organic traffic (GSC + GA)",
      description: `Pages whose Search Console clicks fell versus the previous period, with GA organic sessions and revenue for both periods so you can see the business impact. ${lock}`,
      inputSchema: z.object({
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        minPreviousClicks: z.number().int().min(0).default(20),
        limit: z.number().int().min(1).max(200).default(25)
      }),
      annotations: readAnnotations
    },
    async ({ minPreviousClicks, limit, ...input }) =>
      execute(async () => {
        const current = resolveRange(input);
        const previous = previousRange(current.startDate, current.endDate);
        const [pagesNow, pagesBefore, landingNow, landingBefore] = await Promise.all([
          gscPages(gscContext, current, 5000),
          gscPages(gscContext, previous, 5000),
          gaOrganicLandingPages(gaContext, current, 5000),
          gaOrganicLandingPages(gaContext, previous, 5000)
        ]);
        const comparison = compareSearchRows(pagesNow, pagesBefore, ["page"], "clicks", 100_000, "losers");
        const rows = comparison.rows
          .filter((row) => row.previous.clicks >= minPreviousClicks && row.delta.clicks < 0)
          .slice(0, limit)
          .map((row) => {
            const path = normalizePath(urlToPath(row.key.page ?? ""));
            const now = landingNow.get(path);
            const before = landingBefore.get(path);
            return {
              page: row.key.page,
              search: { current: row.current, previous: row.previous, delta: row.delta, deltaPercent: row.deltaPercent },
              analyticsOrganic: {
                sessions: { current: Number(now?.sessions ?? 0), previous: Number(before?.sessions ?? 0) },
                keyEvents: { current: Number(now?.keyEvents ?? 0), previous: Number(before?.keyEvents ?? 0) },
                purchaseRevenue: {
                  current: Number(now?.purchaseRevenue ?? 0),
                  previous: Number(before?.purchaseRevenue ?? 0)
                }
              }
            };
          });
        return { current, previous, totals: comparison.totals, rows };
      })
  );

  server.registerTool(
    "get_query_to_revenue",
    {
      title: "Query to revenue (GSC + GA)",
      description: `Estimates revenue per search query: takes query/page click pairs from Search Console and distributes each landing page's GA organic revenue across its queries in proportion to clicks. An estimate, not attribution. ${lock}`,
      inputSchema: z.object({
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        limit: z.number().int().min(1).max(500).default(50),
        minClicks: z.number().int().min(1).default(5)
      }),
      annotations: readAnnotations
    },
    async ({ limit, minClicks, ...input }) =>
      execute(async () => {
        const range = resolveRange(input);
        const [pairsResponse, landing] = await Promise.all([
          gsc.searchAnalytics(gscContext.key, gscSite(gscContext), {
            ...range,
            dimensions: ["query", "page"],
            rowLimit: 25_000
          }),
          gaOrganicLandingPages(gaContext, range, 5000)
        ]);
        const pairs = flattenSearchRows(pairsResponse, ["query", "page"]).filter((row) => row.clicks >= minClicks);
        const clicksPerPage = new Map<string, number>();
        for (const pair of pairs) {
          const path = normalizePath(urlToPath(String(pair.page ?? "")));
          clicksPerPage.set(path, (clicksPerPage.get(path) ?? 0) + pair.clicks);
        }
        const perQuery = new Map<string, { clicks: number; impressions: number; estimatedRevenue: number; estimatedKeyEvents: number; pages: Set<string> }>();
        for (const pair of pairs) {
          const path = normalizePath(urlToPath(String(pair.page ?? "")));
          const analytics = landing.get(path);
          const pageClicks = clicksPerPage.get(path) ?? 0;
          const share = pageClicks ? pair.clicks / pageClicks : 0;
          const query = String(pair.query ?? "");
          const entry = perQuery.get(query) ?? { clicks: 0, impressions: 0, estimatedRevenue: 0, estimatedKeyEvents: 0, pages: new Set<string>() };
          entry.clicks += pair.clicks;
          entry.impressions += pair.impressions;
          entry.estimatedRevenue += share * Number(analytics?.purchaseRevenue ?? 0);
          entry.estimatedKeyEvents += share * Number(analytics?.keyEvents ?? 0);
          entry.pages.add(path);
          perQuery.set(query, entry);
        }
        const rows = [...perQuery.entries()]
          .map(([query, entry]) => ({
            query,
            clicks: entry.clicks,
            impressions: entry.impressions,
            estimatedRevenue: Number(entry.estimatedRevenue.toFixed(2)),
            estimatedKeyEvents: Number(entry.estimatedKeyEvents.toFixed(1)),
            revenuePerClick: entry.clicks ? Number((entry.estimatedRevenue / entry.clicks).toFixed(2)) : 0,
            pages: [...entry.pages]
          }))
          .sort((a, b) => b.estimatedRevenue - a.estimatedRevenue)
          .slice(0, limit);
        return { dateRange: range, queriesAnalysed: perQuery.size, rows };
      })
  );

  server.registerTool(
    "annotate_seo_event",
    {
      title: "Annotate an SEO event in GA",
      description: `Create a dated GA reporting annotation for an SEO change (sitemap resubmitted, content updated, algorithm update, indexing drop) so analysts see it on charts. Requires approval. ${lock}`,
      inputSchema: z.object({
        title: z.string().trim().min(1).max(60),
        date: isoDate,
        endDate: isoDate.optional().describe("Makes the annotation a date range."),
        description: z.string().max(150).optional(),
        color: z.enum(["PURPLE", "BROWN", "BLUE", "GREEN", "RED", "CYAN"]).default("BLUE"),
        change_summary: z.string().min(5).max(500)
      }),
      annotations: writeAnnotations
    },
    async ({ title, date, endDate, description, color }) =>
      execute(() => {
        const toParts = (value: string) => {
          const [year, month, day] = value.split("-").map(Number);
          return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
        };
        return ga.createPropertyAnnotation(gaContext.key, gaProperty(gaContext), {
          title,
          description,
          color,
          ...(endDate
            ? { annotationDateRange: { startDate: toParts(date), endDate: toParts(endDate) } }
            : { annotationDate: toParts(date) })
        });
      })
  );
}

/** One MCP server per brand with GA (ga_*), GSC (gsc_*), and cross-source tools. */
export function createInsightsServer(env: Env): McpServer {
  const website = websiteFromEnv(env);
  const server = new McpServer({
    name: `Google Insights MCP — ${website.label}`,
    version: "2.0.0"
  });
  const gaContext = registerGaTools(server, env, GA_PREFIX);
  const gscContext = registerGscToolSet(server, env, GSC_PREFIX);
  registerCrossSourceTools(server, gaContext, gscContext);
  server.registerTool(
    "describe_capabilities",
    {
      title: "Describe this connector",
      description:
        "What this combined Analytics + Search Console connector can do, its brand lock, and the approval rule for writes. Call first when unsure which tool to use.",
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () =>
      execute(() => ({
        brand: website.label,
        site: website.siteUrl,
        crossSource: [
          "get_organic_overview",
          "get_landing_page_seo_overview",
          "find_pages_losing_organic_traffic",
          "get_query_to_revenue",
          "annotate_seo_event"
        ],
        analytics: gaCapabilities(website, GA_PREFIX),
        searchConsole: gscCapabilities(website, GSC_PREFIX)
      }))
  );
  return server;
}
