export type AuthMode = "clerk" | "mock";

export type AppConfig = {
  authMode: AuthMode;
  clerkApiUrl: string;
  clerkSecretKey?: string;
  corsOrigins: string[];
  port: number;
};

export type CreateApiKeyParams = {
  type?: string;
  name: string;
  description?: string | null;
  subject: string;
  claims?: unknown | null;
  scopes?: string[];
  created_by?: string | null;
  seconds_until_expiration?: number | null;
};

export type ListApiKeysParams = {
  type?: string;
  subject: string;
  include_invalid?: "true" | "false";
  limit?: number;
  offset?: number;
  query?: string;
};

export type UpdateApiKeyParams = {
  claims?: unknown | null;
  scopes?: string[];
  description?: string | null;
  subject?: string;
  seconds_until_expiration?: number | null;
};

export type RevokeApiKeyParams = {
  revocation_reason?: string | null;
};

export type ApiKeyResource = {
  object: "api_key";
  id: string;
  type: string;
  subject: string;
  name: string;
  description?: string | null;
  claims: unknown | null;
  scopes: string[];
  secret?: string;
  revoked: boolean;
  revocation_reason: string | null;
  expired: boolean;
  expiration: number | null;
  created_by: string | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

type Env = Record<string, string | undefined>;

type MockApiKey = ApiKeyResource & {
  secret: string;
};

const mockApiKeys = new Map<string, MockApiKey>();

export class ClerkApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "ClerkApiError";
  }
}

export function readConfig(env: Env): AppConfig {
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  const authMode =
    env.AUTH_MODE ?? (env.NODE_ENV === "production" ? "clerk" : "mock");
  const clerkSecretKey = env.CLERK_SECRET_KEY;
  const corsOrigins = (env.CORS_ORIGIN ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (authMode !== "clerk" && authMode !== "mock") {
    throw new Error("AUTH_MODE must be either clerk or mock");
  }

  if (authMode === "mock" && env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=mock is not allowed when NODE_ENV=production");
  }

  if (authMode === "clerk" && !clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    authMode,
    clerkApiUrl: env.CLERK_API_URL ?? "https://api.clerk.com/v1",
    clerkSecretKey,
    corsOrigins,
    port,
  };
}

export function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const prefix = "Bearer ";

  if (!authorization?.startsWith(prefix)) {
    return undefined;
  }

  return authorization.slice(prefix.length) || undefined;
}

export async function isApiKeyValid(
  config: AppConfig,
  secret: string,
): Promise<boolean> {
  if (config.authMode === "mock") {
    return true;
  }

  try {
    await verifyApiKey(config, { secret });
    return true;
  } catch {
    return false;
  }
}

export async function createApiKey(
  config: AppConfig,
  params: CreateApiKeyParams,
): Promise<unknown> {
  if (config.authMode === "mock") {
    return createMockApiKey(params);
  }

  return clerkRequest(config, "/api_keys", {
    method: "POST",
    body: params,
  });
}

export async function listApiKeys(
  config: AppConfig,
  params: ListApiKeysParams,
): Promise<unknown> {
  if (config.authMode === "mock") {
    return listMockApiKeys(params);
  }

  return clerkRequest(config, "/api_keys", {
    method: "GET",
    query: params,
  });
}

export async function getApiKey(
  config: AppConfig,
  apiKeyID: string,
): Promise<unknown> {
  if (config.authMode === "mock") {
    return withoutSecret(getMockApiKey(apiKeyID));
  }

  return clerkRequest(config, `/api_keys/${encodeURIComponent(apiKeyID)}`, {
    method: "GET",
  });
}

export async function updateApiKey(
  config: AppConfig,
  apiKeyID: string,
  params: UpdateApiKeyParams,
): Promise<unknown> {
  if (config.authMode === "mock") {
    return updateMockApiKey(apiKeyID, params);
  }

  return clerkRequest(config, `/api_keys/${encodeURIComponent(apiKeyID)}`, {
    method: "PATCH",
    body: params,
  });
}

export async function deleteApiKey(
  config: AppConfig,
  apiKeyID: string,
): Promise<unknown> {
  if (config.authMode === "mock") {
    getMockApiKey(apiKeyID);
    mockApiKeys.delete(apiKeyID);
    return { id: apiKeyID, object: "api_key", deleted: true };
  }

  return clerkRequest(config, `/api_keys/${encodeURIComponent(apiKeyID)}`, {
    method: "DELETE",
  });
}

export async function getApiKeySecret(
  config: AppConfig,
  apiKeyID: string,
): Promise<unknown> {
  if (config.authMode === "mock") {
    return { secret: getMockApiKey(apiKeyID).secret };
  }

  return clerkRequest(
    config,
    `/api_keys/${encodeURIComponent(apiKeyID)}/secret`,
    {
      method: "GET",
    },
  );
}

export async function revokeApiKey(
  config: AppConfig,
  apiKeyID: string,
  params: RevokeApiKeyParams,
): Promise<unknown> {
  if (config.authMode === "mock") {
    const apiKey = getMockApiKey(apiKeyID);
    const now = Date.now();

    apiKey.revoked = true;
    apiKey.revocation_reason = params.revocation_reason ?? null;
    apiKey.updated_at = now;

    return withoutSecret(apiKey);
  }

  return clerkRequest(
    config,
    `/api_keys/${encodeURIComponent(apiKeyID)}/revoke`,
    {
      method: "POST",
      body: params,
    },
  );
}

export async function verifyApiKey(
  config: AppConfig,
  params: { secret: string },
): Promise<unknown> {
  if (config.authMode === "mock") {
    const apiKey = [...mockApiKeys.values()].find(
      (candidate) => candidate.secret === params.secret,
    );

    if (!apiKey || apiKey.revoked || isExpired(apiKey)) {
      throw new ClerkApiError(401, "Unauthorized", undefined);
    }

    apiKey.last_used_at = Date.now();
    return withoutSecret(apiKey);
  }

  return clerkRequest(config, "/api_keys/verify", {
    method: "POST",
    body: params,
  });
}

async function clerkRequest(
  config: AppConfig,
  path: string,
  init: {
    method: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  },
): Promise<unknown> {
  if (!config.clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
  }

  const url = new URL(path, config.clerkApiUrl);

  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.clerkSecretKey}`,
      "Clerk-API-Version": "2026-05-12",
      "Content-Type": "application/json",
      "User-Agent": "mainroom/0.1.0",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    throw new ClerkApiError(
      response.status,
      clerkErrorMessage(payload, response.statusText),
      payload,
    );
  }

  return payload;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function clerkErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback || "Clerk request failed";
  }

  const errors = (payload as { errors?: unknown }).errors;

  if (!Array.isArray(errors)) {
    return fallback || "Clerk request failed";
  }

  const firstError = errors[0];

  if (typeof firstError !== "object" || firstError === null) {
    return fallback || "Clerk request failed";
  }

  const message = (firstError as { long_message?: unknown; message?: unknown })
    .long_message;

  if (typeof message === "string") {
    return message;
  }

  const shortMessage = (firstError as { message?: unknown }).message;

  return typeof shortMessage === "string"
    ? shortMessage
    : fallback || "Clerk request failed";
}

function createMockApiKey(params: CreateApiKeyParams): ApiKeyResource {
  const now = Date.now();
  const secret = mockSecret();
  const apiKey: MockApiKey = {
    object: "api_key",
    id: mockId(),
    type: params.type ?? "api_key",
    subject: params.subject,
    name: params.name,
    description: params.description,
    claims: params.claims ?? null,
    scopes: params.scopes ?? [],
    secret,
    revoked: false,
    revocation_reason: null,
    expired: false,
    expiration:
      params.seconds_until_expiration == null
        ? null
        : now + params.seconds_until_expiration * 1000,
    created_by: params.created_by ?? null,
    last_used_at: null,
    created_at: now,
    updated_at: now,
  };

  mockApiKeys.set(apiKey.id, apiKey);
  return { ...apiKey };
}

function listMockApiKeys(params: ListApiKeysParams): unknown {
  const includeInvalid = params.include_invalid === "true";
  const query = params.query?.toLowerCase();
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 10;
  const data = [...mockApiKeys.values()]
    .filter((apiKey) => apiKey.subject === params.subject)
    .filter((apiKey) => !params.type || apiKey.type === params.type)
    .filter(
      (apiKey) => includeInvalid || (!apiKey.revoked && !isExpired(apiKey)),
    )
    .filter(
      (apiKey) =>
        !query ||
        apiKey.id.toLowerCase().includes(query) ||
        apiKey.name.toLowerCase().includes(query) ||
        apiKey.description?.toLowerCase().includes(query),
    )
    .map(withoutSecret);

  return {
    data: data.slice(offset, offset + limit),
    total_count: data.length,
  };
}

function getMockApiKey(apiKeyID: string): MockApiKey {
  const apiKey = mockApiKeys.get(apiKeyID);

  if (!apiKey) {
    throw new ClerkApiError(404, "API key not found", undefined);
  }

  return apiKey;
}

function updateMockApiKey(
  apiKeyID: string,
  params: UpdateApiKeyParams,
): ApiKeyResource {
  const apiKey = getMockApiKey(apiKeyID);
  const now = Date.now();

  if ("claims" in params) apiKey.claims = params.claims ?? null;
  if ("scopes" in params) apiKey.scopes = params.scopes ?? [];
  if ("description" in params) apiKey.description = params.description;
  if (params.subject !== undefined) apiKey.subject = params.subject;
  if ("seconds_until_expiration" in params) {
    apiKey.expiration =
      params.seconds_until_expiration == null
        ? null
        : now + params.seconds_until_expiration * 1000;
  }
  apiKey.updated_at = now;

  return withoutSecret(apiKey);
}

function withoutSecret(apiKey: MockApiKey): ApiKeyResource {
  const { secret: _secret, ...rest } = apiKey;
  return { ...rest, expired: isExpired(apiKey) };
}

function isExpired(apiKey: ApiKeyResource): boolean {
  return apiKey.expiration !== null && apiKey.expiration <= Date.now();
}

function mockId(): string {
  return `ak_${hex(16)}`;
}

function mockSecret(): string {
  return `ak_${hex(32)}`;
}

function hex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
