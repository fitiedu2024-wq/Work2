import { z } from "zod";
import { actionAnnotations, execute, readAnnotations } from "../shared/mcp";
import { gaProperty, type GaToolContext } from "./context";
import * as ga from "./ga-client";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const dateRangeSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  name: z.string().optional()
});
const resourceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const reportRequestSchema = z.object({
  dateRanges: z.array(dateRangeSchema).min(1).max(4),
  dimensions: z.array(z.string().min(1)).max(9).default([]),
  metrics: z.array(z.string().min(1)).min(1).max(10),
  dimensionFilter: jsonObjectSchema.optional(),
  metricFilter: jsonObjectSchema.optional(),
  orderBys: z.array(jsonObjectSchema).optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum 10,000 rows per call to protect Worker memory."),
  offset: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).optional(),
  keepEmptyRows: z.boolean().optional(),
  returnPropertyQuota: z.boolean().optional(),
  metricAggregations: z.array(z.enum(["TOTAL", "MINIMUM", "MAXIMUM", "COUNT"])).optional()
});

export function registerGaDataTools(context: GaToolContext): void {
  const { server, key, website, name, lock } = context;

  server.registerTool(
    name("get_metadata"),
    {
      title: "Get dimension and metric metadata",
      description: `List the dimensions and metrics this property supports (including custom ones) with API names, UI names, and categories. Use search/category to narrow the list before building run_report calls. ${lock}`,
      inputSchema: z.object({
        kind: z.enum(["all", "dimensions", "metrics"]).default("all"),
        search: z.string().max(100).optional().describe("Case-insensitive substring on API name, UI name, description, or category."),
        category: z.string().max(100).optional().describe('Exact category such as "Ecommerce", "Page / screen", "Traffic source".'),
        customOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100)
      }),
      annotations: readAnnotations
    },
    async (filter) => execute(() => ga.getMetadata(key, gaProperty(context), filter))
  );

  server.registerTool(
    name("check_compatibility"),
    {
      title: "Check dimension and metric compatibility",
      description: `Check whether a set of dimensions and metrics can be queried together before calling run_report. ${lock}`,
      inputSchema: z.object({
        dimensions: z.array(z.string().min(1)).max(9).default([]),
        metrics: z.array(z.string().min(1)).max(10).default([]),
        dimensionFilter: jsonObjectSchema.optional(),
        metricFilter: jsonObjectSchema.optional(),
        compatibilityFilter: z.enum(["COMPATIBLE", "INCOMPATIBLE"]).optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.checkCompatibility(key, gaProperty(context), input))
  );

  server.registerTool(
    name("run_report"),
    {
      title: "Run report",
      description: `Run a historical GA4 Data API report with any dimensions and metrics (see get_metadata for names). Returns the raw API response. ${lock}`,
      inputSchema: reportRequestSchema,
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.runReport(key, gaProperty(context), input))
  );

  server.registerTool(
    name("batch_run_reports"),
    {
      title: "Batch run reports",
      description: `Run up to 5 reports in one call (same property). Each request uses the run_report schema. ${lock}`,
      inputSchema: z.object({ requests: z.array(reportRequestSchema).min(1).max(5) }),
      annotations: readAnnotations
    },
    async ({ requests }) => execute(() => ga.batchRunReports(key, gaProperty(context), requests))
  );

  server.registerTool(
    name("run_pivot_report"),
    {
      title: "Run pivot report",
      description: `Cross-tab report (for example channel x device). Each pivot needs fieldNames plus limit; see the Data API Pivot object. ${lock}`,
      inputSchema: z.object({
        dateRanges: z.array(dateRangeSchema).min(1).max(4),
        dimensions: z.array(z.string().min(1)).min(1).max(9),
        metrics: z.array(z.string().min(1)).min(1).max(10),
        pivots: z.array(jsonObjectSchema).min(1).max(4),
        dimensionFilter: jsonObjectSchema.optional(),
        metricFilter: jsonObjectSchema.optional(),
        currencyCode: z.string().length(3).optional(),
        keepEmptyRows: z.boolean().optional(),
        returnPropertyQuota: z.boolean().optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.runPivotReport(key, gaProperty(context), input))
  );

  server.registerTool(
    name("run_realtime_report"),
    {
      title: "Run realtime report",
      description: `Activity in the last 30 minutes (60 for GA 360). Realtime-compatible fields only, e.g. activeUsers by country, deviceCategory, unifiedScreenName, eventName. ${lock}`,
      inputSchema: z.object({
        dimensions: z.array(z.string().min(1)).max(4).default([]),
        metrics: z.array(z.string().min(1)).min(1).max(4),
        dimensionFilter: jsonObjectSchema.optional(),
        metricFilter: jsonObjectSchema.optional(),
        orderBys: z.array(jsonObjectSchema).optional(),
        limit: z.number().int().positive().max(10_000).optional(),
        minuteRanges: z
          .array(z.object({ name: z.string().optional(), startMinutesAgo: z.number().int().min(0).max(59).optional(), endMinutesAgo: z.number().int().min(0).max(59).optional() }))
          .max(2)
          .optional(),
        returnPropertyQuota: z.boolean().optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.runRealtimeReport(key, gaProperty(context), input))
  );

  server.registerTool(
    name("run_funnel_report"),
    {
      title: "Run funnel report",
      description: `GA Data API v1alpha funnel report with custom steps. Each step needs an event name or a filterExpression. ${lock}`,
      inputSchema: z.object({
        funnelSteps: z
          .array(
            z.object({
              name: z.string().min(1),
              event: z.string().min(1).optional(),
              filterExpression: jsonObjectSchema.optional(),
              isDirectlyFollowedBy: z.boolean().optional(),
              withinDurationFromPriorStep: z.string().regex(/^\d+(?:\.\d+)?s$/).optional()
            })
          )
          .min(1)
          .max(10),
        dateRanges: z.array(dateRangeSchema).min(1).max(2).optional(),
        funnelBreakdown: jsonObjectSchema.optional(),
        funnelNextAction: jsonObjectSchema.optional(),
        funnelVisualizationType: z.enum(["STANDARD_FUNNEL", "TRENDED_FUNNEL"]).optional(),
        segments: z.array(jsonObjectSchema).max(4).optional(),
        limit: z.number().int().positive().max(10_000).optional(),
        dimensionFilter: jsonObjectSchema.optional(),
        returnPropertyQuota: z.boolean().optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.runFunnelReport(key, gaProperty(context), input))
  );

  server.registerTool(
    name("get_property_quotas"),
    {
      title: "Get Data API quota snapshot",
      description: `Remaining Data API tokens per day / hour / project for this property (v1alpha). ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.getPropertyQuotasSnapshot(key, gaProperty(context)))
  );

  // --- Audience exports -----------------------------------------------------

  server.registerTool(
    name("list_audience_exports"),
    {
      title: "List audience exports",
      description: `Audience exports created in the last 72 hours with their state. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.listAudienceExports(key, gaProperty(context)))
  );

  server.registerTool(
    name("get_audience_export"),
    {
      title: "Get audience export",
      description: `State, row count, and dimensions of one audience export. ${lock}`,
      inputSchema: z.object({ audienceExportId: resourceId }),
      annotations: readAnnotations
    },
    async ({ audienceExportId }) =>
      execute(() => ga.getAudienceExport(key, gaProperty(context), audienceExportId))
  );

  server.registerTool(
    name("create_audience_export"),
    {
      title: "Create audience export",
      description: `Start an export of an audience's users (deviceId, or pseudo IDs). Poll get_audience_export until ACTIVE, then query_audience_export. Spends quota; creates no configuration. ${lock}`,
      inputSchema: z.object({
        audienceId: resourceId,
        dimensions: z.array(z.string().min(1)).min(1).max(3).default(["deviceId"])
      }),
      annotations: actionAnnotations
    },
    async ({ audienceId, dimensions }) =>
      execute(() => ga.createAudienceExport(key, gaProperty(context), audienceId, dimensions))
  );

  server.registerTool(
    name("query_audience_export"),
    {
      title: "Query audience export",
      description: `Read the users of an ACTIVE audience export. Contains user identifiers; read only when the user asks for it. ${lock}`,
      inputSchema: z.object({
        audienceExportId: resourceId,
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(10_000).optional()
      }),
      annotations: readAnnotations
    },
    async ({ audienceExportId, offset, limit }) =>
      execute(() => ga.queryAudienceExport(key, gaProperty(context), audienceExportId, offset, limit))
  );

  // --- Universal scoped read ------------------------------------------------

  server.registerTool(
    name("ga_api_read"),
    {
      title: "Read any scoped Analytics API resource",
      description: `Universal read-only access to every current or future Admin API or Data API endpoint for this property (and its account when GA_ACCOUNT_ID is set). Path is the resource path without version, host, or query string, e.g. "properties/123/dataStreams" or "properties/123:runReport". GET for resources; POST only for report/query verbs. ${lock}`,
      inputSchema: z.object({
        api: z.enum(["admin", "data"]),
        version: z.enum(["v1beta", "v1alpha"]).default("v1beta"),
        method: z.enum(["GET", "POST"]).default("GET"),
        path: z.string().min(1).max(1000),
        query: jsonObjectSchema.default({}),
        body: jsonObjectSchema.default({})
      }),
      annotations: readAnnotations
    },
    async (input) =>
      execute(() => ga.gaApiRead(key, gaProperty(context), website.gaAccountId, input))
  );
}
