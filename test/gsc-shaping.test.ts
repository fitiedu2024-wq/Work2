import { describe, expect, it } from "vitest";
import {
  compareSearchRows,
  defaultBrandPattern,
  expectedCtrForPosition,
  findCannibalization,
  findCtrOpportunities,
  findStrikingDistance,
  flattenSearchRows,
  splitBrandQueries,
  summarizeInspection,
  totals,
  urlToPath
} from "../src/gsc/analytics-shaping";
import { buildSearchAnalyticsBody, parseSitemapXml, resolveScopedGscPath } from "../src/gsc/gsc-client";

const rows = flattenSearchRows(
  {
    rows: [
      { keys: ["layal dress", "https://layaldress.com/"], clicks: 400, impressions: 1000, ctr: 0.4, position: 1.2 },
      { keys: ["evening dress", "https://layaldress.com/collections/evening"], clicks: 20, impressions: 2000, ctr: 0.01, position: 9.4 },
      { keys: ["evening dress", "https://layaldress.com/products/red-gown"], clicks: 5, impressions: 900, ctr: 0.0055, position: 14.1 },
      { keys: ["abaya", "https://layaldress.com/collections/abaya"], clicks: 60, impressions: 600, ctr: 0.1, position: 4.8 }
    ]
  },
  ["query", "page"]
);

describe("flattenSearchRows and totals", () => {
  it("names key columns and expresses CTR as a percentage", () => {
    expect(rows[0]).toEqual({
      query: "layal dress",
      page: "https://layaldress.com/",
      clicks: 400,
      impressions: 1000,
      ctr: 40,
      position: 1.2
    });
    const sum = totals(rows);
    expect(sum.clicks).toBe(485);
    expect(sum.impressions).toBe(4500);
    expect(sum.ctr).toBe(10.78);
  });
});

describe("compareSearchRows", () => {
  it("ranks losers by click delta and computes totals", () => {
    const previous = flattenSearchRows(
      { rows: [{ keys: ["abaya"], clicks: 100, impressions: 700, ctr: 0.14, position: 4 }] },
      ["query"]
    );
    const current = flattenSearchRows(
      {
        rows: [
          { keys: ["abaya"], clicks: 60, impressions: 600, ctr: 0.1, position: 4.8 },
          { keys: ["kaftan"], clicks: 10, impressions: 50, ctr: 0.2, position: 3 }
        ]
      },
      ["query"]
    );
    const result = compareSearchRows(current, previous, ["query"], "clicks", 10, "losers");
    expect(result.rows[0]?.key.query).toBe("abaya");
    expect(result.rows[0]?.delta.clicks).toBe(-40);
    expect(result.rows[0]?.deltaPercent.clicks).toBe(-40);
    expect(result.rows[1]?.deltaPercent.clicks).toBe("new");
    expect(result.totals.current.clicks).toBe(70);
  });
});

describe("opportunity finders", () => {
  it("finds striking-distance queries by position window and impressions", () => {
    const result = findStrikingDistance(rows, 8, 20, 500, 10);
    expect(result.map((row) => row.page)).toEqual([
      "https://layaldress.com/collections/evening",
      "https://layaldress.com/products/red-gown"
    ]);
  });

  it("estimates CTR opportunities from the position curve", () => {
    expect(expectedCtrForPosition(1)).toBe(28);
    expect(expectedCtrForPosition(9.4)).toBe(2.5);
    const result = findCtrOpportunities(rows, 500, 10);
    expect(result[0]?.query).toBe("evening dress");
    expect(result[0]?.estimatedExtraClicks).toBeGreaterThan(0);
    expect(result.some((row) => row.query === "layal dress")).toBe(false);
  });

  it("detects cannibalisation when several pages rank for one query", () => {
    const result = findCannibalization(rows, 10, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.query).toBe("evening dress");
    expect(result[0]?.competingPages).toHaveLength(2);
  });
});

describe("brand split", () => {
  it("derives a brand pattern from label and domain", () => {
    const pattern = defaultBrandPattern("Layal Dress", "sc-domain:layaldress.com");
    expect(new RegExp(pattern, "i").test("layal dress")).toBe(true);
    expect(new RegExp(pattern, "i").test("layaldress")).toBe(true);
    expect(new RegExp(pattern, "i").test("evening gown")).toBe(false);
  });

  it("splits totals and share", () => {
    const result = splitBrandQueries(rows, "layal", 5);
    expect(result.brand.clicks).toBe(400);
    expect(result.nonBrand.clicks).toBe(85);
    expect(result.brandShareOfClicks).toBeCloseTo(82.47, 1);
  });
});

describe("inspection summary and paths", () => {
  it("summarises inspection results and flags canonical mismatches", () => {
    const summary = summarizeInspection("https://layaldress.com/p", {
      inspectionResult: {
        inspectionResultLink: "https://search.google.com/...",
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          googleCanonical: "https://layaldress.com/p",
          userCanonical: "https://layaldress.com/p?variant=1"
        }
      }
    });
    expect(summary.verdict).toBe("PASS");
    expect(summary.canonicalMismatch).toBe(true);
  });

  it("extracts paths from URLs", () => {
    expect(urlToPath("https://layaldress.com/products/x?y=1")).toBe("/products/x");
    expect(urlToPath("https://layaldress.com")).toBe("/");
  });
});

describe("buildSearchAnalyticsBody", () => {
  it("adds simple filters as one AND group", () => {
    const body = buildSearchAnalyticsBody({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      dimensions: ["query"],
      filters: [{ dimension: "country", operator: "equals", expression: "sau" }],
      rowLimit: 10
    });
    expect(body.dimensionFilterGroups).toEqual([
      { groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "sau" }] }
    ]);
    expect(body.rowLimit).toBe(10);
  });
});

describe("parseSitemapXml", () => {
  it("parses url sets and indexes and unescapes entities", () => {
    const urlset = parseSitemapXml(
      "https://layaldress.com/sitemap.xml",
      `<?xml version="1.0"?><urlset><url><loc>https://layaldress.com/a?x=1&amp;y=2</loc></url><url><loc> https://layaldress.com/b </loc></url></urlset>`,
      10
    );
    expect(urlset.kind).toBe("urlset");
    expect(urlset.urls).toEqual(["https://layaldress.com/a?x=1&y=2", "https://layaldress.com/b"]);
    const index = parseSitemapXml(
      "https://layaldress.com/sitemap.xml",
      `<sitemapindex><sitemap><loc>https://layaldress.com/sitemap_products_1.xml</loc></sitemap></sitemapindex>`,
      10
    );
    expect(index.kind).toBe("index");
    expect(index.childSitemaps).toHaveLength(1);
  });

  it("truncates at maxUrls", () => {
    const xml = `<urlset>${Array.from({ length: 5 }, (_, i) => `<url><loc>https://x.com/${i}</loc></url>`).join("")}</urlset>`;
    const parsed = parseSitemapXml("https://x.com/s.xml", xml, 3);
    expect(parsed.urls).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });
});

describe("resolveScopedGscPath", () => {
  const site = "sc-domain:layaldress.com";

  it("resolves ~ to the configured property", () => {
    expect(resolveScopedGscPath("sites/~/sitemaps", site, "GET").url).toContain(encodeURIComponent(site));
    expect(resolveScopedGscPath("sites/~/searchAnalytics/query", site, "POST").forceSiteUrl).toBe(false);
    expect(resolveScopedGscPath("urlInspection/index:inspect", site, "POST").forceSiteUrl).toBe(true);
    expect(resolveScopedGscPath(`sites/${encodeURIComponent(site)}`, site, "GET").url).toMatch(/sites\/sc-domain/);
  });

  it("rejects other properties, wrong methods, and unknown paths", () => {
    expect(() => resolveScopedGscPath("sites/sc-domain:other.com/sitemaps", site, "GET")).toThrow("configured property");
    expect(() => resolveScopedGscPath("sites/~/sitemaps", site, "POST")).toThrow("GET");
    expect(() => resolveScopedGscPath("sites/~/searchAnalytics/query", site, "GET")).toThrow("POST");
    expect(() => resolveScopedGscPath("sites", site, "GET")).toThrow();
    expect(() => resolveScopedGscPath("sites/~/other", site, "GET")).toThrow("Unsupported");
    expect(() => resolveScopedGscPath("sites/~/sitemaps?x=1", site, "GET")).toThrow("invalid");
  });
});
