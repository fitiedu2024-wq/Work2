import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorToolResult, jsonToolResult } from "../shared/mcp";
import {
  requireGaProperty,
  websiteFromEnv,
  type WebsiteConfig
} from "../shared/website";
import * as ga from "./ga-client";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const dateRangeSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  name: z.string().optional()
});
const annotationDateSchema = z.object({
  year: z.number().int().min(1).max(9999),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31)
});
const annotationDateRangeSchema = z.object({
  startDate: annotationDateSchema,
  endDate: annotationDateSchema
});
const annotationColorSchema = z.enum([
  "PURPLE",
  "BROWN",
  "BLUE",
  "GREEN",
  "RED",
  "CYAN"
]);
const annotationTargetSchema = z
  .object({
    annotationDate: annotationDateSchema.optional(),
    annotationDateRange: annotationDateRangeSchema.optional()
  })
  .refine(
    ({ annotationDate, annotationDateRange }) =>
      Number(annotationDate !== undefined) +
        Number(annotationDateRange !== undefined) ===
      1,
    { message: "Provide exactly one of annotationDate or annotationDateRange." }
  );
const annotationCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    description: z.string().max(150).optional(),
    color: annotationColorSchema
  })
  .and(annotationTargetSchema);
const annotationUpdatesSchema = z
  .object({
    title: z.string().trim().min(1).max(60).optional(),
    description: z.string().max(150).optional(),
    color: annotationColorSchema.optional(),
    annotationDate: annotationDateSchema.optional(),
    annotationDateRange: annotationDateRangeSchema.optional()
  })
  .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
    message: "Provide at least one annotation field to update."
  })
  .refine(
    ({ annotationDate, annotationDateRange }) =>
      !(annotationDate && annotationDateRange),
    { message: "Do not provide both annotationDate and annotationDateRange." }
  );

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

function filterAccountSummaries(
  result: Record<string, unknown>,
  website: WebsiteConfig
): Record<string, unknown> {
  if (!website.gaAccountId && !website.gaPropertyId) {
    throw new Error(
      `Worker "${website.slug}" has no GA_ACCOUNT_ID or GA_PROPERTY_ID configured.`
    );
  }
  const summaries = Array.isArray(result.accountSummaries)
    ? result.accountSummaries
    : [];
  const filtered = summaries.flatMap((summary) => {
    const account = asRecord(summary);
    if (!account) return [];
    if (
      website.gaAccountId &&
      account.account !== `accounts/${website.gaAccountId}`
    ) {
      return [];
    }
    const properties = Array.isArray(account.propertySummaries)
      ? website.gaPropertyId
        ? account.propertySummaries.filter((candidate) => {
            const item = asRecord(candidate);
            return item?.property === requireGaProperty(website);
          })
        : account.propertySummaries
      : [];
    return properties.length ? [{ ...account, propertySummaries: properties }] : [];
  });

  if (!filtered.length) {
    throw new Error(
      `The configured GA account/property for "${website.label}" is not visible to the service account. Grant it GA Editor access and verify the Wrangler environment IDs.`
    );
  }
  return { accountSummaries: filtered };
}

export function createGaServer(env: Env): McpServer {
  const website = websiteFromEnv(env);
  const server = new McpServer({
    name: `Google Analytics MCP — ${website.label}`,
    version: "1.0.0"
  });
  const key = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const scopeDescription = `This Worker is permanently locked to ${website.label}.`;

  server.registerTool(
    "get_account_summaries",
    {
      description: `List accessible GA accounts and properties. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(async () => {
        const result = await ga.getAccountSummaries(key);
        return filterAccountSummaries(result, website);
      })
  );

  server.registerTool(
    "get_property_details",
    {
      description: `Get GA4 property configuration details. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(() => ga.getPropertyDetails(key, requireGaProperty(website)))
  );

  server.registerTool(
    "list_google_ads_links",
    {
      description: `List Google Ads accounts linked to a GA4 property. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(() => ga.listGoogleAdsLinks(key, requireGaProperty(website)))
  );

  server.registerTool(
    "get_custom_dimensions_and_metrics",
    {
      description: `List custom dimension and metric definitions. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(() =>
        ga.getCustomDimensionsAndMetrics(key, requireGaProperty(website))
      )
  );

  server.registerTool(
    "list_property_annotations",
    {
      description: `List GA reporting data annotations and their IDs. ${scopeDescription}`,
      inputSchema: {}
    },
    async () =>
      execute(() =>
        ga.listPropertyAnnotations(key, requireGaProperty(website))
      )
  );

  server.registerTool(
    "create_property_annotation",
    {
      description:
        `Create a dated GA reporting annotation. Orange is reserved by Google and is not accepted. ${scopeDescription}`,
      inputSchema: {
        annotation: annotationCreateSchema
      }
    },
    async ({ annotation }) =>
      execute(() =>
        ga.createPropertyAnnotation(
          key,
          requireGaProperty(website),
          annotation
        )
      )
  );

  server.registerTool(
    "update_property_annotation",
    {
      description:
        `Update selected fields on a user-created GA reporting annotation. System-generated annotations cannot be changed. ${scopeDescription}`,
      inputSchema: {
        annotationId: z.string().regex(/^\d+$/),
        updates: annotationUpdatesSchema
      }
    },
    async ({ annotationId, updates }) =>
      execute(() =>
        ga.updatePropertyAnnotation(
          key,
          requireGaProperty(website),
          annotationId,
          updates
        )
      )
  );

  server.registerTool(
    "delete_property_annotation",
    {
      description:
        `Permanently delete a user-created GA reporting annotation. System-generated annotations cannot be deleted. ${scopeDescription}`,
      inputSchema: {
        annotationId: z.string().regex(/^\d+$/),
        confirm: z
          .literal(true)
          .describe("Must be true to confirm permanent deletion.")
      }
    },
    async ({ annotationId }) =>
      execute(() =>
        ga.deletePropertyAnnotation(
          key,
          requireGaProperty(website),
          annotationId
        )
      )
  );

  server.registerTool(
    "run_report",
    {
      description:
        `Run a historical GA4 Data API report. Names are GA API dimension/metric names. ${scopeDescription}`,
      inputSchema: {
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
        returnPropertyQuota: z.boolean().optional()
      }
    },
    async (input) =>
      execute(() => ga.runReport(key, requireGaProperty(website), input))
  );

  server.registerTool(
    "run_realtime_report",
    {
      description:
        `Run a GA4 realtime report for recent activity. Use realtime-compatible fields. ${scopeDescription}`,
      inputSchema: {
        dimensions: z.array(z.string().min(1)).max(4).default([]),
        metrics: z.array(z.string().min(1)).min(1).max(4),
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
        returnPropertyQuota: z.boolean().optional()
      }
    },
    async (input) =>
      execute(() =>
        ga.runRealtimeReport(key, requireGaProperty(website), input)
      )
  );

  server.registerTool(
    "run_funnel_report",
    {
      description:
        `Run the GA Data API v1alpha funnel report. This Google endpoint remains alpha. ${scopeDescription}`,
      inputSchema: {
        funnelSteps: z
          .array(
            z.object({
              name: z.string().min(1),
              event: z.string().min(1).optional(),
              filterExpression: jsonObjectSchema.optional(),
              isDirectlyFollowedBy: z.boolean().optional(),
              withinDurationFromPriorStep: z
                .string()
                .regex(/^\d+(?:\.\d+)?s$/)
                .optional()
            })
          )
          .min(1)
          .max(10),
        dateRanges: z.array(dateRangeSchema).min(1).max(2).optional(),
        funnelBreakdown: jsonObjectSchema.optional(),
        funnelNextAction: jsonObjectSchema.optional(),
        funnelVisualizationType: z
          .enum(["STANDARD_FUNNEL", "TRENDED_FUNNEL"])
          .optional(),
        segments: z.array(jsonObjectSchema).max(4).optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Maximum 10,000 rows per call to protect Worker memory."),
        dimensionFilter: jsonObjectSchema.optional(),
        returnPropertyQuota: z.boolean().optional()
      }
    },
    async (input) =>
      execute(() =>
        ga.runFunnelReport(key, requireGaProperty(website), input)
      )
  );

  return server;
}
