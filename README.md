# Work2 — Layal / Toleen GA + GSC MCP

Cloudflare Workers that expose **Model Context Protocol (MCP)** servers for Layal and Toleen.

| Brand | Product | Site |
| --- | --- | --- |
| **Layal** | Google Analytics + Google Search Console | https://layaldress.com/ |
| **Toleen** | Google Analytics + Google Search Console | https://toleen-fashion22.com/ |

Each Worker is OAuth-protected and talks to Google via a shared service-account key. Day-to-day work is ordinary code plus deploy scripts. The hard part is a **one-time handoff** of keys, password, and Cloudflare account access.

**Difficulty:** easy after onboarding · one-time secrets setup

---

## Secrets (out of band — never commit)

Someone with access must hand you these **outside git**:

| Secret / access | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_KEY.json` | Full Google service-account JSON key (Analytics + Search Console scopes) |
| `MCP_LOGIN_PASSWORD` | Shared connector login password for MCP OAuth |
| Cloudflare account access | Deploy under subdomain **`google-merchant-mcp`** (`*.google-merchant-mcp.workers.dev`) |

Also ensure the service account email is granted on each GA property (Editor) and each Search Console property (Full). Do **not** put the JSON key, password, or `.dev.vars` in this repo.

---

## Quick start (Layal + Toleen)

```bash
git clone https://github.com/fitiedu2024-wq/Work2.git
cd Work2
npm ci
npx wrangler login
```

### Upload secrets (once per Worker env)

Place the key file locally, then:

```bash
# GA — Layal & Toleen
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY --config wrangler.ga.jsonc --env layal < GOOGLE_SERVICE_ACCOUNT_KEY.json
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY --config wrangler.ga.jsonc --env toleen < GOOGLE_SERVICE_ACCOUNT_KEY.json
printf "%s" "$MCP_LOGIN_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD --config wrangler.ga.jsonc --env layal
printf "%s" "$MCP_LOGIN_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD --config wrangler.ga.jsonc --env toleen

# GSC — Layal & Toleen
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY --config wrangler.gsc.jsonc --env layal < GOOGLE_SERVICE_ACCOUNT_KEY.json
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY --config wrangler.gsc.jsonc --env toleen < GOOGLE_SERVICE_ACCOUNT_KEY.json
printf "%s" "$MCP_LOGIN_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD --config wrangler.gsc.jsonc --env layal
printf "%s" "$MCP_LOGIN_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD --config wrangler.gsc.jsonc --env toleen

# Clean up local copies when done
rm -f GOOGLE_SERVICE_ACCOUNT_KEY.json
unset MCP_LOGIN_PASSWORD
```

### Deploy

```bash
npm run deploy:live        # the four live Workers (GA + GSC for Layal and Toleen)
# or individually
npm run deploy:ga:layal
npm run deploy:ga:toleen
npm run deploy:gsc:layal
npm run deploy:gsc:toleen
```

Checks before deploy (all must pass):

```bash
npm run typecheck
npm run test
npm run build      # dry-run deploy of every env in every Wrangler config
```

### Optional: combined Insights Worker (one connector per brand)

`wrangler.insights.jsonc` deploys **one Worker per brand** that serves the GA tools (prefixed `ga_`), the Search Console tools (prefixed `gsc_`), and cross-source SEO tools that join both. Its OAuth KV namespaces (`layal-google-insights-mcp-oauth`, `toleen-google-insights-mcp-oauth`) already exist in the account and are referenced in the config. Upload the secrets, then deploy:

```bash
for env in layal toleen; do
  npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY --config wrangler.insights.jsonc --env $env < GOOGLE_SERVICE_ACCOUNT_KEY.json
  printf "%s" "$MCP_LOGIN_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD --config wrangler.insights.jsonc --env $env
done
npm run deploy:insights:layal
npm run deploy:insights:toleen
```

Resulting URLs: `https://layal-google-insights-mcp.google-merchant-mcp.workers.dev/mcp` and `https://toleen-google-insights-mcp.google-merchant-mcp.workers.dev/mcp`. The four single-product Workers keep working unchanged.

---

## Live MCP URLs

Paste into Cursor **Add MCP Server**, Claude custom connectors, or any OAuth-capable remote MCP client:

| Connector | URL |
| --- | --- |
| Layal Analytics | https://layal-google-analytics-mcp.google-merchant-mcp.workers.dev/mcp |
| Toleen Analytics | https://toleen-google-analytics-mcp.google-merchant-mcp.workers.dev/mcp |
| Layal Search Console | https://layal-google-search-console-mcp.google-merchant-mcp.workers.dev/mcp |
| Toleen Search Console | https://toleen-google-search-console-mcp.google-merchant-mcp.workers.dev/mcp |

Each connector runs OAuth 2.1 discovery, opens `/authorize`, and requires `MCP_LOGIN_PASSWORD`. Tokens are bound to that Worker’s `/mcp` URL (a Layal token cannot call Toleen).

---

## Tools

Every tool carries a title and MCP annotations (`readOnlyHint` / `destructiveHint`), so clients ask for approval before any write. Every write also takes `change_summary`. Call `describe_capabilities` on any connector for the live catalogue.

### Google Analytics Worker (76 tools)

| Group | Tools |
| --- | --- |
| **Shaped reports** (compact tables; pass `compareStartDate`/`compareEndDate` for deltas) | `get_traffic_overview`, `get_acquisition_channels`, `get_ecommerce_overview`, `get_product_performance`, `get_landing_pages`, `get_top_pages`, `get_geo_breakdown`, `get_device_breakdown`, `get_campaign_performance`, `get_site_search_terms`, `get_events_breakdown`, `get_key_events_breakdown`, `get_new_vs_returning`, `get_hourly_pattern`, `get_user_demographics`, `get_promotions`, `get_transactions`, `compare_periods`, `get_checkout_funnel`, `get_realtime_overview` |
| **Raw Data API** | `get_metadata` (dimension/metric catalogue), `check_compatibility`, `run_report`, `batch_run_reports`, `run_pivot_report`, `run_realtime_report`, `run_funnel_report`, `get_property_quotas`, `list/get/create/query_audience_export` |
| **Configuration reads** | `get_account_summaries`, `get_property_details`, `list_data_streams`, `get_data_stream`, `get_enhanced_measurement_settings`, `get_data_redaction_settings`, `list_event_create_rules`, `list_event_edit_rules`, `list_key_events`, `get_key_event`, `get_custom_dimensions_and_metrics`, `list_audiences`, `get_audience`, `list_channel_groups`, `list_calculated_metrics`, `list_expanded_data_sets`, `list_google_ads_links`, `list_firebase_links`, `list_bigquery_links`, `list_search_ads_360_links`, `list_dv360_advertiser_links`, `list_adsense_links`, `list_access_bindings`, `list_subproperty_event_filters`, `list_rollup_source_links`, `get_data_retention_settings`, `get_attribution_settings`, `get_google_signals_settings`, `get_reporting_identity_settings`, `get_user_provided_data_settings`, `list_property_annotations` |
| **Audit** | `run_access_report` (who read data), `search_change_history` (who changed configuration) |
| **Writes** (approval required) | `create/update/delete_key_event`, `create_custom_dimension`, `create_custom_metric`, `archive_custom_definition`, `create/update/delete_property_annotation` |
| **Universal** | `ga_api_read` — any Admin or Data API GET, or report POST, scoped to the property |

### Google Search Console Worker (31 tools)

| Group | Tools |
| --- | --- |
| **Performance** | `get_top_queries`, `get_top_pages`, `get_query_page_pairs`, `get_page_queries`, `get_query_pages`, `get_country_breakdown`, `get_device_breakdown`, `get_device_country_breakdown`, `get_search_appearance_breakdown`, `get_daily_trend`, `get_hourly_performance`, `get_discover_performance`, `compare_periods` |
| **Opportunities** | `find_striking_distance_keywords`, `find_ctr_opportunities`, `find_query_cannibalization`, `get_brand_vs_nonbrand` |
| **Indexing** | `inspect_url`, `inspect_urls` (batch, 3 in parallel), `get_index_coverage_sample` (sitemap → sample → inspect), `audit_sitemap`, `find_orphan_pages` |
| **Sitemaps** | `list_sitemaps`, `get_sitemap`, `submit_sitemap`, `delete_sitemap` |
| **Raw / universal** | `list_sites`, `get_site_details`, `search_analytics`, `gsc_api_read` |

Search Console data lags 2–3 days, so shaped tools default the end date to 3 days ago. URL inspection is limited by Google to 2,000 calls/day per property. Crawl stats, Core Web Vitals, manual actions, and removals have no public API.

### Combined Insights Worker (111 tools)

All GA tools as `ga_*`, all GSC tools as `gsc_*`, plus: `get_organic_overview`, `get_landing_page_seo_overview`, `find_pages_losing_organic_traffic`, `get_query_to_revenue`, `annotate_seo_event`.

---

## Repo layout

```
├── package.json              # scripts: deploy:*, build, test, typecheck
├── wrangler.ga.jsonc         # GA Worker envs (layal, toleen, …)
├── wrangler.gsc.jsonc        # GSC Worker envs (layal, toleen, …)
├── wrangler.insights.jsonc   # Combined GA+GSC Worker envs (layal, toleen)
├── .dev.vars.example         # local secret placeholders (copy → .dev.vars)
├── src/
│   ├── ga-worker.ts          # GA Worker entry
│   ├── gsc-worker.ts         # GSC Worker entry
│   ├── insights-worker.ts    # Combined Worker entry
│   ├── ga/                   # Analytics client, shaped-report catalogue, tool modules
│   ├── gsc/                  # Search Console client, analytics shaping, tools
│   ├── insights/             # Cross-source tools and combined server
│   └── shared/               # OAuth, Google auth, MCP helpers, brand locks
├── test/                     # Vitest: scope locks, shaping logic, in-memory MCP smoke tests
├── docs/                     # Architecture comparison and roadmap
└── types/                    # Generated Worker env types (npm run types)
```

Brand locks (site URL, GA property ID, GSC site) live in non-secret `vars` inside the Wrangler configs.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill GOOGLE_SERVICE_ACCOUNT_KEY and MCP_LOGIN_PASSWORD in .dev.vars

npm run dev:ga        # Layal GA on :8791
npm run dev:gsc       # Layal GSC on :8792
npm run dev:insights  # Layal combined on :8793
```

---

## Security notes

- **Never commit** `GOOGLE_SERVICE_ACCOUNT_KEY.json`, `.dev.vars`, `MCP_LOGIN_PASSWORD`, or any PEM/private key. `.gitignore` excludes these names, `*-secrets/`, and archives.
- Prefer `wrangler secret put` for production; keep local key files off disk after upload.
- Do not force-push or rewrite history that may have contained secrets — rotate keys instead if exposure is suspected.
- Universal read tools (`ga_api_read`, `gsc_api_read`) validate that every path stays inside the configured property and allow POST only for report verbs. There is no universal write.
- Measurement Protocol secrets are deliberately not exposed by any tool.

---

## Architecture comparison and tool roadmap

See [`docs/REPO_COMPARISON_AND_TOOL_ROADMAP.md`](docs/REPO_COMPARISON_AND_TOOL_ROADMAP.md) for how this repo compares with the `work` (Merchant Center) repo, which conventions were ported from it, and what remains.

## Other envs in this repo

`wrangler.*.jsonc` also lists stub/extra envs (e.g. `asom`, `ahmedayoutty`). Layal and Toleen GA + GSC are the supported live pair above. Treat other envs as incomplete unless you finish their KV IDs, vars, secrets, and IAM grants.
