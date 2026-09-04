import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorToolResult, jsonToolResult } from "../shared/mcp";
import { assertUrlBelongsToGscProperty } from "../shared/scope";
import { requireGscProperty, websiteFromEnv } from "../shared/website";
import * as gsc from "./gsc-client";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const jsonObjectSchema = z.record(z.string(), z.unknown());

async function execute(operation: () => Promise<unknown>) {
  try {
    return jsonToolResult(await operation());
  } catch (error) {
    return errorToolResult(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function filterSites(
  result: Record<string, unknown>,
  siteUrl: string
): Record<string, unknown> {
  const entries = Array.isArray(result.siteEntry) ? result.siteEntry : [];
  const filtered = entries.filter((entry) => asRecord(entry)?.siteUrl === siteUrl);
  if (!filtered.length) {
    throw new Error(
      `Configured Search Console property "${siteUrl}" is not visible to the service account. Add the service account as a Full user.`
    );
  }
  return { siteEntry: filtered };
}

export function createGscServer(env: Env): McpServer {
  const website = websiteFromEnv(env);
  const server = new McpServer({
    name: `Google Search Console MCP — ${website.label}`,
    version: "1.0.0"
  });
  const key = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const scopeDescription = `This Worker is permanently locked to ${website.label}.`;

  server.registerTool(
    "list_sites",
    {
      description: `List Search Console properties available to the service account. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(async () => {
        const result = await gsc.listSites(key);
        return filterSites(result, requireGscProperty(website));
      })
  );

  server.registerTool(
    "search_analytics",
    {
      description:
        `Query Search Console clicks, impressions, CTR, and average position. ${scopeDescription}`,
      inputSchema: {
        startDate: dateSchema,
        endDate: dateSchema,
        dimensions: z
          .array(
            z.enum([
              "query",
              "page",
              "country",
              "device",
              "date",
              "hour",
              "searchAppearance"
            ])
          )
          .optional(),
        type: z
          .enum(["web", "image", "video", "news", "discover", "googleNews"])
          .optional(),
        dataState: z.enum(["final", "all", "hourly_all"]).optional(),
        aggregationType: z
          .enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"])
          .optional(),
        dimensionFilterGroups: z.array(jsonObjectSchema).optional(),
        rowLimit: z.number().int().min(1).max(25_000).optional(),
        startRow: z.number().int().nonnegative().optional()
      }
    },
    async (input) =>
      execute(() =>
        gsc.searchAnalytics(key, requireGscProperty(website), input)
      )
  );

  server.registerTool(
    "inspect_url",
    {
      description:
        `Inspect the indexed version of a URL and return coverage, canonical, robots, rich-results, and crawl details. ${scopeDescription}`,
      inputSchema: {
        inspectionUrl: z.string().url(),
        languageCode: z
          .string()
          .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
          .optional()
      }
    },
    async ({ inspectionUrl, languageCode }) =>
      execute(() => {
        const property = requireGscProperty(website);
        return gsc.inspectUrl(
          key,
          property,
          assertUrlBelongsToGscProperty(inspectionUrl, property, "inspectionUrl"),
          languageCode
        );
      })
  );

  server.registerTool(
    "list_sitemaps",
    {
      description: `List submitted sitemaps for a Search Console property. ${scopeDescription}`,
      inputSchema: {
        sitemapIndex: z.string().url().optional()
      }
    },
    async ({ sitemapIndex }) =>
      execute(() => {
        const property = requireGscProperty(website);
        return gsc.listSitemaps(
          key,
          property,
          sitemapIndex
            ? assertUrlBelongsToGscProperty(
                sitemapIndex,
                property,
                "sitemapIndex"
              )
            : undefined
        );
      })
  );

  server.registerTool(
    "get_sitemap",
    {
      description: `Get details for one submitted sitemap. ${scopeDescription}`,
      inputSchema: {
        feedpath: z.string().url().describe("The full sitemap URL.")
      }
    },
    async ({ feedpath }) =>
      execute(() => {
        const property = requireGscProperty(website);
        return gsc.getSitemap(
          key,
          property,
          assertUrlBelongsToGscProperty(feedpath, property, "feedpath")
        );
      })
  );

  server.registerTool(
    "submit_sitemap",
    {
      description:
        `Submit or resubmit a sitemap to Google Search Console. ${scopeDescription}`,
      inputSchema: {
        feedpath: z.string().url().describe("The full sitemap URL.")
      }
    },
    async ({ feedpath }) =>
      execute(() => {
        const property = requireGscProperty(website);
        return gsc.submitSitemap(
          key,
          property,
          assertUrlBelongsToGscProperty(feedpath, property, "feedpath")
        );
      })
  );

  server.registerTool(
    "delete_sitemap",
    {
      description:
        `Remove a submitted sitemap from Google Search Console. This does not delete the sitemap file. ${scopeDescription}`,
      inputSchema: {
        feedpath: z.string().url().describe("The full sitemap URL."),
        confirm: z
          .literal(true)
          .describe("Must be true to confirm removing the sitemap submission.")
      }
    },
    async ({ feedpath }) =>
      execute(() => {
        const property = requireGscProperty(website);
        return gsc.deleteSitemap(
          key,
          property,
          assertUrlBelongsToGscProperty(feedpath, property, "feedpath")
        );
      })
  );

  return server;
}
