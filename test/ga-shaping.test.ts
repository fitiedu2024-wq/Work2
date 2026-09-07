import { describe, expect, it } from "vitest";
import { validateScopedGaPath } from "../src/ga/ga-client";
import {
  buildShapedReport,
  comparePeriods,
  SHAPED_REPORT_NAMES,
  SHAPED_REPORTS,
  simplifyReport
} from "../src/ga/report-shaping";

const sampleReport = {
  dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }],
  metricHeaders: [
    { name: "sessions", type: "TYPE_INTEGER" },
    { name: "purchaseRevenue", type: "TYPE_CURRENCY" }
  ],
  rows: [
    { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "120" }, { value: "1500.5" }] },
    { dimensionValues: [{ value: "Direct" }], metricValues: [{ value: "80" }, { value: "0" }] }
  ],
  totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: [{ value: "200" }, { value: "1500.5" }] }],
  rowCount: 2,
  metadata: { currencyCode: "SAR" }
};

describe("simplifyReport", () => {
  it("flattens rows into named columns with numeric metrics", () => {
    const result = simplifyReport(sampleReport);
    expect(result.rows).toEqual([
      { sessionDefaultChannelGroup: "Organic Search", sessions: 120, purchaseRevenue: 1500.5 },
      { sessionDefaultChannelGroup: "Direct", sessions: 80, purchaseRevenue: 0 }
    ]);
    expect(result.totals?.[0]?.sessions).toBe(200);
    expect(result.currencyCode).toBe("SAR");
    expect(result.rowCount).toBe(2);
  });

  it("handles empty responses", () => {
    expect(simplifyReport({})).toEqual({
      rowCount: 0,
      returnedRows: 0,
      dimensions: [],
      metrics: [],
      rows: []
    });
  });
});

describe("comparePeriods", () => {
  it("splits date_range_0 / date_range_1 rows and computes deltas", () => {
    const result = comparePeriods({
      dimensionHeaders: [{ name: "deviceCategory" }, { name: "dateRange" }],
      metricHeaders: [{ name: "sessions" }],
      rows: [
        { dimensionValues: [{ value: "mobile" }, { value: "date_range_0" }], metricValues: [{ value: "150" }] },
        { dimensionValues: [{ value: "mobile" }, { value: "date_range_1" }], metricValues: [{ value: "100" }] },
        { dimensionValues: [{ value: "desktop" }, { value: "date_range_0" }], metricValues: [{ value: "40" }] }
      ]
    });
    expect(result.dimensions).toEqual(["deviceCategory"]);
    const mobile = result.rows.find((row) => row.key.deviceCategory === "mobile");
    expect(mobile?.delta.sessions).toBe(50);
    expect(mobile?.deltaPercent.sessions).toBe(50);
    const desktop = result.rows.find((row) => row.key.deviceCategory === "desktop");
    expect(desktop?.previous.sessions).toBe(0);
    expect(desktop?.deltaPercent.sessions).toBe("new");
    expect(result.totals.current.sessions).toBe(190);
    expect(result.totals.previous.sessions).toBe(100);
    expect(result.totals.deltaPercent.sessions).toBe(90);
  });

  it("rejects single-range reports", () => {
    expect(() => comparePeriods(sampleReport)).toThrow("dateRange");
  });
});

describe("buildShapedReport", () => {
  it("builds the default breakdown with ordering and limit", () => {
    const request = buildShapedReport("acquisition_channels", {
      startDate: "28daysAgo",
      endDate: "yesterday",
      limit: 10,
      descending: true
    });
    expect(request.dimensions).toEqual(["sessionDefaultChannelGroup"]);
    expect(request.metrics).toContain("purchaseRevenue");
    expect(request.orderBys).toEqual([{ metric: { metricName: "sessions" }, desc: true }]);
    expect(request.dateRanges).toHaveLength(1);
    expect(request.dimensionFilter).toBeUndefined();
  });

  it("adds the organic filter and a comparison range", () => {
    const request = buildShapedReport("landing_pages", {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      compareStartDate: "2026-07-01",
      compareEndDate: "2026-07-31",
      limit: 50,
      descending: true,
      organicOnly: true
    });
    expect(request.dateRanges).toHaveLength(2);
    expect(JSON.stringify(request.dimensionFilter)).toContain("Organic Search");
  });

  it("combines static and caller filters with AND", () => {
    const request = buildShapedReport("site_search_terms", {
      startDate: "7daysAgo",
      endDate: "today",
      limit: 5,
      descending: true,
      dimensionFilter: { filter: { fieldName: "deviceCategory", stringFilter: { value: "mobile" } } }
    });
    expect(request.dimensionFilter).toHaveProperty("andGroup");
  });

  it("rejects unknown breakdowns, bad dates, and half comparisons", () => {
    const base = { startDate: "7daysAgo", endDate: "today", limit: 5, descending: true };
    expect(() => buildShapedReport("geo_breakdown", { ...base, breakdown: "planet" })).toThrow("Unknown breakdown");
    expect(() => buildShapedReport("geo_breakdown", { ...base, startDate: "last week" })).toThrow("Invalid date");
    expect(() => buildShapedReport("geo_breakdown", { ...base, compareStartDate: "14daysAgo" })).toThrow(
      "compareEndDate"
    );
    expect(() => buildShapedReport("geo_breakdown", { ...base, orderBy: "bounceRate" })).toThrow("orderBy");
  });

  it("every catalogue entry has a default breakdown whose orderBy is valid", () => {
    for (const name of SHAPED_REPORT_NAMES) {
      const definition = SHAPED_REPORTS[name];
      const request = buildShapedReport(name, { startDate: "7daysAgo", endDate: "today", limit: 5, descending: true });
      expect(request.metrics).toEqual([...definition.metrics]);
      if (request.dimensions.length) expect(request.orderBys).toHaveLength(1);
    }
  });
});

describe("validateScopedGaPath", () => {
  const property = "properties/528542206";

  it("accepts property-scoped resources and report verbs", () => {
    expect(validateScopedGaPath("properties/528542206/dataStreams", property, "", "GET")).toBe(
      "properties/528542206/dataStreams"
    );
    expect(validateScopedGaPath("/properties/528542206:runReport", property, "", "POST")).toBe(
      "properties/528542206:runReport"
    );
    expect(validateScopedGaPath("accounts/387714621:searchChangeHistoryEvents", property, "387714621", "POST")).toBe(
      "accounts/387714621:searchChangeHistoryEvents"
    );
  });

  it("rejects other properties, accounts, and unsafe paths", () => {
    expect(() => validateScopedGaPath("properties/1/dataStreams", property, "", "GET")).toThrow("inside");
    expect(() => validateScopedGaPath("properties/5285422060", property, "", "GET")).toThrow("inside");
    expect(() => validateScopedGaPath("accounts/1", property, "387714621", "GET")).toThrow("inside");
    expect(() => validateScopedGaPath("accountSummaries", property, "", "GET")).toThrow("inside");
    expect(() => validateScopedGaPath("properties/528542206/../x", property, "", "GET")).toThrow("invalid");
    expect(() => validateScopedGaPath("properties/528542206?x=1", property, "", "GET")).toThrow("invalid");
    expect(() => validateScopedGaPath("v1beta/properties/528542206", property, "", "GET")).toThrow("invalid");
  });

  it("only allows POST for read-only verbs", () => {
    expect(() => validateScopedGaPath("properties/528542206/keyEvents", property, "", "POST")).toThrow("POST");
    expect(() => validateScopedGaPath("properties/528542206:runReport", property, "", "GET")).toThrow("GET");
  });
});
