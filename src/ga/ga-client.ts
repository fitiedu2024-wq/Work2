import { fetchGoogleJson } from "../shared/google-api";

const SCOPE = [
  "https://www.googleapis.com/auth/analytics",
  "https://www.googleapis.com/auth/analytics.edit"
].join(" ");
const ADMIN_BASE = "https://analyticsadmin.googleapis.com";
const DATA_BASE = "https://analyticsdata.googleapis.com";

type JsonObject = Record<string, unknown>;

async function request(
  key: string,
  url: string,
  init: RequestInit = {},
  options: { retryTransient?: boolean } = {}
): Promise<JsonObject> {
  return fetchGoogleJson(key, SCOPE, url, init, options);
}

async function collectPages(
  key: string,
  baseUrl: string,
  collectionName: string,
  pageSize = 200
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await request(key, url.href);
    const collection = page[collectionName];
    if (Array.isArray(collection)) items.push(...collection);
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    pages += 1;
  } while (pageToken && pages < 25);

  return items;
}

function assertResourceId(value: string, label: string): string {
  const id = value.trim().split("/").filter(Boolean).pop() ?? "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new Error(`${label} must be a resource ID (letters, digits, _ or -).`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Admin API: discovery and property configuration (reads)
// ---------------------------------------------------------------------------

export async function getAccountSummaries(key: string): Promise<JsonObject> {
  return {
    accountSummaries: await collectPages(
      key,
      `${ADMIN_BASE}/v1beta/accountSummaries`,
      "accountSummaries"
    )
  };
}

export async function getPropertyDetails(
  key: string,
  property: string
): Promise<JsonObject> {
  return request(key, `${ADMIN_BASE}/v1beta/${property}`);
}

export async function listGoogleAdsLinks(
  key: string,
  property: string
): Promise<JsonObject> {
  return {
    googleAdsLinks: await collectPages(
      key,
      `${ADMIN_BASE}/v1beta/${property}/googleAdsLinks`,
      "googleAdsLinks"
    )
  };
}

export async function getCustomDimensionsAndMetrics(
  key: string,
  property: string
): Promise<JsonObject> {
  const [customDimensions, customMetrics] = await Promise.all([
    collectPages(
      key,
      `${ADMIN_BASE}/v1beta/${property}/customDimensions`,
      "customDimensions"
    ),
    collectPages(
      key,
      `${ADMIN_BASE}/v1beta/${property}/customMetrics`,
      "customMetrics"
    )
  ]);
  return { customDimensions, customMetrics };
}

export type AdminVersion = "v1beta" | "v1alpha";

/**
 * Generic "list a collection under the property" call. Used for the many
 * Admin API collections that only need a list tool.
 */
export async function listPropertyCollection(
  key: string,
  property: string,
  version: AdminVersion,
  collection: string,
  responseKey: string,
  pageSize = 200
): Promise<JsonObject> {
  return {
    [responseKey]: await collectPages(
      key,
      `${ADMIN_BASE}/${version}/${property}/${collection}`,
      responseKey,
      pageSize
    )
  };
}

/** Generic "get a singleton settings resource under the property" call. */
export async function getPropertyResource(
  key: string,
  property: string,
  version: AdminVersion,
  suffix: string
): Promise<JsonObject> {
  return request(key, `${ADMIN_BASE}/${version}/${property}/${suffix}`);
}

export async function getDataStream(
  key: string,
  property: string,
  dataStreamId: string
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/dataStreams/${assertResourceId(dataStreamId, "dataStreamId")}`
  );
}

export async function getDataStreamResource(
  key: string,
  property: string,
  dataStreamId: string,
  suffix: string,
  version: AdminVersion = "v1alpha"
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/${version}/${property}/dataStreams/${assertResourceId(dataStreamId, "dataStreamId")}/${suffix}`
  );
}

export async function listDataStreamCollection(
  key: string,
  property: string,
  dataStreamId: string,
  collection: string,
  responseKey: string
): Promise<JsonObject> {
  return {
    [responseKey]: await collectPages(
      key,
      `${ADMIN_BASE}/v1alpha/${property}/dataStreams/${assertResourceId(dataStreamId, "dataStreamId")}/${collection}`,
      responseKey
    )
  };
}

export async function getPropertyChild(
  key: string,
  property: string,
  version: AdminVersion,
  collection: string,
  id: string,
  label: string
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/${version}/${property}/${collection}/${assertResourceId(id, label)}`
  );
}

export type RunAccessReportInput = {
  dateRanges: JsonObject[];
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: JsonObject | undefined;
  metricFilter?: JsonObject | undefined;
  orderBys?: JsonObject[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  timeZone?: string | undefined;
  returnEntityQuota?: boolean | undefined;
};

export async function runAccessReport(
  key: string,
  property: string,
  input: RunAccessReportInput
): Promise<JsonObject> {
  const body: JsonObject = {
    dateRanges: input.dateRanges,
    dimensions: input.dimensions.map((dimensionName) => ({ dimensionName })),
    metrics: input.metrics.map((metricName) => ({ metricName }))
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.orderBys) body.orderBys = input.orderBys;
  if (input.limit !== undefined) body.limit = String(input.limit);
  if (input.offset !== undefined) body.offset = String(input.offset);
  if (input.timeZone) body.timeZone = input.timeZone;
  if (input.returnEntityQuota !== undefined) body.returnEntityQuota = input.returnEntityQuota;
  return request(key, `${ADMIN_BASE}/v1beta/${property}:runAccessReport`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export type ChangeHistoryInput = {
  earliestChangeTime?: string | undefined;
  latestChangeTime?: string | undefined;
  resourceTypes?: string[] | undefined;
  actions?: string[] | undefined;
  actorEmails?: string[] | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
};

export async function searchChangeHistory(
  key: string,
  accountId: string,
  property: string,
  input: ChangeHistoryInput
): Promise<JsonObject> {
  if (!/^\d+$/.test(accountId)) {
    throw new Error("GA_ACCOUNT_ID must be configured to search change history.");
  }
  const body: JsonObject = { property };
  if (input.earliestChangeTime) body.earliestChangeTime = input.earliestChangeTime;
  if (input.latestChangeTime) body.latestChangeTime = input.latestChangeTime;
  if (input.resourceTypes?.length) body.resourceType = input.resourceTypes;
  if (input.actions?.length) body.action = input.actions;
  if (input.actorEmails?.length) body.actorEmail = input.actorEmails;
  if (input.pageSize !== undefined) body.pageSize = input.pageSize;
  if (input.pageToken) body.pageToken = input.pageToken;
  return request(
    key,
    `${ADMIN_BASE}/v1beta/accounts/${accountId}:searchChangeHistoryEvents`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

// ---------------------------------------------------------------------------
// Admin API: writes (key events, custom definitions, annotations)
// ---------------------------------------------------------------------------

export type KeyEventInput = {
  eventName: string;
  countingMethod: "ONCE_PER_EVENT" | "ONCE_PER_SESSION";
  defaultValue?: { numericValue: number; currencyCode: string } | undefined;
};

export async function createKeyEvent(
  key: string,
  property: string,
  input: KeyEventInput
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/keyEvents`,
    { method: "POST", body: JSON.stringify(input) },
    { retryTransient: false }
  );
}

export async function updateKeyEvent(
  key: string,
  property: string,
  keyEventId: string,
  updates: {
    countingMethod?: KeyEventInput["countingMethod"] | undefined;
    defaultValue?: KeyEventInput["defaultValue"] | undefined;
  }
): Promise<JsonObject> {
  const name = `${property}/keyEvents/${assertResourceId(keyEventId, "keyEventId")}`;
  const body: JsonObject = { name };
  const mask: string[] = [];
  if (updates.countingMethod !== undefined) {
    body.countingMethod = updates.countingMethod;
    mask.push("counting_method");
  }
  if (updates.defaultValue !== undefined) {
    body.defaultValue = updates.defaultValue;
    mask.push("default_value");
  }
  if (!mask.length) throw new Error("Provide at least one key event field to update.");
  const url = new URL(`${ADMIN_BASE}/v1beta/${name}`);
  url.searchParams.set("updateMask", mask.join(","));
  return request(key, url.href, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export async function deleteKeyEvent(
  key: string,
  property: string,
  keyEventId: string
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/keyEvents/${assertResourceId(keyEventId, "keyEventId")}`,
    { method: "DELETE" }
  );
}

export type CustomDimensionInput = {
  parameterName: string;
  displayName: string;
  description?: string | undefined;
  scope: "EVENT" | "USER" | "ITEM";
  disallowAdsPersonalization?: boolean | undefined;
};

export async function createCustomDimension(
  key: string,
  property: string,
  input: CustomDimensionInput
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/customDimensions`,
    { method: "POST", body: JSON.stringify(input) },
    { retryTransient: false }
  );
}

export type CustomMetricInput = {
  parameterName: string;
  displayName: string;
  description?: string | undefined;
  measurementUnit:
    | "STANDARD"
    | "CURRENCY"
    | "FEET"
    | "METERS"
    | "KILOMETERS"
    | "MILES"
    | "MILLISECONDS"
    | "SECONDS"
    | "MINUTES"
    | "HOURS";
  scope: "EVENT";
  restrictedMetricType?: Array<"COST_DATA" | "REVENUE_DATA"> | undefined;
};

export async function createCustomMetric(
  key: string,
  property: string,
  input: CustomMetricInput
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/customMetrics`,
    { method: "POST", body: JSON.stringify(input) },
    { retryTransient: false }
  );
}

export async function archiveCustomDefinition(
  key: string,
  property: string,
  kind: "customDimensions" | "customMetrics",
  id: string
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1beta/${property}/${kind}/${assertResourceId(id, "id")}:archive`,
    { method: "POST", body: "{}" }
  );
}

export async function listPropertyAnnotations(
  key: string,
  property: string
): Promise<JsonObject> {
  return {
    reportingDataAnnotations: await collectPages(
      key,
      `${ADMIN_BASE}/v1alpha/${property}/reportingDataAnnotations`,
      "reportingDataAnnotations"
    )
  };
}

export type AnnotationDate = {
  year: number;
  month: number;
  day: number;
};

export type AnnotationDateRange = {
  startDate: AnnotationDate;
  endDate: AnnotationDate;
};

export type AnnotationColor =
  | "PURPLE"
  | "BROWN"
  | "BLUE"
  | "GREEN"
  | "RED"
  | "CYAN";

export type CreatePropertyAnnotationInput = {
  title: string;
  description?: string | undefined;
  color: AnnotationColor;
  annotationDate?: AnnotationDate | undefined;
  annotationDateRange?: AnnotationDateRange | undefined;
};

export async function createPropertyAnnotation(
  key: string,
  property: string,
  input: CreatePropertyAnnotationInput
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1alpha/${property}/reportingDataAnnotations`,
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    { retryTransient: false }
  );
}

export type UpdatePropertyAnnotationInput = {
  title?: string | undefined;
  description?: string | undefined;
  color?: AnnotationColor | undefined;
  annotationDate?: AnnotationDate | undefined;
  annotationDateRange?: AnnotationDateRange | undefined;
};

function annotationName(property: string, annotationId: string): string {
  if (!/^\d+$/.test(annotationId)) {
    throw new Error("annotationId must be the numeric annotation resource ID.");
  }
  return `${property}/reportingDataAnnotations/${annotationId}`;
}

export async function updatePropertyAnnotation(
  key: string,
  property: string,
  annotationId: string,
  updates: UpdatePropertyAnnotationInput
): Promise<JsonObject> {
  const name = annotationName(property, annotationId);
  const updateMask = Object.keys(updates)
    .map((field) => {
      if (field === "annotationDate") return "annotation_date";
      if (field === "annotationDateRange") return "annotation_date_range";
      return field;
    })
    .join(",");
  const url = new URL(`${ADMIN_BASE}/v1alpha/${name}`);
  url.searchParams.set("updateMask", updateMask);
  return request(key, url.href, {
    method: "PATCH",
    body: JSON.stringify({ name, ...updates })
  });
}

export async function deletePropertyAnnotation(
  key: string,
  property: string,
  annotationId: string
): Promise<JsonObject> {
  return request(
    key,
    `${ADMIN_BASE}/v1alpha/${annotationName(property, annotationId)}`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// Data API: metadata, reports, pivots, batches, audience exports
// ---------------------------------------------------------------------------

export type MetadataFilter = {
  kind: "all" | "dimensions" | "metrics";
  search?: string | undefined;
  category?: string | undefined;
  customOnly?: boolean | undefined;
  limit: number;
};

function compactMetadataItem(item: unknown): JsonObject | undefined {
  const record = item as JsonObject | null;
  if (!record || typeof record !== "object") return undefined;
  const compact: JsonObject = {
    apiName: record.apiName,
    uiName: record.uiName,
    category: record.category
  };
  if (record.customDefinition === true) compact.customDefinition = true;
  if (typeof record.type === "string") compact.type = record.type;
  if (typeof record.expression === "string") compact.expression = record.expression;
  if (typeof record.description === "string") compact.description = record.description;
  if (typeof record.blockedReasons !== "undefined") compact.blockedReasons = record.blockedReasons;
  return compact;
}

function filterMetadataItems(items: unknown, filter: MetadataFilter): JsonObject[] {
  if (!Array.isArray(items)) return [];
  const search = filter.search?.trim().toLowerCase();
  const category = filter.category?.trim().toLowerCase();
  const matches: JsonObject[] = [];
  for (const item of items) {
    const compact = compactMetadataItem(item);
    if (!compact) continue;
    if (filter.customOnly && compact.customDefinition !== true) continue;
    if (category && String(compact.category ?? "").toLowerCase() !== category) continue;
    if (search) {
      const haystack = [compact.apiName, compact.uiName, compact.description, compact.category]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");
      if (!haystack.includes(search)) continue;
    }
    matches.push(compact);
    if (matches.length >= filter.limit) break;
  }
  return matches;
}

export async function getMetadata(
  key: string,
  property: string,
  filter: MetadataFilter
): Promise<JsonObject> {
  const metadata = await request(key, `${DATA_BASE}/v1beta/${property}/metadata`);
  const dimensions = Array.isArray(metadata.dimensions) ? metadata.dimensions : [];
  const metrics = Array.isArray(metadata.metrics) ? metadata.metrics : [];
  const result: JsonObject = {
    totals: { dimensions: dimensions.length, metrics: metrics.length },
    filter
  };
  if (filter.kind !== "metrics") result.dimensions = filterMetadataItems(dimensions, filter);
  if (filter.kind !== "dimensions") result.metrics = filterMetadataItems(metrics, filter);
  const comparisons = metadata.comparisons;
  if (Array.isArray(comparisons) && comparisons.length) result.comparisons = comparisons;
  return result;
}

export type CompatibilityInput = {
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: JsonObject | undefined;
  metricFilter?: JsonObject | undefined;
  compatibilityFilter?: "COMPATIBLE" | "INCOMPATIBLE" | undefined;
};

export async function checkCompatibility(
  key: string,
  property: string,
  input: CompatibilityInput
): Promise<JsonObject> {
  const body: JsonObject = {
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name }))
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.compatibilityFilter) body.compatibilityFilter = input.compatibilityFilter;
  return request(key, `${DATA_BASE}/v1beta/${property}:checkCompatibility`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export type RunReportInput = {
  dateRanges: JsonObject[];
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: JsonObject | undefined;
  metricFilter?: JsonObject | undefined;
  orderBys?: JsonObject[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  currencyCode?: string | undefined;
  keepEmptyRows?: boolean | undefined;
  returnPropertyQuota?: boolean | undefined;
  metricAggregations?: Array<"TOTAL" | "MINIMUM" | "MAXIMUM" | "COUNT"> | undefined;
};

export function buildReportBody(input: RunReportInput): JsonObject {
  const body: JsonObject = {
    dateRanges: input.dateRanges,
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name }))
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.orderBys) body.orderBys = input.orderBys;
  if (input.limit !== undefined) body.limit = String(input.limit);
  if (input.offset !== undefined) body.offset = String(input.offset);
  if (input.currencyCode) body.currencyCode = input.currencyCode;
  if (input.keepEmptyRows !== undefined) body.keepEmptyRows = input.keepEmptyRows;
  if (input.returnPropertyQuota !== undefined) {
    body.returnPropertyQuota = input.returnPropertyQuota;
  }
  if (input.metricAggregations?.length) body.metricAggregations = input.metricAggregations;
  return body;
}

export async function runReport(
  key: string,
  property: string,
  input: RunReportInput
): Promise<JsonObject> {
  return request(key, `${DATA_BASE}/v1beta/${property}:runReport`, {
    method: "POST",
    body: JSON.stringify(buildReportBody(input))
  });
}

export async function batchRunReports(
  key: string,
  property: string,
  requests: RunReportInput[]
): Promise<JsonObject> {
  if (requests.length < 1 || requests.length > 5) {
    throw new Error("batchRunReports accepts between 1 and 5 report requests.");
  }
  return request(key, `${DATA_BASE}/v1beta/${property}:batchRunReports`, {
    method: "POST",
    body: JSON.stringify({ requests: requests.map(buildReportBody) })
  });
}

export type RunPivotReportInput = {
  dateRanges: JsonObject[];
  dimensions: string[];
  metrics: string[];
  pivots: JsonObject[];
  dimensionFilter?: JsonObject | undefined;
  metricFilter?: JsonObject | undefined;
  currencyCode?: string | undefined;
  keepEmptyRows?: boolean | undefined;
  returnPropertyQuota?: boolean | undefined;
};

export async function runPivotReport(
  key: string,
  property: string,
  input: RunPivotReportInput
): Promise<JsonObject> {
  const body: JsonObject = {
    dateRanges: input.dateRanges,
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name })),
    pivots: input.pivots
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.currencyCode) body.currencyCode = input.currencyCode;
  if (input.keepEmptyRows !== undefined) body.keepEmptyRows = input.keepEmptyRows;
  if (input.returnPropertyQuota !== undefined) {
    body.returnPropertyQuota = input.returnPropertyQuota;
  }
  return request(key, `${DATA_BASE}/v1beta/${property}:runPivotReport`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export type RunRealtimeReportInput = {
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: JsonObject | undefined;
  metricFilter?: JsonObject | undefined;
  orderBys?: JsonObject[] | undefined;
  limit?: number | undefined;
  minuteRanges?: JsonObject[] | undefined;
  returnPropertyQuota?: boolean | undefined;
};

export async function runRealtimeReport(
  key: string,
  property: string,
  input: RunRealtimeReportInput
): Promise<JsonObject> {
  const body: JsonObject = {
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name }))
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.orderBys) body.orderBys = input.orderBys;
  if (input.limit !== undefined) body.limit = String(input.limit);
  if (input.minuteRanges) body.minuteRanges = input.minuteRanges;
  if (input.returnPropertyQuota !== undefined) {
    body.returnPropertyQuota = input.returnPropertyQuota;
  }

  return request(key, `${DATA_BASE}/v1beta/${property}:runRealtimeReport`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export type FunnelStep = {
  name: string;
  event?: string | undefined;
  filterExpression?: JsonObject | undefined;
  isDirectlyFollowedBy?: boolean | undefined;
  withinDurationFromPriorStep?: string | undefined;
};

export type RunFunnelReportInput = {
  funnelSteps: FunnelStep[];
  dateRanges?: JsonObject[] | undefined;
  funnelBreakdown?: JsonObject | undefined;
  funnelNextAction?: JsonObject | undefined;
  funnelVisualizationType?: "STANDARD_FUNNEL" | "TRENDED_FUNNEL" | undefined;
  segments?: JsonObject[] | undefined;
  limit?: number | undefined;
  dimensionFilter?: JsonObject | undefined;
  returnPropertyQuota?: boolean | undefined;
};

export async function runFunnelReport(
  key: string,
  property: string,
  input: RunFunnelReportInput
): Promise<JsonObject> {
  const steps = input.funnelSteps.map((step) => {
    if (!step.event && !step.filterExpression) {
      throw new Error(
        `Funnel step "${step.name}" requires event or filterExpression.`
      );
    }
    if (step.event && step.filterExpression) {
      throw new Error(
        `Funnel step "${step.name}" cannot contain both event and filterExpression.`
      );
    }
    return {
      name: step.name,
      filterExpression:
        step.filterExpression ?? { funnelEventFilter: { eventName: step.event } },
      ...(step.isDirectlyFollowedBy !== undefined
        ? { isDirectlyFollowedBy: step.isDirectlyFollowedBy }
        : {}),
      ...(step.withinDurationFromPriorStep
        ? { withinDurationFromPriorStep: step.withinDurationFromPriorStep }
        : {})
    };
  });

  const body: JsonObject = { funnel: { steps } };
  if (input.dateRanges) body.dateRanges = input.dateRanges;
  if (input.funnelBreakdown) body.funnelBreakdown = input.funnelBreakdown;
  if (input.funnelNextAction) body.funnelNextAction = input.funnelNextAction;
  if (input.funnelVisualizationType) {
    body.funnelVisualizationType = input.funnelVisualizationType;
  }
  if (input.segments) body.segments = input.segments;
  if (input.limit !== undefined) body.limit = String(input.limit);
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.returnPropertyQuota !== undefined) {
    body.returnPropertyQuota = input.returnPropertyQuota;
  }

  return request(key, `${DATA_BASE}/v1alpha/${property}:runFunnelReport`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function getPropertyQuotasSnapshot(
  key: string,
  property: string
): Promise<JsonObject> {
  return request(key, `${DATA_BASE}/v1alpha/${property}/propertyQuotasSnapshot`);
}

export async function listAudienceExports(
  key: string,
  property: string
): Promise<JsonObject> {
  return {
    audienceExports: await collectPages(
      key,
      `${DATA_BASE}/v1beta/${property}/audienceExports`,
      "audienceExports"
    )
  };
}

export async function getAudienceExport(
  key: string,
  property: string,
  audienceExportId: string
): Promise<JsonObject> {
  return request(
    key,
    `${DATA_BASE}/v1beta/${property}/audienceExports/${assertResourceId(audienceExportId, "audienceExportId")}`
  );
}

export async function createAudienceExport(
  key: string,
  property: string,
  audienceId: string,
  dimensions: string[]
): Promise<JsonObject> {
  return request(
    key,
    `${DATA_BASE}/v1beta/${property}/audienceExports`,
    {
      method: "POST",
      body: JSON.stringify({
        audience: `${property}/audiences/${assertResourceId(audienceId, "audienceId")}`,
        dimensions: dimensions.map((dimensionName) => ({ dimensionName }))
      })
    },
    { retryTransient: false }
  );
}

export async function queryAudienceExport(
  key: string,
  property: string,
  audienceExportId: string,
  offset?: number,
  limit?: number
): Promise<JsonObject> {
  const body: JsonObject = {};
  if (offset !== undefined) body.offset = String(offset);
  if (limit !== undefined) body.limit = String(limit);
  return request(
    key,
    `${DATA_BASE}/v1beta/${property}/audienceExports/${assertResourceId(audienceExportId, "audienceExportId")}:query`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

// ---------------------------------------------------------------------------
// Universal scoped read
// ---------------------------------------------------------------------------

export type GaApiReadInput = {
  api: "admin" | "data";
  version: AdminVersion;
  method: "GET" | "POST";
  path: string;
  query: JsonObject;
  body: JsonObject;
};

const READ_ONLY_POST_SUFFIXES = [
  ":runReport",
  ":runPivotReport",
  ":batchRunReports",
  ":batchRunPivotReports",
  ":checkCompatibility",
  ":runRealtimeReport",
  ":runFunnelReport",
  ":runAccessReport",
  ":searchChangeHistoryEvents",
  ":query"
];

/**
 * Validates a caller-supplied Analytics API path so it can only touch the
 * configured property (and, when configured, its parent account).
 */
export function validateScopedGaPath(
  rawPath: string,
  property: string,
  accountId: string,
  method: "GET" | "POST"
): string {
  const path = rawPath.trim().replace(/^\/+/, "");
  if (
    !path ||
    path.length > 1000 ||
    path.includes("..") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("://") ||
    path.includes("?") ||
    path.includes("#") ||
    /%2f|%5c|%3a/i.test(path) ||
    /^v1(alpha|beta)\//.test(path)
  ) {
    throw new Error(
      'The path is invalid. Pass the resource path only, such as "properties/123/keyEvents" (no version prefix, host, or query string).'
    );
  }
  const allowedRoots = [property];
  if (/^\d+$/.test(accountId)) allowedRoots.push(`accounts/${accountId}`);
  const inScope = allowedRoots.some(
    (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}:`)
  );
  if (!inScope) {
    throw new Error(`The path must stay inside ${allowedRoots.join(" or ")}.`);
  }
  // Everything after the root must look like resource segments or a custom verb.
  if (!/^[A-Za-z0-9_\-/.:~%]+$/.test(path)) {
    throw new Error("The path contains unsupported characters.");
  }
  if (method === "POST" && !READ_ONLY_POST_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    throw new Error(
      `POST is allowed only for read-only report verbs: ${READ_ONLY_POST_SUFFIXES.join(", ")}.`
    );
  }
  if (method === "GET" && path.includes(":")) {
    throw new Error("GET paths cannot contain a custom verb.");
  }
  return path;
}

function buildQuery(query: JsonObject): URLSearchParams {
  const params = new URLSearchParams();
  const entries = Object.entries(query);
  if (entries.length > 30) throw new Error("Too many query parameters.");
  for (const [name, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(name)) {
      throw new Error(`Invalid query parameter: ${name}`);
    }
    if (value === null || typeof value === "object") {
      throw new Error(`Query parameter ${name} must be a string, number, or boolean.`);
    }
    const rendered = String(value);
    if (rendered.length > 2000) throw new Error(`Query parameter ${name} is too long.`);
    params.set(name, rendered);
  }
  return params;
}

export async function gaApiRead(
  key: string,
  property: string,
  accountId: string,
  input: GaApiReadInput
): Promise<JsonObject> {
  const path = validateScopedGaPath(input.path, property, accountId, input.method);
  const base = input.api === "admin" ? ADMIN_BASE : DATA_BASE;
  const url = new URL(`${base}/${input.version}/${path}`);
  const params = buildQuery(input.query);
  params.forEach((value, name) => url.searchParams.set(name, value));
  return request(
    key,
    url.href,
    input.method === "GET"
      ? {}
      : { method: "POST", body: JSON.stringify(input.body) }
  );
}
