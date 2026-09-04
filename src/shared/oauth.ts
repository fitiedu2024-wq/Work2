import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import type { WorkerFetchHandler } from "./mcp";

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const htmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character] ?? character;
  });
}

function loginPage(
  title: string,
  action: string,
  clientName: string,
  error?: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize ${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #172033; }
    main { width: min(25rem, calc(100% - 2rem)); box-sizing: border-box; padding: 2rem; border: 1px solid #d9dde5; border-radius: 1rem; background: white; box-shadow: 0 1rem 3rem #18233a14; }
    h1 { margin: 0 0 .5rem; font-size: 1.35rem; }
    p { margin: 0 0 1.25rem; color: #596174; line-height: 1.5; }
    label { display: block; margin-bottom: .4rem; font-weight: 650; }
    input { width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #aab1bf; border-radius: .55rem; font: inherit; }
    button { width: 100%; margin-top: .8rem; padding: .75rem; border: 0; border-radius: .55rem; background: #1f63e9; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .error { padding: .7rem; border-radius: .5rem; background: #ffebee; color: #9e1623; }
    @media (prefers-color-scheme: dark) {
      body { background: #10131a; color: #eef1f7; }
      main { background: #191e29; border-color: #343b49; }
      p { color: #b4bdce; }
      input { background: #10131a; color: #eef1f7; border-color: #596174; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p><strong>${escapeHtml(clientName)}</strong> is requesting read and write access to this MCP connector.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      <label for="password">Connector password</label>
      <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
      <button type="submit">Authorize connector</button>
    </form>
  </main>
</body>
</html>`;
}


function authorizationSuccessPage(redirectTo: string): string {
  const safeHref = escapeHtml(redirectTo);
  const safeJs = JSON.stringify(redirectTo);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${safeHref}">
  <title>Authorization complete</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #172033; }
    main { width: min(28rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #d9dde5; border-radius: 1rem; background: white; }
    a { color: #1f63e9; font-weight: 700; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Authorization complete</h1>
    <p>If this window does not continue automatically, open this link to finish connecting:</p>
    <p><a href="${safeHref}" rel="noopener">Continue to Cursor</a></p>
  </main>
  <script>window.location.replace(${safeJs});</script>
</body>
</html>`;
}

function oauthErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) {
    console.error(JSON.stringify({ event: "oauth_authorization_error", error: String(error) }));
    return new Response("Authorization failed.", { status: 500 });
  }
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }

  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function oauthRequestError(
  request: AuthRequest,
  code: "invalid_scope" | "invalid_target",
  description: string
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

function authorizedResource(request: AuthRequest, origin: string): string | undefined {
  if (typeof request.resource !== "string") return undefined;
  try {
    const resource = new URL(request.resource);
    if (
      resource.origin !== origin ||
      resource.search ||
      resource.hash ||
      resource.pathname !== "/mcp"
    ) {
      return undefined;
    }
    return `${resource.origin}${resource.pathname}`;
  } catch {
    return undefined;
  }
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function resourceUserId(resource: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(resource)
  );
  const suffix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `ecommerce-operator-${suffix}`;
}

async function attemptKey(request: Request): Promise<string> {
  const source =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const bytes = new Uint8Array(digest);
  const key = Array.from(bytes.slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `app:oauth-login-attempts:${key}`;
}

async function readAttempts(env: OAuthEnv, key: string): Promise<number> {
  const value = await env.OAUTH_KV.get(key);
  const attempts = Number(value ?? "0");
  return Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function createAuthorizationHandler(title: string): ExportedHandler<OAuthEnv> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/authorize" && request.method === "GET") {
        if (!env.MCP_LOGIN_PASSWORD) {
          return new Response("MCP_LOGIN_PASSWORD secret is not configured.", {
            status: 500
          });
        }
        try {
          const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
          const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
          if (!client) return new Response("Unknown OAuth client.", { status: 400 });
          if (!oauthRequest.scope.includes("mcp:write")) {
            return oauthRequestError(
              oauthRequest,
              "invalid_scope",
              'The "mcp:write" scope is required.'
            );
          }
          if (!authorizedResource(oauthRequest, url.origin)) {
            return oauthRequestError(
              oauthRequest,
              "invalid_target",
              "A valid, exact MCP endpoint resource is required."
            );
          }
          const action = `${url.pathname}${url.search}`;
          return new Response(
            loginPage(title, action, client.clientName ?? oauthRequest.clientId),
            { headers: htmlHeaders }
          );
        } catch (error) {
          return oauthErrorResponse(error);
        }
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        if (!env.MCP_LOGIN_PASSWORD) {
          return new Response("MCP_LOGIN_PASSWORD secret is not configured.", {
            status: 500
          });
        }

        let oauthRequest: AuthRequest;
        try {
          oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch (error) {
          return oauthErrorResponse(error);
        }

        const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
        if (!client) return new Response("Unknown OAuth client.", { status: 400 });
        if (!oauthRequest.scope.includes("mcp:write")) {
          return oauthRequestError(
            oauthRequest,
            "invalid_scope",
            'The "mcp:write" scope is required.'
          );
        }
        const resource = authorizedResource(oauthRequest, url.origin);
        if (!resource) {
          return oauthRequestError(
            oauthRequest,
            "invalid_target",
            "A valid, exact MCP endpoint resource is required."
          );
        }

        const key = await attemptKey(request);
        const attempts = await readAttempts(env, key);
        if (attempts >= 8) {
          return new Response("Too many failed attempts. Try again in 15 minutes.", {
            status: 429,
            headers: { "Cache-Control": "no-store", "Retry-After": "900" }
          });
        }

        const form = await request.formData();
        const password = String(form.get("password") ?? "").trim();
        const expectedPassword = String(env.MCP_LOGIN_PASSWORD ?? "").trim();
        if (!expectedPassword || !(await constantTimeEqual(password, expectedPassword))) {
          await env.OAUTH_KV.put(key, String(attempts + 1), { expirationTtl: 900 });
          return new Response(
            loginPage(
              title,
              `${url.pathname}${url.search}`,
              client.clientName ?? oauthRequest.clientId,
              "Incorrect password. Check for extra spaces and try again."
            ),
            { status: 401, headers: htmlHeaders }
          );
        }

        await env.OAUTH_KV.delete(key);
        let redirectTo: string;
        try {
          ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: oauthRequest,
            userId: await resourceUserId(resource),
            metadata: { clientName: client.clientName ?? oauthRequest.clientId },
            scope: ["mcp:write"],
            props: { authenticated: true, resource }
          }));
        } catch (error) {
          console.error(JSON.stringify({
            event: "oauth_complete_authorization_failed",
            error: String(error)
          }));
          if (error instanceof AuthorizationError) {
            return oauthErrorResponse(error);
          }
          return new Response(
            loginPage(
              title,
              `${url.pathname}${url.search}`,
              client.clientName ?? oauthRequest.clientId,
              `Authorization could not complete: ${error instanceof Error ? error.message : String(error)}`
            ),
            { status: 500, headers: htmlHeaders }
          );
        }
        return new Response(authorizationSuccessPage(redirectTo), {
          status: 200,
          headers: {
            ...htmlHeaders,
            Location: redirectTo
          }
        });
      }

      if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
        return Response.json({
          status: "ok",
          service: title,
          brand: env.BRAND_SLUG,
          mcpRoutes: ["/mcp"],
          auth: "password-continue-v3"
        });
      }

      return new Response("Not found.", { status: 404 });
    }
  };
}

export function createOAuthWorker(
  title: string,
  apiHandler: WorkerFetchHandler<Env>
): OAuthProvider<OAuthEnv> {
  const scopeEnforcingHandler: WorkerFetchHandler<OAuthEnv> = {
    async fetch(request, env, context) {
      const authorization = request.headers.get("Authorization") ?? "";
      const match = /^Bearer ([^\s]+)$/.exec(authorization);
      const token = match?.[1]
        ? await env.OAUTH_PROVIDER.unwrapToken(match[1])
        : null;
      if (!token?.scope.includes("mcp:write")) {
        return Response.json(
          { error: 'The "mcp:write" OAuth scope is required.' },
          {
            status: 403,
            headers: {
              "WWW-Authenticate":
                'Bearer error="insufficient_scope", scope="mcp:write"'
            }
          }
        );
      }
      return apiHandler.fetch(request, env, context);
    }
  };

  return new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: scopeEnforcingHandler,
    defaultHandler: createAuthorizationHandler(title),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["mcp:write"],
    resourceMetadata: {
      scopes_supported: ["mcp:write"],
      bearer_methods_supported: ["header"],
      resource_name: title
    }
  });
}
