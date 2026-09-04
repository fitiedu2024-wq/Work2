import { describe, expect, it } from "vitest";
import {
  assertUrlBelongsToGscProperty,
  normalizePropertyId,
  normalizeSiteUrl
} from "../src/shared/scope";
import {
  requireGaProperty,
  requireGscProperty,
  websiteFromEnv
} from "../src/shared/website";

const layalEnv = {
  BRAND_SLUG: "layal",
  BRAND_LABEL: "Layal Dress",
  BRAND_SITE_URL: "https://layaldress.com/",
  GA_ACCOUNT_ID: "387714621",
  GA_ACCOUNT_NAME: "فساتين ليال",
  GA_PROPERTY_ID: "528542206",
  GSC_SITE_URL: "sc-domain:layaldress.com"
};

const toleenEnv = {
  BRAND_SLUG: "toleen",
  BRAND_LABEL: "Toleen Fashion",
  BRAND_SITE_URL: "https://toleen-fashion22.com/",
  GA_ACCOUNT_ID: "375645449",
  GA_ACCOUNT_NAME: "toleen-fashion22.com",
  GA_PROPERTY_ID: "513746872",
  GSC_SITE_URL: "https://toleen-fashion22.com/"
};

describe("per-Worker configuration", () => {
  it("loads one website from Wrangler environment variables", () => {
    expect(websiteFromEnv(toleenEnv)).toEqual({
      slug: "toleen",
      label: "Toleen Fashion",
      siteUrl: "https://toleen-fashion22.com/",
      gaAccountId: "375645449",
      gaAccountName: "toleen-fashion22.com",
      gaPropertyId: "513746872",
      gscSiteUrl: "https://toleen-fashion22.com/"
    });
  });

  it("locks GA tools to the environment property", () => {
    expect(requireGaProperty(websiteFromEnv(toleenEnv))).toBe(
      "properties/513746872"
    );
    expect(requireGaProperty(websiteFromEnv(layalEnv))).toBe(
      "properties/528542206"
    );
  });

  it("locks GSC tools to the environment property", () => {
    expect(requireGscProperty(websiteFromEnv(layalEnv))).toBe(
      "sc-domain:layaldress.com"
    );
    expect(
      requireGscProperty(
        websiteFromEnv({
          ...layalEnv,
          BRAND_SITE_URL: "",
          GSC_SITE_URL: "sc-domain:layaldress.com"
        })
      )
    ).toBe("sc-domain:layaldress.com");
  });

  it("rejects incomplete placeholder GSC Workers", () => {
    expect(() =>
      requireGscProperty(
        websiteFromEnv({
          ...layalEnv,
          BRAND_SLUG: "asom",
          BRAND_LABEL: "Asom Fashion",
          BRAND_SITE_URL: "",
          GSC_SITE_URL: ""
        })
      )
    ).toThrow('Worker "asom" has no GSC_SITE_URL');
  });

  it("supports the optional Ahmed Aydoutty GSC Worker", () => {
    expect(
      requireGscProperty(
        websiteFromEnv({
          ...layalEnv,
          BRAND_SLUG: "ahmedayoutty",
          BRAND_LABEL: "Ahmed Aydoutty",
          BRAND_SITE_URL: "https://ahmedayoutty.com/",
          GA_ACCOUNT_ID: "",
          GA_ACCOUNT_NAME: "",
          GA_PROPERTY_ID: "",
          GSC_SITE_URL: "sc-domain:ahmedayoutty.com"
        })
      )
    ).toBe("sc-domain:ahmedayoutty.com");
  });
});

describe("Google resource normalization", () => {
  it("normalizes GA resource names", () => {
    expect(normalizePropertyId(513746872)).toBe("properties/513746872");
    expect(normalizePropertyId("properties/513746872")).toBe(
      "properties/513746872"
    );
  });

  it("normalizes Search Console properties", () => {
    expect(normalizeSiteUrl("HTTPS://LAYALDRESS.COM")).toBe(
      "https://layaldress.com/"
    );
    expect(normalizeSiteUrl("sc-domain:Example.COM")).toBe(
      "sc-domain:example.com"
    );
  });

  it("keeps inspected and sitemap URLs inside the Worker property", () => {
    expect(
      assertUrlBelongsToGscProperty(
        "https://layaldress.com/sitemap.xml",
        "https://layaldress.com/"
      )
    ).toBe("https://layaldress.com/sitemap.xml");
    expect(() =>
      assertUrlBelongsToGscProperty(
        "https://other.example/sitemap.xml",
        "https://layaldress.com/"
      )
    ).toThrow("outside Search Console property");
    expect(
      assertUrlBelongsToGscProperty(
        "https://shop.example.com/sitemap.xml",
        "sc-domain:example.com"
      )
    ).toBe("https://shop.example.com/sitemap.xml");
  });
});
