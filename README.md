   Editor covers its properties; otherwise grant Editor per property.
2. Search Console: **Settings → Users and permissions**, add
   `$SERVICE_ACCOUNT_EMAIL`, and grant **Full**, not Restricted.

The same service-account key can power every Worker here and future Google MCP
Workers. Keys do not contain OAuth scopes: each future Worker must still request
its API scopes, enable its API, and receive the required IAM/product grants.
Never commit the JSON key.

## 2. Install and create OAuth KV namespaces

```bash
npm install
npx wrangler login

npx wrangler kv namespace create layal-google-analytics-mcp-oauth
npx wrangler kv namespace create toleen-google-analytics-mcp-oauth
npx wrangler kv namespace create asom-google-analytics-mcp-oauth
npx wrangler kv namespace create layal-google-search-console-mcp-oauth
npx wrangler kv namespace create toleen-google-search-console-mcp-oauth
npx wrangler kv namespace create asom-google-search-console-mcp-oauth
```

Put each returned namespace ID in the matching environment entry:

- GA IDs replace `REPLACE_WITH_<BRAND>_GA_OAUTH_KV_ID` in
  `wrangler.ga.jsonc`.
- GSC IDs replace `REPLACE_WITH_<BRAND>_GSC_OAUTH_KV_ID` in
  `wrangler.gsc.jsonc`.

KV bindings are not inherited between Wrangler environments, which is why each
environment declares its own `OAUTH_KV`.

## 3. Confirm website locks

Edit only the non-secret `vars` in each Wrangler environment:

Analytics:

```jsonc
"vars": {
  "BRAND_SLUG": "toleen",
  "BRAND_LABEL": "Toleen Fashion",
  "BRAND_SITE_URL": "https://toleen-fashion22.com/",
  "GA_ACCOUNT_ID": "375645449",
  "GA_ACCOUNT_NAME": "toleen-fashion22.com",
  "GA_PROPERTY_ID": "513746872",
  "GSC_SITE_URL": ""
}
```

Search Console:

```jsonc
"vars": {
  "BRAND_SLUG": "toleen",
  "BRAND_LABEL": "Toleen Fashion",
  "BRAND_SITE_URL": "https://toleen-fashion22.com/",
  "GA_ACCOUNT_ID": "",
  "GA_ACCOUNT_NAME": "",
  "GA_PROPERTY_ID": "",
  "GSC_SITE_URL": "https://toleen-fashion22.com/"
}
```

An empty property remains safely unusable: discovery/property tools return a
clear setup error instead of falling back to another website. Layal's
`get_account_summaries` can use account `387714621` to find its property ID;
then set `GA_PROPERTY_ID` before using reports or mutations.

## 4. Set shared secrets on all six Workers

Create one long random connector password, then upload the same service-account
key and password to every environment:

```bash
read -rsp "MCP connector password: " MCP_PASSWORD; echo

for config in wrangler.ga.jsonc wrangler.gsc.jsonc; do
  for brand in layal toleen asom; do
    npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY \
      --config "$config" --env "$brand" < google-service-account-key.json
    printf '%s' "$MCP_PASSWORD" | npx wrangler secret put MCP_LOGIN_PASSWORD \
      --config "$config" --env "$brand"
  done
done

unset MCP_PASSWORD
rm google-service-account-key.json
```

`GOOGLE_SERVICE_ACCOUNT_KEY` uses these Google scopes at runtime:

- Analytics Worker: `analytics` and annotation-required `analytics.edit`
- Search Console Worker: `webmasters`

## 5. Verify and deploy

```bash
npm run types
npm run test
npm run build

npm run deploy:ga:layal
npm run deploy:ga:toleen
npm run deploy:ga:asom
npm run deploy:gsc:layal
npm run deploy:gsc:toleen
npm run deploy:gsc:asom
```

## Custom MCP connector URLs

Replace `<YOUR_ACCOUNT_SUBDOMAIN>` with the subdomain Wrangler prints. Paste
each URL directly into Cursor's `AddMcpServer`, claude.ai's **Add custom
connector**, or any OAuth-capable remote MCP client.

| Connector | MCP URL |
| --- | --- |
| Layal Analytics | `https://layal-google-analytics-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |
| Toleen Analytics | `https://toleen-google-analytics-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |
| Asom Analytics | `https://asom-google-analytics-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |
| Layal Search Console | `https://layal-google-search-console-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |
| Toleen Search Console | `https://toleen-google-search-console-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |
| Asom Search Console | `https://asom-google-search-console-mcp.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/mcp` |

Every connector performs OAuth 2.1 discovery, opens `/authorize`, and requires
`MCP_LOGIN_PASSWORD`. The grant requires `mcp:write` and is bound to that exact
Worker's `/mcp` URL. A token from one website Worker cannot access another.

## Local development

```bash
cp .dev.vars.example .dev.vars
# Replace the service-account key and password placeholders.
