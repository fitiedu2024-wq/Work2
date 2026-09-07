import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createGaServer } from "../src/ga/server";
import { createGscServer } from "../src/gsc/server";
import { createInsightsServer } from "../src/insights/server";

const env = {
  BRAND_SLUG: "layal",
  BRAND_LABEL: "Layal Dress",
  BRAND_SITE_URL: "https://layaldress.com/",
  GA_ACCOUNT_ID: "387714621",
  GA_ACCOUNT_NAME: "فساتين ليال",
  GA_PROPERTY_ID: "528542206",
  GSC_SITE_URL: "sc-domain:layaldress.com",
  GOOGLE_SERVICE_ACCOUNT_KEY: "",
  MCP_LOGIN_PASSWORD: "",
  OAUTH_KV: {} as KVNamespace
} satisfies Env;

async function listTools(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools: Array<{ name: string; title?: string; annotations?: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...(page.tools as typeof tools));
    cursor = page.nextCursor;
  } while (cursor);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { tools, call, close: () => client.close() };
}

function expectWellFormed(tools: Array<{ name: string; title?: string; annotations?: Record<string, unknown> }>) {
  const names = tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
  for (const tool of tools) {
    expect(tool.title, `${tool.name} needs a title`).toBeTruthy();
    expect(tool.annotations, `${tool.name} needs annotations`).toBeDefined();
    expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
  }
}

describe("MCP servers", () => {
  it("GA server registers a rich, well-formed tool set", async () => {
    const { tools, call, close } = await listTools(createGaServer(env));
    expectWellFormed(tools);
    expect(tools.length).toBeGreaterThanOrEqual(60);
    const names = new Set(tools.map((tool) => tool.name));
    for (const expected of [
      "describe_capabilities",
      "get_metadata",
      "run_report",
      "get_traffic_overview",
      "get_product_performance",
      "get_checkout_funnel",
      "compare_periods",
      "list_key_events",
      "create_key_event",
      "search_change_history",
      "ga_api_read"
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
    const writes = tools.filter((tool) => tool.annotations?.destructiveHint === true);
    expect(writes.map((tool) => tool.name)).toContain("delete_property_annotation");

    const capabilities = await call("describe_capabilities", {});
    expect(capabilities.isError).toBeFalsy();
    const text = (capabilities.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text).property).toBe("properties/528542206");

    // Without a service-account key, tools fail gracefully with isError.
    const failing = await call("get_property_details", {});
    expect(failing.isError).toBe(true);
    expect((failing.content as Array<{ text: string }>)[0]?.text).toContain("GOOGLE_SERVICE_ACCOUNT_KEY");
    await close();
  });

  it("GSC server registers a rich, well-formed tool set", async () => {
    const { tools, call, close } = await listTools(createGscServer(env));
    expectWellFormed(tools);
    expect(tools.length).toBeGreaterThanOrEqual(28);
    const names = new Set(tools.map((tool) => tool.name));
    for (const expected of [
      "describe_capabilities",
      "get_site_details",
      "search_analytics",
      "get_top_queries",
      "compare_periods",
      "find_striking_distance_keywords",
      "find_ctr_opportunities",
      "get_brand_vs_nonbrand",
      "inspect_urls",
      "get_index_coverage_sample",
      "find_orphan_pages",
      "gsc_api_read"
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
    const inspect = tools.find((tool) => tool.name === "inspect_url");
    expect(inspect?.annotations?.readOnlyHint).toBe(false);
    expect(inspect?.annotations?.destructiveHint).toBe(false);

    const outside = await call("inspect_url", { inspectionUrl: "https://other.example/page" });
    expect(outside.isError).toBe(true);
    expect((outside.content as Array<{ text: string }>)[0]?.text).toContain("outside Search Console property");
    await close();
  });

  it("combined Insights server prefixes both tool sets and adds cross-source tools", async () => {
    const { tools, call, close } = await listTools(createInsightsServer(env));
    expectWellFormed(tools);
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("ga_run_report")).toBe(true);
    expect(names.has("gsc_get_top_queries")).toBe(true);
    expect(names.has("ga_compare_periods")).toBe(true);
    expect(names.has("gsc_compare_periods")).toBe(true);
    for (const expected of [
      "describe_capabilities",
      "get_organic_overview",
      "get_landing_page_seo_overview",
      "find_pages_losing_organic_traffic",
      "get_query_to_revenue",
      "annotate_seo_event"
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
    expect(tools.length).toBeGreaterThanOrEqual(95);
    const capabilities = await call("describe_capabilities", {});
    const text = (capabilities.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text).analytics.universal).toBe("ga_api_read");
    expect(names.has("ga_api_read")).toBe(true);
    expect(names.has("gsc_api_read")).toBe(true);
    expect(names.has("ga_ga_api_read")).toBe(false);
    await close();
  });
});
