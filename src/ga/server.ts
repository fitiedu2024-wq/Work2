import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { execute, readAnnotations, toolNamer } from "../shared/mcp";
import { websiteFromEnv, type WebsiteConfig } from "../shared/website";
import type { GaToolContext } from "./context";
import { SHAPED_REPORT_NAMES } from "./report-shaping";
import { registerGaConfigTools } from "./tools-config";
import { registerGaDataTools } from "./tools-data";
import { registerGaReportTools } from "./tools-reports";

export function gaCapabilities(website: WebsiteConfig, prefix = "") {
  const n = toolNamer(prefix);
  return {
    product: "Google Analytics 4",
    brand: website.label,
    property: website.gaPropertyId ? `properties/${website.gaPropertyId}` : null,
    discovery: [n("get_metadata"), n("check_compatibility"), n("get_account_summaries"), n("get_property_details")],
    shapedReports: SHAPED_REPORT_NAMES.map((report) => n(`get_${report}`)),
    comparisons: [n("compare_periods")],
    funnelsAndRealtime: [n("get_checkout_funnel"), n("get_realtime_overview")],
    rawReports: [n("run_report"), n("batch_run_reports"), n("run_pivot_report"), n("run_realtime_report"), n("run_funnel_report")],
    configuration:
      "data streams, key events, audiences, channel groups, custom definitions, links (Ads, Firebase, BigQuery, SA360, DV360, AdSense), retention, attribution, signals, access bindings",
    audit: [n("run_access_report"), n("search_change_history")],
    writes: [
      n("create_key_event"),
      n("update_key_event"),
      n("delete_key_event"),
      n("create_custom_dimension"),
      n("create_custom_metric"),
      n("archive_custom_definition"),
      n("create_property_annotation"),
      n("update_property_annotation"),
      n("delete_property_annotation")
    ],
    universal: n("ga_api_read"),
    approvalRule:
      "Every write tool is annotated destructive and takes change_summary, so the MCP client asks for approval before running it.",
    notes: [
      "Dates accept YYYY-MM-DD, today, yesterday, or NdaysAgo.",
      "Shaped reports return compact tables; raw run_* tools return the Google response unchanged.",
      "Measurement Protocol secrets are deliberately not exposed."
    ]
  };
}

export function registerGaTools(server: McpServer, env: Env, prefix = ""): GaToolContext {
  const website = websiteFromEnv(env);
  const context: GaToolContext = {
    server,
    key: env.GOOGLE_SERVICE_ACCOUNT_KEY,
    website,
    name: toolNamer(prefix),
    lock: `This Worker is permanently locked to ${website.label}.`
  };
  registerGaConfigTools(context);
  registerGaDataTools(context);
  registerGaReportTools(context);
  return context;
}

export function createGaServer(env: Env): McpServer {
  const website = websiteFromEnv(env);
  const server = new McpServer({
    name: `Google Analytics MCP — ${website.label}`,
    version: "2.0.0"
  });
  registerGaTools(server, env);
  server.registerTool(
    "describe_capabilities",
    {
      title: "Describe this connector",
      description: `What this Google Analytics connector can do, its brand lock, and the approval rule for writes. Call first when unsure which tool to use.`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => gaCapabilities(website))
  );
  return server;
}
