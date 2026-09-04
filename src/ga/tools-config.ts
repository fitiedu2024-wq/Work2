import { z } from "zod";
import {
  asRecord,
  execute,
  readAnnotations,
  writeAnnotations
} from "../shared/mcp";
import type { WebsiteConfig } from "../shared/website";
import { gaProperty, type GaToolContext } from "./context";
import * as ga from "./ga-client";

const changeSummary = z
  .string()
  .min(5)
  .max(500)
  .describe("Plain-language summary of the change, shown with the approval request.");
const resourceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const annotationDateSchema = z.object({
  year: z.number().int().min(1).max(9999),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31)
});
const annotationDateRangeSchema = z.object({
  startDate: annotationDateSchema,
  endDate: annotationDateSchema
});
const annotationColorSchema = z.enum(["PURPLE", "BROWN", "BLUE", "GREEN", "RED", "CYAN"]);
const annotationTargetSchema = z
  .object({
    annotationDate: annotationDateSchema.optional(),
    annotationDateRange: annotationDateRangeSchema.optional()
  })
  .refine(
    ({ annotationDate, annotationDateRange }) =>
      Number(annotationDate !== undefined) + Number(annotationDateRange !== undefined) === 1,
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
  .refine(({ annotationDate, annotationDateRange }) => !(annotationDate && annotationDateRange), {
    message: "Do not provide both annotationDate and annotationDateRange."
  });

function filterAccountSummaries(
  result: Record<string, unknown>,
  website: WebsiteConfig
): Record<string, unknown> {
  if (!website.gaAccountId && !website.gaPropertyId) {
    throw new Error(
      `Worker "${website.slug}" has no GA_ACCOUNT_ID or GA_PROPERTY_ID configured.`
    );
  }
  const summaries = Array.isArray(result.accountSummaries) ? result.accountSummaries : [];
  const wantedProperty = website.gaPropertyId
    ? `properties/${website.gaPropertyId.replace(/^properties\//, "")}`
    : undefined;
  const filtered = summaries.flatMap((summary) => {
    const account = asRecord(summary);
    if (!account) return [];
    if (website.gaAccountId && account.account !== `accounts/${website.gaAccountId}`) {
      return [];
    }
    const properties = Array.isArray(account.propertySummaries)
      ? wantedProperty
        ? account.propertySummaries.filter((candidate) => asRecord(candidate)?.property === wantedProperty)
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

type ListToolSpec = {
  tool: string;
  title: string;
  description: string;
  version: ga.AdminVersion;
  collection: string;
  responseKey: string;
};

/** Admin API collections under the property that only need a list tool. */
const LIST_TOOLS: ListToolSpec[] = [
  {
    tool: "list_data_streams",
    title: "List data streams",
    description: "Web, iOS, and Android streams with measurement IDs and default URIs.",
    version: "v1beta",
    collection: "dataStreams",
    responseKey: "dataStreams"
  },
  {
    tool: "list_key_events",
    title: "List key events",
    description: "Events marked as key events (conversions) with counting method and default value.",
    version: "v1beta",
    collection: "keyEvents",
    responseKey: "keyEvents"
  },
  {
    tool: "list_audiences",
    title: "List audiences",
    description: "Audience definitions, membership duration, and eligibility for ads personalization.",
    version: "v1alpha",
    collection: "audiences",
    responseKey: "audiences"
  },
  {
    tool: "list_channel_groups",
    title: "List channel groups",
    description: "Default and custom channel groups and their grouping rules.",
    version: "v1alpha",
    collection: "channelGroups",
    responseKey: "channelGroups"
  },
  {
    tool: "list_firebase_links",
    title: "List Firebase links",
    description: "Firebase projects linked to the property.",
    version: "v1beta",
    collection: "firebaseLinks",
    responseKey: "firebaseLinks"
  },
  {
    tool: "list_bigquery_links",
    title: "List BigQuery links",
    description: "BigQuery export links, export frequency, and included streams.",
    version: "v1alpha",
    collection: "bigQueryLinks",
    responseKey: "bigqueryLinks"
  },
  {
    tool: "list_search_ads_360_links",
    title: "List Search Ads 360 links",
    description: "Search Ads 360 advertiser links.",
    version: "v1alpha",
    collection: "searchAds360Links",
    responseKey: "searchAds360Links"
  },
  {
    tool: "list_dv360_advertiser_links",
    title: "List Display & Video 360 links",
    description: "Display & Video 360 advertiser links.",
    version: "v1alpha",
    collection: "displayVideo360AdvertiserLinks",
    responseKey: "displayVideo360AdvertiserLinks"
  },
  {
    tool: "list_adsense_links",
    title: "List AdSense links",
    description: "AdSense ad clients linked to the property.",
    version: "v1alpha",
    collection: "adSenseLinks",
    responseKey: "adsenseLinks"
  },
  {
    tool: "list_access_bindings",
    title: "List property access bindings",
    description: "Users and groups with roles on this property (who has access).",
    version: "v1alpha",
    collection: "accessBindings",
    responseKey: "accessBindings"
  },
  {
    tool: "list_calculated_metrics",
    title: "List calculated metrics",
    description: "Calculated metric definitions and formulas.",
    version: "v1alpha",
    collection: "calculatedMetrics",
    responseKey: "calculatedMetrics"
  },
  {
    tool: "list_expanded_data_sets",
    title: "List expanded data sets",
    description: "Expanded data sets that raise the (other) row cardinality limits.",
    version: "v1alpha",
    collection: "expandedDataSets",
    responseKey: "expandedDataSets"
  },
  {
    tool: "list_subproperty_event_filters",
    title: "List subproperty event filters",
    description: "Event filters that route data into subproperties (360 only).",
    version: "v1alpha",
    collection: "subpropertyEventFilters",
    responseKey: "subpropertyEventFilters"
  },
  {
    tool: "list_rollup_source_links",
    title: "List roll-up source links",
    description: "Source properties feeding a roll-up property (360 only).",
    version: "v1alpha",
    collection: "rollupPropertySourceLinks",
    responseKey: "rollupPropertySourceLinks"
  }
];

type SettingsToolSpec = {
  tool: string;
  title: string;
  description: string;
  version: ga.AdminVersion;
  suffix: string;
};

/** Singleton settings resources under the property. */
const SETTINGS_TOOLS: SettingsToolSpec[] = [
  {
    tool: "get_data_retention_settings",
    title: "Get data retention settings",
    description: "Event and user data retention period and reset-on-activity flag.",
    version: "v1beta",
    suffix: "dataRetentionSettings"
  },
  {
    tool: "get_attribution_settings",
    title: "Get attribution settings",
    description: "Reporting attribution model and acquisition / other lookback windows.",
    version: "v1alpha",
    suffix: "attributionSettings"
  },
  {
    tool: "get_google_signals_settings",
    title: "Get Google Signals settings",
    description: "Whether Google Signals is enabled and consent state.",
    version: "v1alpha",
    suffix: "googleSignalsSettings"
  },
  {
    tool: "get_reporting_identity_settings",
    title: "Get reporting identity settings",
    description: "Reporting identity (blended, observed, device-based).",
    version: "v1alpha",
    suffix: "reportingIdentitySettings"
  },
  {
    tool: "get_user_provided_data_settings",
    title: "Get user-provided data settings",
    description: "User-provided data collection settings.",
    version: "v1alpha",
    suffix: "userProvidedDataSettings"
  }
];

export function registerGaConfigTools(context: GaToolContext): void {
  const { server, key, website, name, lock } = context;

  // --- Discovery ------------------------------------------------------------

  server.registerTool(
    name("get_account_summaries"),
    {
      title: "Get account summaries",
      description: `List the GA account and property this Worker is locked to, as Google sees them. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () =>
      execute(async () => filterAccountSummaries(await ga.getAccountSummaries(key), website))
  );

  server.registerTool(
    name("get_property_details"),
    {
      title: "Get property details",
      description: `GA4 property configuration: name, time zone, currency, industry, service level. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.getPropertyDetails(key, gaProperty(context)))
  );

  server.registerTool(
    name("list_google_ads_links"),
    {
      title: "List Google Ads links",
      description: `Google Ads accounts linked to the property. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.listGoogleAdsLinks(key, gaProperty(context)))
  );

  server.registerTool(
    name("get_custom_dimensions_and_metrics"),
    {
      title: "Get custom dimensions and metrics",
      description: `Custom dimension and metric definitions (parameter names, scopes, units). ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.getCustomDimensionsAndMetrics(key, gaProperty(context)))
  );

  for (const spec of LIST_TOOLS) {
    server.registerTool(
      name(spec.tool),
      {
        title: spec.title,
        description: `${spec.description} ${lock}`,
        inputSchema: z.object({}),
        annotations: readAnnotations
      },
      async () =>
        execute(() =>
          ga.listPropertyCollection(
            key,
            gaProperty(context),
            spec.version,
            spec.collection,
            spec.responseKey
          )
        )
    );
  }

  for (const spec of SETTINGS_TOOLS) {
    server.registerTool(
      name(spec.tool),
      {
        title: spec.title,
        description: `${spec.description} ${lock}`,
        inputSchema: z.object({}),
        annotations: readAnnotations
      },
      async () =>
        execute(() => ga.getPropertyResource(key, gaProperty(context), spec.version, spec.suffix))
    );
  }

  server.registerTool(
    name("get_data_stream"),
    {
      title: "Get data stream",
      description: `One data stream with its measurement ID and stream details. ${lock}`,
      inputSchema: z.object({ dataStreamId: resourceId }),
      annotations: readAnnotations
    },
    async ({ dataStreamId }) =>
      execute(() => ga.getDataStream(key, gaProperty(context), dataStreamId))
  );

  server.registerTool(
    name("get_enhanced_measurement_settings"),
    {
      title: "Get enhanced measurement settings",
      description: `Which enhanced measurement events (scrolls, outbound clicks, site search, video, file downloads, form interactions) a web stream collects. ${lock}`,
      inputSchema: z.object({ dataStreamId: resourceId }),
      annotations: readAnnotations
    },
    async ({ dataStreamId }) =>
      execute(() =>
        ga.getDataStreamResource(key, gaProperty(context), dataStreamId, "enhancedMeasurementSettings")
      )
  );

  server.registerTool(
    name("get_data_redaction_settings"),
    {
      title: "Get data redaction settings",
      description: `Email and query-parameter redaction settings of a web stream. ${lock}`,
      inputSchema: z.object({ dataStreamId: resourceId }),
      annotations: readAnnotations
    },
    async ({ dataStreamId }) =>
      execute(() =>
        ga.getDataStreamResource(key, gaProperty(context), dataStreamId, "dataRedactionSettings")
      )
  );

  server.registerTool(
    name("list_event_create_rules"),
    {
      title: "List event create rules",
      description: `Rules that create new events from existing ones on a web stream. ${lock}`,
      inputSchema: z.object({ dataStreamId: resourceId }),
      annotations: readAnnotations
    },
    async ({ dataStreamId }) =>
      execute(() =>
        ga.listDataStreamCollection(
          key,
          gaProperty(context),
          dataStreamId,
          "eventCreateRules",
          "eventCreateRules"
        )
      )
  );

  server.registerTool(
    name("list_event_edit_rules"),
    {
      title: "List event edit rules",
      description: `Rules that modify incoming events on a web stream, in processing order. ${lock}`,
      inputSchema: z.object({ dataStreamId: resourceId }),
      annotations: readAnnotations
    },
    async ({ dataStreamId }) =>
      execute(() =>
        ga.listDataStreamCollection(key, gaProperty(context), dataStreamId, "eventEditRules", "eventEditRules")
      )
  );

  server.registerTool(
    name("get_key_event"),
    {
      title: "Get key event",
      description: `One key event definition. ${lock}`,
      inputSchema: z.object({ keyEventId: resourceId }),
      annotations: readAnnotations
    },
    async ({ keyEventId }) =>
      execute(() =>
        ga.getPropertyChild(key, gaProperty(context), "v1beta", "keyEvents", keyEventId, "keyEventId")
      )
  );

  server.registerTool(
    name("get_audience"),
    {
      title: "Get audience",
      description: `One audience definition including its filter clauses. ${lock}`,
      inputSchema: z.object({ audienceId: resourceId }),
      annotations: readAnnotations
    },
    async ({ audienceId }) =>
      execute(() =>
        ga.getPropertyChild(key, gaProperty(context), "v1alpha", "audiences", audienceId, "audienceId")
      )
  );

  // --- Audit ----------------------------------------------------------------

  server.registerTool(
    name("run_access_report"),
    {
      title: "Run data access report",
      description: `Who read reporting data and when (data-access audit). Dimensions such as userEmail, accessMechanism, mostRecentAccessDateTime, reportType; metrics accessCount. ${lock}`,
      inputSchema: z.object({
        dateRanges: z
          .array(z.object({ startDate: z.string().min(1), endDate: z.string().min(1) }))
          .min(1)
          .max(2),
        dimensions: z.array(z.string().min(1)).max(9).default(["userEmail", "accessMechanism"]),
        metrics: z.array(z.string().min(1)).min(1).max(10).default(["accessCount"]),
        dimensionFilter: z.record(z.string(), z.unknown()).optional(),
        metricFilter: z.record(z.string(), z.unknown()).optional(),
        orderBys: z.array(z.record(z.string(), z.unknown())).optional(),
        limit: z.number().int().positive().max(10_000).optional(),
        offset: z.number().int().nonnegative().optional(),
        timeZone: z.string().max(64).optional(),
        returnEntityQuota: z.boolean().optional()
      }),
      annotations: readAnnotations
    },
    async (input) => execute(() => ga.runAccessReport(key, gaProperty(context), input))
  );

  server.registerTool(
    name("search_change_history"),
    {
      title: "Search configuration change history",
      description: `Who changed what in the property configuration (streams, key events, links, settings). Requires GA_ACCOUNT_ID. Times are RFC 3339. ${lock}`,
      inputSchema: z.object({
        earliestChangeTime: z.string().datetime({ offset: true }).optional(),
        latestChangeTime: z.string().datetime({ offset: true }).optional(),
        resourceTypes: z
          .array(z.string().regex(/^[A-Z_0-9]+$/))
          .max(20)
          .optional()
          .describe("ChangeHistoryResourceType values such as PROPERTY, DATA_STREAM, KEY_EVENT, GOOGLE_ADS_LINK."),
        actions: z.array(z.enum(["CREATED", "UPDATED", "DELETED"])).optional(),
        actorEmails: z.array(z.string().email()).max(20).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
        pageToken: z.string().optional()
      }),
      annotations: readAnnotations
    },
    async (input) =>
      execute(() =>
        ga.searchChangeHistory(key, website.gaAccountId, gaProperty(context), input)
      )
  );

  // --- Writes ---------------------------------------------------------------

  server.registerTool(
    name("create_key_event"),
    {
      title: "Create key event",
      description: `Mark an event name as a key event (conversion). Requires approval. ${lock}`,
      inputSchema: z.object({
        eventName: z.string().min(1).max(40),
        countingMethod: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).default("ONCE_PER_EVENT"),
        defaultValue: z
          .object({ numericValue: z.number(), currencyCode: z.string().length(3) })
          .optional(),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ eventName, countingMethod, defaultValue }) =>
      execute(() =>
        ga.createKeyEvent(key, gaProperty(context), { eventName, countingMethod, defaultValue })
      )
  );

  server.registerTool(
    name("update_key_event"),
    {
      title: "Update key event",
      description: `Change the counting method or default value of a key event. Requires approval. ${lock}`,
      inputSchema: z.object({
        keyEventId: resourceId,
        countingMethod: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).optional(),
        defaultValue: z
          .object({ numericValue: z.number(), currencyCode: z.string().length(3) })
          .optional(),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ keyEventId, countingMethod, defaultValue }) =>
      execute(() =>
        ga.updateKeyEvent(key, gaProperty(context), keyEventId, { countingMethod, defaultValue })
      )
  );

  server.registerTool(
    name("delete_key_event"),
    {
      title: "Delete key event",
      description: `Stop treating an event as a key event. Requires approval. ${lock}`,
      inputSchema: z.object({
        keyEventId: resourceId,
        confirm: z.literal(true).describe("Must be true to confirm deletion."),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ keyEventId }) => execute(() => ga.deleteKeyEvent(key, gaProperty(context), keyEventId))
  );

  server.registerTool(
    name("create_custom_dimension"),
    {
      title: "Create custom dimension",
      description: `Register an event, user, or item parameter as a custom dimension. Requires approval. ${lock}`,
      inputSchema: z.object({
        parameterName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
        displayName: z.string().min(1).max(82),
        description: z.string().max(150).optional(),
        scope: z.enum(["EVENT", "USER", "ITEM"]).default("EVENT"),
        disallowAdsPersonalization: z.boolean().optional(),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ change_summary: _summary, ...input }) =>
      execute(() => ga.createCustomDimension(key, gaProperty(context), input))
  );

  server.registerTool(
    name("create_custom_metric"),
    {
      title: "Create custom metric",
      description: `Register an event parameter as a custom metric. Requires approval. ${lock}`,
      inputSchema: z.object({
        parameterName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
        displayName: z.string().min(1).max(82),
        description: z.string().max(150).optional(),
        measurementUnit: z
          .enum([
            "STANDARD",
            "CURRENCY",
            "FEET",
            "METERS",
            "KILOMETERS",
            "MILES",
            "MILLISECONDS",
            "SECONDS",
            "MINUTES",
            "HOURS"
          ])
          .default("STANDARD"),
        restrictedMetricType: z.array(z.enum(["COST_DATA", "REVENUE_DATA"])).optional(),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ change_summary: _summary, ...input }) =>
      execute(() => ga.createCustomMetric(key, gaProperty(context), { ...input, scope: "EVENT" }))
  );

  server.registerTool(
    name("archive_custom_definition"),
    {
      title: "Archive custom dimension or metric",
      description: `Archive a custom dimension or metric. Archiving is permanent and frees the quota slot. Requires approval. ${lock}`,
      inputSchema: z.object({
        kind: z.enum(["customDimensions", "customMetrics"]),
        id: resourceId,
        confirm: z.literal(true).describe("Must be true to confirm archiving."),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ kind, id }) =>
      execute(() => ga.archiveCustomDefinition(key, gaProperty(context), kind, id))
  );

  // --- Annotations ----------------------------------------------------------

  server.registerTool(
    name("list_property_annotations"),
    {
      title: "List reporting annotations",
      description: `GA reporting data annotations and their IDs. ${lock}`,
      inputSchema: z.object({}),
      annotations: readAnnotations
    },
    async () => execute(() => ga.listPropertyAnnotations(key, gaProperty(context)))
  );

  server.registerTool(
    name("create_property_annotation"),
    {
      title: "Create reporting annotation",
      description: `Create a dated GA reporting annotation (campaign launch, site change, outage). Orange is reserved by Google. Requires approval. ${lock}`,
      inputSchema: z.object({
        annotation: annotationCreateSchema,
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ annotation }) =>
      execute(() => ga.createPropertyAnnotation(key, gaProperty(context), annotation))
  );

  server.registerTool(
    name("update_property_annotation"),
    {
      title: "Update reporting annotation",
      description: `Update fields on a user-created annotation. System annotations cannot change. Requires approval. ${lock}`,
      inputSchema: z.object({
        annotationId: z.string().regex(/^\d+$/),
        updates: annotationUpdatesSchema,
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ annotationId, updates }) =>
      execute(() => ga.updatePropertyAnnotation(key, gaProperty(context), annotationId, updates))
  );

  server.registerTool(
    name("delete_property_annotation"),
    {
      title: "Delete reporting annotation",
      description: `Permanently delete a user-created annotation. Requires approval. ${lock}`,
      inputSchema: z.object({
        annotationId: z.string().regex(/^\d+$/),
        confirm: z.literal(true).describe("Must be true to confirm permanent deletion."),
        change_summary: changeSummary
      }),
      annotations: writeAnnotations
    },
    async ({ annotationId }) =>
      execute(() => ga.deletePropertyAnnotation(key, gaProperty(context), annotationId))
  );
}
