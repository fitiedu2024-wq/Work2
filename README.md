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
npm install
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
npm run deploy:ga:layal
npm run deploy:ga:toleen
npm run deploy:gsc:layal
npm run deploy:gsc:toleen
```

Optional checks before deploy:

```bash
npm run typecheck
npm run test
npm run build
```

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

## Repo layout

```
├── package.json              # scripts: deploy:ga:*, deploy:gsc:*, test, build
├── wrangler.ga.jsonc         # GA Worker envs (layal, toleen, …)
├── wrangler.gsc.jsonc        # GSC Worker envs (layal, toleen, …)
├── .dev.vars.example         # local secret placeholders (copy → .dev.vars)
├── src/
│   ├── ga-worker.ts          # GA Worker entry
│   ├── gsc-worker.ts         # GSC Worker entry
│   ├── ga/                   # Analytics MCP server + Google client
│   ├── gsc/                  # Search Console MCP server + Google client
│   └── shared/               # OAuth, auth, MCP helpers, website locks
├── test/                     # Vitest scope/lock tests
└── types/                    # Generated Worker env types
```

Brand locks (site URL, GA property ID, GSC site) live in non-secret `vars` inside the Wrangler configs.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill GOOGLE_SERVICE_ACCOUNT_KEY and MCP_LOGIN_PASSWORD in .dev.vars

npm run dev:ga    # Layal GA on :8791
npm run dev:gsc   # Layal GSC on :8792
```

---

## Security notes

- **Never commit** `GOOGLE_SERVICE_ACCOUNT_KEY.json`, `.dev.vars`, `MCP_LOGIN_PASSWORD`, or any PEM/private key.
- `.gitignore` already excludes `.dev.vars`, secret filenames, `.wrangler/`, and `node_modules/`.
- Prefer `wrangler secret put` for production; keep local key files off disk after upload.
- Do not force-push or rewrite history that may have contained secrets — rotate keys instead if exposure is suspected.

---

## Other envs in this repo

`wrangler.*.jsonc` also lists stub/extra envs (e.g. `asom`, `ahmedayoutty`). Layal and Toleen GA + GSC are the supported live pair above. Treat other envs as incomplete unless you finish their KV IDs, vars, secrets, and IAM grants.
