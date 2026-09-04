import { z } from "zod";

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

const serviceAccountSchema = z.object({
  type: z.literal("service_account").optional(),
  client_email: z.string().email(),
  private_key: z.string().min(100),
  token_uri: z.string().url().optional()
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional()
});

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();
const pendingTokens = new Map<string, Promise<string>>();

function encodeBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePrivateKey(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  if (!base64) throw new Error("The service account private_key is not PKCS#8 PEM.");

  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  } catch {
    throw new Error("The service account private_key contains invalid base64.");
  }
}

async function cacheKey(rawKey: string, scope: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${rawKey}\n${scope}`)
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function createAssertion(
  clientEmail: string,
  privateKey: string,
  scope: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: clientEmail,
    scope,
    aud: GOOGLE_TOKEN_URI,
    iat: now,
    exp: now + 3500
  });
  const unsigned = `${header}.${claims}`;

  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      decodePrivateKey(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Unable to import the service account private_key. Use the unmodified JSON key."
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function parseServiceAccount(rawKey: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawKey);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON. Store the complete service account key."
    );
  }

  const result = serviceAccountSchema.safeParse(decoded);
  if (!result.success) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY is invalid: ${result.error.issues[0]?.message ?? "unknown error"}`
    );
  }
  if (result.data.token_uri && result.data.token_uri !== GOOGLE_TOKEN_URI) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY token_uri must be ${GOOGLE_TOKEN_URI}.`
    );
  }
  return result.data;
}

async function mintAccessToken(rawKey: string, scope: string, key: string): Promise<string> {
  const serviceAccount = parseServiceAccount(rawKey);
  const assertion = await createAssertion(
    serviceAccount.client_email,
    serviceAccount.private_key,
    scope
  );

  const response = await fetch(GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Google token exchange returned invalid JSON (${response.status}).`);
  }

  if (!response.ok) {
    const detail = z
      .object({
        error: z.string().optional(),
        error_description: z.string().optional()
      })
      .safeParse(payload);
    const message = detail.success
      ? detail.data.error_description ?? detail.data.error
      : undefined;
    throw new Error(
      `Google token exchange failed (${response.status})${message ? `: ${message}` : "."}`
    );
  }

  const token = tokenResponseSchema.safeParse(payload);
  if (!token.success) throw new Error("Google token exchange returned an invalid response.");

  tokenCache.set(key, {
    accessToken: token.data.access_token,
    expiresAt: Date.now() + Math.max(0, token.data.expires_in - 60) * 1000
  });
  return token.data.access_token;
}

export async function getGoogleAccessToken(rawKey: string, scope: string): Promise<string> {
  if (!rawKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY secret is not configured.");
  }

  const key = await cacheKey(rawKey, scope);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const pending = pendingTokens.get(key);
  if (pending) return pending;

  const request = mintAccessToken(rawKey, scope, key).finally(() => {
    pendingTokens.delete(key);
  });
  pendingTokens.set(key, request);
  return request;
}

export async function invalidateGoogleAccessToken(
  rawKey: string,
  scope: string
): Promise<void> {
  tokenCache.delete(await cacheKey(rawKey, scope));
}
