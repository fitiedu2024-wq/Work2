import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { execute, readAnnotations, toolNamer } from "../shared/mcp";
import { websiteFromEnv, type WebsiteConfig } from "../shared/website";
import type { GscToolContext } from "./context";
import { registerGscTools } from "./tools";

export function gscCapabilities(website: WebsiteConfig, prefix = "") {
  const n = toolNamer(prefix);
  return {
    product: "Google Search Console",
    brand: website.label,
    property: website.gscSiteUrl || website.siteUrl || null,
    performance: [
      n("get_top_queries"),
      n("get_top_pages"),
      n("get_query_page_pairs"),
      n("get_page_queries"),
      n("get_query_pages"),
      n("get_country_breakdown"),
      n("get_device_breakdown"),
      n("get_device_country_breakdown"),
      n("get_search_appearance_breakdown"),
      n("get_daily_trend"),
      n("get_hourly_performance"),
      n("get_discover_performance"),
      n("compare_periods")
    ],
    opportunities: [
      n("find_striking_distance_keywords"),
      n("find_ctr_opportunities"),
      n("find_query_cannibalization"),
      n("get_brand_vs_nonbrand")
    ],
    indexing: [n("inspect_url"), n("inspect_urls"), n("get_index_coverage_sample"), n("audit_sitemap"), n("find_orphan_pages")],
    sitemaps: [n("list_sitemaps"), n("get_sitemap"), n("submit_sitemap"), n("delete_sitemap")],
    raw: [n("search_analytics"), n("list_sites"), n("get_site_details"), n("gsc_api_read")],
    approvalRule:
      "submit_sitemap and delete_sitemap are the only writes; both are annotated destructive and take change_summary.",
    limits: [
      "Search Console data lags 2-3 days; end dates default to 3 days ago.",
      "URL inspection: 2,000 calls per day and 600 per minute per property.",
      "Crawl stats, Core Web Vitals, manual actions, and removals have no public API."
    ]
  };
}

export function registerGscToolSet(server: McpServer, env: Env, prefix = ""): GscToolContext {
  const website = websiteFromEnv(env);
  const context: GscToolContext = {
    server,
    key: env.GOOGLE_SERVICE_ACCOUNT_KEY,
    website,
    name: toolNamer(prefix),
    lock: `This Worker is permanently locked to ${website.label}.`
  };
  registerGscTools(context);
  return context;
}

export function createGscServer(env: Env): McpServer {
  const website = websiteFromEnv(env);
  const server = new McpServer({
    name: `Google Search Console MCP — ${website.label}`,
    version: "2.0.0"
  });
  registerGscToolSet(server, env);
  server.registerTool(
    "describe_capabilities",
    {
      title: "Describe this connector",
      description:
        "What this Search Console connector can do, its brand lock, quotas, and the approval rule for writes. Call first when unsure which tool to use.",
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => gscCapabilities(website))
  );
  return server;
}
