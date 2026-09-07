# Work2 vs `work` — architecture comparison and tool roadmap

Two repos in this account expose Google data to MCP clients as Cloudflare Workers:

| | **Work2** (this repo) | **work** (`fitiedu2024-wq/work`) |
| --- | --- | --- |
| Google product | GA4 + Search Console | Merchant Center |
| Brands | Layal, Toleen (+ stub envs) | Layal, Asom |
| Live Workers | 4 (GA + GSC per brand) | 2 (one per merchant account) |
| Tools per Worker | GA 11 · GSC 7 | ~124 |

This document answers two questions: **which architecture is the better base**, and **how far the tool surface can grow**.

---

## 1. Verdict

**Keep Work2's infrastructure. Port `work`'s product conventions into it.**

Work2 has the cleaner, more modern skeleton (stateless MCP handler, resource-bound tokens, host allowlist, retries, real tests, one Google client per API). `work` has the far better *tool product*: rich titles, MCP annotations, `change_summary` on writes, shaped reports, and a scoped "universal read" escape hatch. Neither repo should be rewritten; Work2 should adopt the `work` conventions listed in §4, and its tool surface should grow along §5.

---

## 2. Side-by-side

| Area | Work2 | work | Better |
| --- | --- | --- | --- |
| **MCP transport** | Stateless `createMcpHandler` (agents ≥0.22). No Durable Object. | `McpAgent` Durable Object + SQLite migration per env. | **Work2** — fewer moving parts, no DO binding to copy per env, cheaper. |
| **MCP SDK** | `@modelcontextprotocol/server` 2.x | `@modelcontextprotocol/sdk` (via agents 0.17) | Work2 (current). |
| **Auth to the connector** | Shared password (`MCP_LOGIN_PASSWORD`), KV brute-force limiter, constant-time compare. | Google Sign-In, allow-listed to one Gmail address, CSRF + state cookies. | **work** on identity (a real account, revocable, auditable). Work2 on simplicity (no Google OAuth client, no callback allow-list). |
| **OAuth provider** | `workers-oauth-provider` 0.10: RFC 8707 `resource` binding, `mcp:write` scope enforced, client-ID metadata docs. Token for Layal cannot call Toleen. | `workers-oauth-provider` 0.8: no resource check; any token for the Worker reaches `/mcp`. | **Work2**. |
| **Google auth** | Service account, JWT signed in Worker, in-memory token cache per isolate, single-flight refresh. | Service account, KV-cached token (shared across isolates), 15 s timeout. | Tie. Work2 avoids KV writes; `work` survives cold starts better. |
| **Outbound safety** | Host allowlist (`assertGoogleUrl`), 401 refresh, 429/5xx retry with backoff + jitter, `Retry-After` honoured. | Fixed origin, 401 refresh, 20 s timeout, no retry. | **Work2** (add `AbortSignal.timeout` from `work`). |
| **Multi-brand config** | One Wrangler file per product, every brand is a named env, no top-level deployable. | One Wrangler file, top level **is** Layal; envs for other stores. README documents the misdeploy foot-gun this creates. | **Work2**. |
| **CI / deploy** | Manual `npm run deploy:*`. | Cloudflare Workers Builds: push to `main` deploys all stores; non-main pushes upload previews. | **work** — Work2 should adopt Workers Builds. |
| **Tests** | 8 Vitest tests on scope/lock logic, passing. | A template "Hello World" spec that does not match the code; no test script. | **Work2**. |
| **Type hygiene** | `wrangler types` output committed (regenerated on this branch; was hand-trimmed and broke `tsc`). | 588 KB `worker-configuration.d.ts` committed. | Tie after this branch. |
| **Tool metadata** | *Before this branch:* no `title`, **no annotations**. *Now:* every tool has a title, read/write/action annotations, and writes take `change_summary`. | Every tool has a title and read/write/action annotations; every write takes `change_summary`. | Tie after this branch (ported from `work`). |
| **Tool depth** | *Before:* thin wrappers over the raw API. *Now:* raw wrappers plus shaped reports, opportunity finders, indexing audits, cross-source SEO tools, and scoped universal reads (GA 76, GSC 31, Insights 111 tools). | Raw wrappers **plus** shaped reports (`get_product_performance`, `get_best_sellers`…), diagnostics (`render_*_issues`), universal scoped `merchant_api_read` / `merchant_api_write`, `batch_*`. | Tie after this branch. |
| **Discoverability** | *Now:* `describe_capabilities` on every Worker, `get_metadata` for GA field names. | `list_merchant_capabilities` catalog tool. | Tie after this branch. |
| **Scope locking** | Property/site from env; URLs asserted inside the GSC property; account summaries filtered. | Account ID from env; universal paths must contain only that account; sub-API allowlist. | Tie — both are solid; the universal-tool path validator in `work` is the pattern Work2 needs. |
| **Template leftovers** | None. | `public/index.html` and `test/index.spec.ts` are unmodified Wrangler boilerplate. | Work2. |

---

## 3. Why not standardise on `work`?

- Its Durable-Object session model forces a `durable_objects` + `migrations` block into every env and costs more than a stateless handler for read-mostly analytics tools.
- Its OAuth layer predates resource indicators; a token minted for one Worker is not cryptographically tied to that Worker's `/mcp`.
- Its single-file, top-level-is-Layal Wrangler layout already caused enough confusion to need a "preview trigger must pass `--env`" warning in the README.
- Its only test is broken boilerplate.

Those are exactly the things Work2 got right. Conversely, everything `work` does better is *additive* (metadata, tool design, CI) and ports cleanly.

---

## 4. What to port from `work` into Work2 (cross-cutting)

1. **Annotations and titles on every tool.**
   `readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }` for reads; `writeAnnotations` with `destructiveHint: true` for annotation/sitemap writes; an `actionAnnotations` tier for quota-spending, non-mutating calls (e.g. URL inspection). Keep the existing `confirm: true` on deletes as belt-and-braces.
2. **`change_summary` on every write** so the approval dialog shows intent.
3. **A capability catalog tool** (`describe_capabilities`) that returns what this Worker can do, its brand lock, and the approval rule.
4. **Universal scoped read tools**, modelled on `merchant_api_read`:
   - `ga_api_read` — GET/POST to `analyticsadmin` / `analyticsdata`, path must be `properties/{GA_PROPERTY_ID}/…` or `…:run*Report`; POST allowed only for `:run*`, `:batchRun*`, `:checkCompatibility`, `:runAccessReport`.
   - `gsc_api_read` — GET to `webmasters/v3/sites/{GSC_SITE_URL}/…` and POST to `searchAnalytics/query` / `urlInspection/index:inspect` with `siteUrl` forced from env.
   These cover every current and future endpoint without a dedicated tool. **No universal write** for GA/GSC — the write surface is small and should stay explicit.
5. **`AbortSignal.timeout`** on Google fetches (15–20 s) so a hung upstream cannot hold a Worker request.
6. **Workers Builds** wired to `main` with `--env <brand>` production and `versions upload --env <brand>` preview triggers, exactly as documented in `work`'s README.
7. **Consider one Worker per brand for GA + GSC combined** ("Layal Google Insights"). The service-account key already carries both scopes. Benefits: 2 connectors instead of 4, one OAuth login per brand, and cross-source tools become possible (see §5.3). Cost: one more Wrangler file, or merge the two.

---

## 5. Tool roadmap

### 5.1 Google Analytics Worker (today: 11 tools)

Current: `get_account_summaries`, `get_property_details`, `list_google_ads_links`, `get_custom_dimensions_and_metrics`, `list_property_annotations`, `create/update/delete_property_annotation`, `run_report`, `run_realtime_report`, `run_funnel_report`.

**Tier A — raw API gaps (Data API v1beta unless noted)**

| Tool | Endpoint | Why |
| --- | --- | --- |
| `get_metadata` | `properties/{id}/metadata` | Lists every dimension/metric (incl. custom) the property supports. Without it the model guesses names. **Highest priority.** |
| `check_compatibility` | `:checkCompatibility` | Validate a dimension/metric combination before `run_report` fails. |
| `run_pivot_report` | `:runPivotReport` | Cross-tab reports (e.g. channel × device). |
| `batch_run_reports` | `:batchRunReports` | Up to 5 reports in one call; halves latency for dashboards. |
| `list_audience_exports` / `create_audience_export` / `query_audience_export` | `audienceExports` | Pull user lists for audiences. |
| `list_data_streams` / `get_data_stream` | Admin `dataStreams` | Measurement IDs, stream URLs, enhanced-measurement settings (v1alpha). |
| `list_key_events` / `create_key_event` / `update_key_event` / `delete_key_event` | Admin `keyEvents` | Conversions. Writes → `writeAnnotations`. |
| `list_audiences` | Admin v1alpha `audiences` | Audience definitions. |
| `get_data_retention_settings` | Admin `dataRetentionSettings` | Compliance check. |
| `list_measurement_protocol_secrets` | Admin `dataStreams/*/measurementProtocolSecrets` | Server-side event setup. |
| `list_channel_groups` | Admin v1alpha `channelGroups` | Custom channel definitions. |
| `get_attribution_settings` | Admin v1alpha `attributionSettings` | Model / lookback window. |
| `list_bigquery_links`, `list_search_ads_360_links`, `list_firebase_links`, `list_dv360_links` | Admin | Integration inventory. |
| `list_access_bindings` | Admin v1alpha `accessBindings` | Who has access to the property. |
| `run_access_report` | Admin `:runAccessReport` | Data-access audit log. |
| `search_change_history` | Admin `accounts/{id}:searchChangeHistoryEvents` | "Who changed what" for the property. |
| `list_calculated_metrics`, `list_expanded_data_sets`, `list_event_create_rules` | Admin v1alpha | Advanced config inventory. |

**Tier B — shaped e-commerce reports** (both brands are fashion stores; these are what an operator actually asks for). Each is a fixed `run_report` with validated inputs, following `get_product_performance` in `work`:

| Tool | Dimensions / metrics |
| --- | --- |
| `get_traffic_overview` | date · sessions, totalUsers, newUsers, engagementRate, averageSessionDuration, conversions, purchaseRevenue |
| `get_acquisition_channels` | sessionDefaultChannelGroup (or sessionSource/Medium, sessionCampaignName) · sessions, engagedSessions, conversions, purchaseRevenue |
| `get_ecommerce_overview` | date · ecommercePurchases, purchaseRevenue, averagePurchaseRevenue, transactions, itemsPurchased, cartToViewRate, purchaseToViewRate |
| `get_product_performance` | itemName / itemId / itemBrand / itemCategory · itemsViewed, itemsAddedToCart, itemsCheckedOut, itemsPurchased, itemRevenue |
| `get_checkout_funnel` | `run_funnel_report` preset: view_item → add_to_cart → begin_checkout → add_payment_info → purchase |
| `get_landing_pages` | landingPage · sessions, bounceRate, conversions, purchaseRevenue |
| `get_top_pages` | pagePath · screenPageViews, averageEngagementTime, conversions |
| `get_geo_breakdown` | country / region / city · sessions, conversions, purchaseRevenue |
| `get_device_breakdown` | deviceCategory · sessions, conversionRate, purchaseRevenue |
| `get_campaign_performance` | sessionCampaignName, sessionSource, sessionMedium · sessions, conversions, purchaseRevenue |
| `get_site_search_terms` | searchTerm · eventCount (view_search_results), conversions |
| `get_events_breakdown` | eventName · eventCount, totalUsers, eventValue |
| `compare_periods` | Any of the above with `dateRanges[2]` and computed deltas |
| `get_realtime_overview` | `run_realtime_report` preset: activeUsers by country / page / device |

**Tier C — universal**: `ga_api_read` (see §4). Optional `ga_api_write` scoped to `properties/{id}` for annotations, key events, and custom definitions **only if** the explicit write tools above are not enough.

Approximate result: **11 → ~45 tools**.

### 5.2 Google Search Console Worker (today: 7 tools)

Current: `list_sites`, `search_analytics`, `inspect_url`, `list_sitemaps`, `get_sitemap`, `submit_sitemap`, `delete_sitemap`.

The Search Console API is small: `sites` (list/get/add/delete), `sitemaps` (list/get/submit/delete), `searchanalytics.query`, `urlInspection.index.inspect`. Work2 already covers everything except `sites.get` (worth adding) and `sites.add/delete` (should stay excluded on a brand-locked Worker). **Crawl stats, Core Web Vitals, manual actions, security issues, and removals have no public API** and cannot be added.

Growth therefore comes from **shaped tools over `searchanalytics.query`** and **bounded batching of `inspect_url`**:

| Tool | What it does |
| --- | --- |
| `get_site_details` | `sites.get` — permission level for the service account. |
| `get_top_queries` | Queries by clicks/impressions/CTR/position for a range, optional country/device/page filter. |
| `get_top_pages` | Pages by the same metrics. |
| `get_page_queries` | All queries that drive one page. |
| `get_query_pages` | All pages ranking for one query (cannibalisation check). |
| `get_daily_trend` | Clicks/impressions/CTR/position by date; optional `dataState=all` for fresh data. |
| `compare_periods` | Two ranges, same dimensions, returns deltas and % change. |
| `find_striking_distance_keywords` | Queries at position 8–20 with impressions above a threshold — quick-win targets. |
| `find_ctr_opportunities` | Queries with high impressions and CTR below the position-expected curve. |
| `get_device_country_breakdown` | device × country matrix. |
| `get_search_appearance_breakdown` | Rich results, merchant listings, product snippets etc. |
| `get_discover_performance` / `get_news_performance` | `type=discover` / `googleNews`. |
| `get_brand_vs_nonbrand` | Splits queries on a configurable brand regex (defaults from `BRAND_LABEL`). |
| `inspect_urls` | Bounded batch of `inspect_url` (≤ 20 URLs, concurrency 3) — respects the 600/min, 2 000/day inspection quota. |
| `get_index_coverage_sample` | Fetches the brand sitemap, samples N URLs, inspects them, summarises verdicts (indexed / crawled-not-indexed / excluded). |
| `audit_sitemap` | `get_sitemap` + `inspect_urls` on sitemap errors/warnings. |
| `find_orphan_pages` | Pages with impressions in Search but absent from the submitted sitemaps. |
| `gsc_api_read` | Universal scoped read (see §4). |

Approximate result: **7 → ~25 tools**.

### 5.3 Cross-source tools (only if GA + GSC share a Worker per brand)

| Tool | Joins |
| --- | --- |
| `get_landing_page_seo_overview` | GSC clicks/position per page ⨝ GA sessions/conversions/revenue per landing page. |
| `find_pages_losing_traffic` | GSC period comparison + GA revenue impact. |
| `get_query_to_revenue` | Top queries → their landing pages → GA purchase revenue attributed to organic sessions. |
| `annotate_seo_event` | Creates a GA annotation from a GSC finding (e.g. sitemap resubmission, index drop). |

### 5.4 Not recommended

- **Indexing API** (`urlNotifications:publish`) — Google restricts it to JobPosting / BroadcastEvent pages; use on a fashion store risks quota revocation.
- **Universal write for GA/GSC** — the write surface is tiny; explicit tools with `change_summary` are safer.
- **`sites.add` / `sites.delete`** — contradicts the brand lock.

---

## 6. Phases and status

| Phase | Status |
| --- | --- |
| 1. Hygiene: lockfile sync, full `wrangler types` output, `.gitignore` covers secret filenames | **Done** |
| 2. Conventions: annotations + titles + `change_summary` + `describe_capabilities` + fetch timeouts | **Done** |
| 3. GA Tier A + `get_metadata`; GSC `get_site_details` + `inspect_urls` | **Done** (endpoints verified against the Google discovery documents for Admin v1beta/v1alpha, Data v1beta/v1alpha, Search Console v1) |
| 4. Shaped reports (GA Tier B, GSC shaped tools) | **Done** — 17 GA report presets + funnel + realtime + compare; 17 GSC shaped/opportunity/indexing tools |
| 5. Universal scoped reads (`ga_api_read`, `gsc_api_read`) | **Done** |
| 6. Workers Builds on `main` | **Pending** — configured in the Cloudflare dashboard, not in code (see `work` README for the trigger table) |
| 7. Combined GA + GSC Worker per brand with cross-source tools (§5.3) | **Done in code** (`wrangler.insights.jsonc`, `src/insights/`); needs two KV namespaces and secrets before its first deploy |

Final tool counts: **GA 11 → 76**, **GSC 7 → 31**, **Insights 111** (GA `ga_*` + GSC `gsc_*` + 5 cross-source + `describe_capabilities`).

Deliberately not built: Measurement Protocol secret listing (returns secret values), `sites.add/delete`, the Indexing API, any universal write, and the deprecated mobile-friendly test endpoint.

---

## 7. Changes made on this branch

- `package-lock.json` regenerated — `npm ci` failed because `@types/node` was missing from the lock.
- `types/worker-configuration.d.ts` regenerated with `npm run types` — the committed file had been trimmed to the `Env` interface only, so `tsc` could not find `ExecutionContext`, `ExportedHandler`, or `KVNamespace`.
- `.gitignore` now excludes `GOOGLE_SERVICE_ACCOUNT_KEY.json`, `MCP_LOGIN_PASSWORD*`, `*-secrets/`, and archive files, matching the README's quick-start instructions.
- `src/shared/mcp.ts`: annotation constants, `execute`, `toolNamer`, `mapWithConcurrency`. `src/shared/google-api.ts`: 20 s `AbortSignal.timeout` on every Google call.
- `src/ga/`: client extended (Admin list/get generics, key events, custom definitions, access report, change history, metadata, compatibility, pivot, batch, audience exports, quota snapshot, scoped `gaApiRead`); `report-shaping.ts` (simplify, compare periods, shaped-report catalogue); tools split into `tools-config.ts`, `tools-data.ts`, `tools-reports.ts`.
- `src/gsc/`: client extended (`sites.get`, simple filters, sitemap XML download/parse with property check, scoped `gscApiRead`); `analytics-shaping.ts` (flatten, compare, striking distance, CTR curve, brand split, cannibalisation, inspection summary); `tools.ts`.
- `src/insights/server.ts` + `src/insights-worker.ts` + `wrangler.insights.jsonc`: combined per-brand Worker with cross-source tools.
- Tests: 37 Vitest tests, including in-memory MCP client smoke tests that connect to each server, list tools, assert titles/annotations/uniqueness, and call tools.
- README rewritten with the tool inventory and the Insights deploy steps.

Verified after the changes: `npm run typecheck`, `npm test` (37/37), and `npm run build` (dry-run deploy of every GA, GSC, and Insights env) all pass.
