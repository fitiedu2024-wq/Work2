import { z } from "zod";
import { execute, readAnnotations } from "../shared/mcp";
import { gaProperty, type GaToolContext } from "./context";
import * as ga from "./ga-client";
import {
  buildShapedReport,
  comparePeriods,
  DEFAULT_CHECKOUT_FUNNEL,
  GA_DATE_PATTERN,
  REALTIME_BREAKDOWN_NAMES,
  REALTIME_BREAKDOWNS,
  SHAPED_REPORT_NAMES,
  SHAPED_REPORTS,
  simplifyReport,
  type ShapedReportName
} from "./report-shaping";

const gaDate = z
  .string()
  .regex(GA_DATE_PATTERN, "Use YYYY-MM-DD, today, yesterday, or NdaysAgo.");
const jsonObjectSchema = z.record(z.string(), z.unknown());

const commonReportInput = {
  startDate: gaDate.default("28daysAgo"),
  endDate: gaDate.default("yesterday"),
  limit: z.number().int().min(1).max(1000).default(25),
  orderBy: z.string().max(60).optional().describe("Dimension or metric name from this report to sort by."),
  descending: z.boolean().default(true),
  organicOnly: z.boolean().default(false).describe("Restrict to sessions from the Organic Search channel."),
  dimensionFilter: jsonObjectSchema.optional().describe("Extra GA FilterExpression combined with AND."),
  compareStartDate: gaDate.optional().describe("With compareEndDate, adds a previous period and returns deltas."),
  compareEndDate: gaDate.optional()
};

export async function runShapedReport(
  context: GaToolContext,
  report: ShapedReportName,
  options: z.infer<z.ZodObject<typeof commonReportInput>> & { breakdown?: string | undefined }
): Promise<Record<string, unknown>> {
  const request = buildShapedReport(report, options);
  const response = await ga.runReport(context.key, gaProperty(context), request);
  const query = {
    report,
    breakdown: options.breakdown ?? Object.keys(SHAPED_REPORTS[report].breakdowns)[0],
    dimensions: request.dimensions,
    metrics: request.metrics,
    dateRanges: request.dateRanges,
    dimensionFilter: request.dimensionFilter
  };
  if (request.dateRanges.length === 2) {
    return { query, comparison: comparePeriods(response) };
  }
  return { query, result: simplifyReport(response) };
}

export function registerGaReportTools(context: GaToolContext): void {
  const { server, key, name, lock } = context;

  for (const report of SHAPED_REPORT_NAMES) {
    const definition = SHAPED_REPORTS[report];
    const breakdownNames = Object.keys(definition.breakdowns) as [string, ...string[]];
    server.registerTool(
      name(`get_${report}`),
      {
        title: definition.title,
        description: `${definition.description} Metrics: ${definition.metrics.join(", ")}. Returns a compact table; pass compare dates for period-over-period deltas. ${lock}`,
        inputSchema: z.object({
          breakdown: z.enum(breakdownNames).default(breakdownNames[0]),
          ...commonReportInput
        }),
        annotations: readAnnotations
      },
      async (input) => execute(() => runShapedReport(context, report, input))
    );
  }

  server.registerTool(
    name("compare_periods"),
    {
      title: "Compare two periods",
      description: `Run any shaped report for a current and a previous period and return per-row and total deltas. Reports: ${SHAPED_REPORT_NAMES.join(", ")}. ${lock}`,
      inputSchema: z.object({
        report: z.enum(SHAPED_REPORT_NAMES),
        breakdown: z.string().max(40).optional(),
        startDate: gaDate,
        endDate: gaDate,
        compareStartDate: gaDate,
        compareEndDate: gaDate,
        limit: z.number().int().min(1).max(1000).default(25),
        orderBy: z.string().max(60).optional(),
        descending: z.boolean().default(true),
        organicOnly: z.boolean().default(false),
        dimensionFilter: jsonObjectSchema.optional()
      }),
      annotations: readAnnotations
    },
    async ({ report, ...input }) => execute(() => runShapedReport(context, report, input))
  );

  server.registerTool(
    name("get_checkout_funnel"),
    {
      title: "Checkout funnel",
      description: `Closed funnel view_item -> add_to_cart -> begin_checkout -> add_shipping_info -> add_payment_info -> purchase with completion and abandonment per step. Override steps to change the journey; add a breakdown dimension (deviceCategory, sessionDefaultChannelGroup, country) to segment. ${lock}`,
      inputSchema: z.object({
        startDate: gaDate.default("28daysAgo"),
        endDate: gaDate.default("yesterday"),
        steps: z
          .array(z.object({ name: z.string().min(1).max(60), event: z.string().min(1).max(40) }))
          .min(2)
          .max(10)
          .default([...DEFAULT_CHECKOUT_FUNNEL]),
        breakdownDimension: z.string().max(60).optional(),
        breakdownLimit: z.number().int().min(1).max(15).default(5),
        openFunnel: z.boolean().default(false).describe("Open funnels let users enter at any step."),
        trended: z.boolean().default(false).describe("Return the funnel per day instead of totals.")
      }),
      annotations: readAnnotations
    },
    async ({ startDate, endDate, steps, breakdownDimension, breakdownLimit, openFunnel, trended }) =>
      execute(async () => {
        const response = await ga.runFunnelReport(key, gaProperty(context), {
          funnelSteps: steps.map((step) => ({ name: step.name, event: step.event })),
          dateRanges: [{ startDate, endDate }],
          funnelVisualizationType: trended ? "TRENDED_FUNNEL" : "STANDARD_FUNNEL",
          ...(breakdownDimension
            ? {
                funnelBreakdown: {
                  breakdownDimension: { name: breakdownDimension },
                  limit: String(breakdownLimit)
                }
              }
            : {}),
          ...(openFunnel ? { segments: [] } : {})
        });
        const table = response.funnelTable as Record<string, unknown> | undefined;
        return {
          steps: steps.map((step) => step.event),
          funnelTable: table ? simplifyReport(table) : undefined,
          funnelVisualization: response.funnelVisualization
            ? simplifyReport(response.funnelVisualization as Record<string, unknown>)
            : undefined,
          propertyQuota: response.propertyQuota
        };
      })
  );

  server.registerTool(
    name("get_realtime_overview"),
    {
      title: "Realtime overview",
      description: `Active users right now with an optional breakdown (${REALTIME_BREAKDOWN_NAMES.join(", ")}), plus page views, events, and key events in the last 30 minutes. ${lock}`,
      inputSchema: z.object({
        breakdown: z.enum(REALTIME_BREAKDOWN_NAMES).default("total"),
        limit: z.number().int().min(1).max(250).default(25),
        lastMinutes: z.number().int().min(1).max(30).default(30)
      }),
      annotations: readAnnotations
    },
    async ({ breakdown, limit, lastMinutes }) =>
      execute(async () => {
        const dimensions = [...REALTIME_BREAKDOWNS[breakdown]];
        const response = await ga.runRealtimeReport(key, gaProperty(context), {
          dimensions,
          metrics: ["activeUsers", "screenPageViews", "eventCount", "keyEvents"],
          orderBys: dimensions.length ? [{ metric: { metricName: "activeUsers" }, desc: true }] : undefined,
          limit,
          minuteRanges: [{ name: `last_${lastMinutes}_minutes`, startMinutesAgo: lastMinutes - 1, endMinutesAgo: 0 }]
        });
        return { breakdown, lastMinutes, result: simplifyReport(response) };
      })
  );
}
