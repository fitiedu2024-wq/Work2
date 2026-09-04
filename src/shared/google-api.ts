import { z } from "zod";
import {
  getGoogleAccessToken,
  invalidateGoogleAccessToken
} from "./google-auth";

const googleErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.unknown()).optional()
  })
});

const retryStatuses = new Set([429, 500, 502, 503, 504]);

function randomJitter(maximum: number): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return value % Math.max(1, maximum);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 5_000);
  }
  return 250 * 2 ** attempt + randomJitter(150);
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertGoogleUrl(url: string): void {
  const parsed = new URL(url);
  const allowedHosts = new Set([
    "analyticsadmin.googleapis.com",
    "analyticsdata.googleapis.com",
    "searchconsole.googleapis.com",
    "www.googleapis.com"
  ]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
    throw new Error(`Refusing unexpected Google API host: ${parsed.hostname}`);
  }
}

export async function fetchGoogleJson(
  rawKey: string,
  scope: string,
  url: string,
  init: RequestInit = {},
  options: { retryTransient?: boolean } = {}
): Promise<Record<string, unknown>> {
  assertGoogleUrl(url);
  let refreshedToken = false;
  let transientRetries = 0;

  for (;;) {
    const accessToken = await getGoogleAccessToken(rawKey, scope);
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (response.status === 401 && !refreshedToken) {
      await invalidateGoogleAccessToken(rawKey, scope);
      refreshedToken = true;
      continue;
    }

    if (
      options.retryTransient !== false &&
      retryStatuses.has(response.status) &&
      transientRetries < 2
    ) {
      await pause(retryDelay(response, transientRetries));
      transientRetries += 1;
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) return {};
      throw new Error(`Google API returned invalid JSON (${response.status}).`);
    }

    if (!response.ok) {
      const error = googleErrorSchema.safeParse(payload);
      const message = error.success ? error.data.error.message : undefined;
      const status = error.success ? error.data.error.status : undefined;
      throw new Error(
        `Google API request failed (${response.status}${status ? ` ${status}` : ""})${
          message ? `: ${message}` : "."
        }`
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Google API returned an unexpected response shape.");
    }
    return payload as Record<string, unknown>;
  }
}
