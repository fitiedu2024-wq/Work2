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
  collectionName: string
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await request(key, url.href);
    const collection = page[collectionName];
    if (Array.isArray(collection)) items.push(...collection);
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
  } while (pageToken);

  return items;
}

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
};

export async function runReport(
  key: string,
  property: string,
  input: RunReportInput
): Promise<JsonObject> {
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

  return request(key, `${DATA_BASE}/v1beta/${property}:runReport`, {
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
