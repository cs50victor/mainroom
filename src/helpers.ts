import {
  createClerkClient,
  type APIKey,
  type ClerkClient,
} from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";

import type {
  CreateApiKeyParams,
  ListApiKeysParams,
  RevokeApiKeyParams,
  UpdateApiKeyParams,
  VerifyApiKeyParams,
} from "./schemas/api-keys";

export type AuthMode = "clerk" | "mock";

export type AppConfig = {
  authMode: AuthMode;
  clerkApiUrl: string;
  clerkApiVersion: string;
  clerkOAuthAuthorizeUrl?: string;
  clerkOAuthClientId?: string;
  clerkOAuthTokenUrl?: string;
  clerkSecretKey?: string;
  corsOrigins: string[];
  port: number;
};

type Env = Record<string, string | undefined>;

type ApiKeyList = Awaited<ReturnType<ClerkClient["apiKeys"]["list"]>>;
type DeletedObject = Awaited<ReturnType<ClerkClient["apiKeys"]["delete"]>>;
type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type MockApiKey = Mutable<APIKey> & {
  secret: string;
};

const reservedCliUsernames = new Set([
  "accounts",
  "cli-bin-releases",
  "clerk",
  "clkmail",
]);

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
    clerkApiUrl: normalizeClerkApiUrl(
      env.CLERK_API_URL ?? "https://api.clerk.com",
      env.CLERK_API_VERSION ?? "v1",
    ),
    clerkApiVersion: env.CLERK_API_VERSION ?? "v1",
    clerkOAuthAuthorizeUrl: env.CLERK_OAUTH_AUTHORIZE_URL,
    clerkOAuthClientId: env.CLERK_OAUTH_CLIENT_ID,
    clerkOAuthTokenUrl: env.CLERK_OAUTH_TOKEN_URL,
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
): Promise<APIKey> {
  if (config.authMode === "mock") {
    return createMockApiKey(params);
  }

  return clerkApi(config, (client) => client.apiKeys.create(params));
}

export async function listApiKeys(
  config: AppConfig,
  params: ListApiKeysParams,
): Promise<ApiKeyList> {
  if (config.authMode === "mock") {
    return listMockApiKeys(params);
  }

  return clerkApi(config, (client) => client.apiKeys.list(params));
}

export async function getApiKey(
  config: AppConfig,
  apiKeyID: string,
): Promise<APIKey> {
  if (config.authMode === "mock") {
    return withoutSecret(getMockApiKey(apiKeyID));
  }

  return clerkApi(config, (client) => client.apiKeys.get(apiKeyID));
}

export async function updateApiKey(
  config: AppConfig,
  apiKeyID: string,
  params: UpdateApiKeyParams,
): Promise<APIKey> {
  if (config.authMode === "mock") {
    return updateMockApiKey(apiKeyID, params);
  }

  return clerkApi(config, (client) =>
    client.apiKeys.update({ apiKeyId: apiKeyID, ...params }),
  );
}

export async function deleteApiKey(
  config: AppConfig,
  apiKeyID: string,
): Promise<DeletedObject> {
  if (config.authMode === "mock") {
    getMockApiKey(apiKeyID);
    mockApiKeys.delete(apiKeyID);
    return { id: apiKeyID, slug: null, object: "api_key", deleted: true };
  }

  return clerkApi(config, (client) => client.apiKeys.delete(apiKeyID));
}

export async function getApiKeySecret(
  config: AppConfig,
  apiKeyID: string,
): Promise<{ secret: string }> {
  if (config.authMode === "mock") {
    return { secret: getMockApiKey(apiKeyID).secret };
  }

  return clerkApi(config, (client) => client.apiKeys.getSecret(apiKeyID));
}

export async function revokeApiKey(
  config: AppConfig,
  apiKeyID: string,
  params: RevokeApiKeyParams,
): Promise<APIKey> {
  if (config.authMode === "mock") {
    const apiKey = getMockApiKey(apiKeyID);
    const now = Date.now();

    apiKey.revoked = true;
    apiKey.revocationReason = params.revocationReason ?? null;
    apiKey.updatedAt = now;

    return withoutSecret(apiKey);
  }

  return clerkApi(config, (client) =>
    client.apiKeys.revoke({ apiKeyId: apiKeyID, ...params }),
  );
}

export async function verifyApiKey(
  config: AppConfig,
  params: VerifyApiKeyParams,
): Promise<APIKey> {
  if (config.authMode === "mock") {
    const apiKey = [...mockApiKeys.values()].find(
      (candidate) => candidate.secret === params.secret,
    );

    if (!apiKey || apiKey.revoked || isExpired(apiKey)) {
      throw new ClerkApiError(401, "Unauthorized", undefined);
    }

    apiKey.lastUsedAt = Date.now();
    return withoutSecret(apiKey);
  }

  return clerkApi(config, (client) => client.apiKeys.verify(params.secret));
}

export async function authenticateOAuthToken(
  config: AppConfig,
  request: Request,
): Promise<{ userId: string }> {
  if (config.authMode === "mock") {
    return { userId: "user_mock" };
  }

  if (!config.clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
  }

  const client = createClerkClient({
    secretKey: config.clerkSecretKey,
    apiUrl: config.clerkApiUrl,
    apiVersion: config.clerkApiVersion,
    userAgent: "mainroom/0.1.0",
    telemetry: { disabled: true },
  });
  const state = await client.authenticateRequest(request, {
    acceptsToken: "oauth_token",
  });

  if (!state.isAuthenticated) {
    throw new ClerkApiError(401, "Unauthorized", undefined);
  }

  const auth = state.toAuth();
  if (!auth.isAuthenticated || auth.tokenType !== "oauth_token") {
    throw new ClerkApiError(401, "Unauthorized", undefined);
  }

  return { userId: auth.userId };
}

export async function createCliApiKey(
  config: AppConfig,
  request: Request,
  username: unknown,
): Promise<{ apiKey: APIKey; username?: string }> {
  const { userId } = await authenticateOAuthToken(config, request);
  const verifiedUsername =
    typeof username === "string"
      ? await verifyCliSignupUsername(config, userId, username)
      : undefined;

  return {
    apiKey: await createApiKey(config, {
      name: "Mainroom CLI",
      subject: userId,
      description: "Created by Mainroom CLI",
      createdBy: userId,
    }),
    username: verifiedUsername,
  };
}

async function verifyCliSignupUsername(
  config: AppConfig,
  userId: string,
  value: string,
): Promise<string> {
  const username = value.trim();
  const error = cliUsernameError(username);
  if (error) throw new ClerkApiError(400, error, undefined);

  if (config.authMode === "mock") return username;

  const user = await clerkApi(config, (client) => client.users.getUser(userId));
  if (user.username === username) return username;
  if (user.username) {
    throw new ClerkApiError(
      409,
      `Clerk user already has username ${user.username}`,
      undefined,
    );
  }

  // NOTE(clerk): updateUser enforces username syntax and instance-wide uniqueness.
  // https://github.com/clerk/clerk-docs/blob/main/docs/reference/backend/user/update-user.mdx
  await clerkApi(config, (client) =>
    client.users.updateUser(userId, { username }),
  );

  return username;
}

function cliUsernameError(username: string): string | undefined {
  // NOTE(mainroom): keep only subdomain reservations here; Clerk owns username rules.
  // https://github.com/clerk/clerk-docs/blob/main/docs/reference/backend/user/update-user.mdx
  if (!username) return "Username is required";
  if (username.includes("domainkey")) {
    return "Username cannot contain domainkey";
  }
  if (reservedCliUsernames.has(username)) {
    return `${username}.mainroom.sh is already reserved`;
  }

  return undefined;
}

export async function isCliUsernameTaken(
  config: AppConfig,
  username: string,
): Promise<boolean> {
  const error = cliUsernameError(username);
  if (error) return true;
  if (config.authMode === "mock") return false;

  const users = await clerkApi(config, (client) =>
    client.users.getUserList({ username: [username], limit: 1 }),
  );

  return users.data.length > 0;
}

async function clerkApi<T>(
  config: AppConfig,
  callback: (client: ClerkClient) => Promise<T>,
): Promise<T> {
  if (!config.clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
  }

  const client = createClerkClient({
    secretKey: config.clerkSecretKey,
    apiUrl: config.clerkApiUrl,
    apiVersion: config.clerkApiVersion,
    userAgent: "mainroom/0.1.0",
    telemetry: { disabled: true },
  });

  try {
    return await callback(client);
  } catch (error) {
    if (isClerkAPIResponseError(error)) {
      throw new ClerkApiError(
        error.status ?? 502,
        error.errors[0]?.longMessage ??
          error.errors[0]?.message ??
          "API key service request failed",
        error,
      );
    }

    throw error;
  }
}

function createMockApiKey(params: CreateApiKeyParams): APIKey {
  const now = Date.now();
  const secret = mockSecret();
  const apiKey: MockApiKey = {
    id: mockId(),
    type: "api_key",
    subject: params.subject,
    name: params.name,
    description: params.description ?? null,
    claims: params.claims ?? null,
    scopes: params.scopes ?? [],
    secret,
    revoked: false,
    revocationReason: null,
    expired: false,
    expiration:
      params.secondsUntilExpiration == null
        ? null
        : now + params.secondsUntilExpiration * 1000,
    createdBy: params.createdBy ?? null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  mockApiKeys.set(apiKey.id, apiKey);
  return { ...apiKey };
}

function listMockApiKeys(params: ListApiKeysParams): ApiKeyList {
  const includeInvalid = params.includeInvalid ?? false;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 10;
  const data = [...mockApiKeys.values()]
    .filter((apiKey) => apiKey.subject === params.subject)
    .filter(
      (apiKey) => includeInvalid || (!apiKey.revoked && !isExpired(apiKey)),
    )
    .map(withoutSecret);

  return {
    data: data.slice(offset, offset + limit),
    totalCount: data.length,
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
): APIKey {
  const apiKey = getMockApiKey(apiKeyID);
  const now = Date.now();

  if ("claims" in params) apiKey.claims = params.claims ?? null;
  if ("scopes" in params) apiKey.scopes = params.scopes ?? [];
  if ("description" in params) apiKey.description = params.description ?? null;
  apiKey.subject = params.subject;
  if ("secondsUntilExpiration" in params) {
    apiKey.expiration =
      params.secondsUntilExpiration == null
        ? null
        : now + params.secondsUntilExpiration * 1000;
  }
  apiKey.updatedAt = now;

  return withoutSecret(apiKey);
}

function withoutSecret(apiKey: MockApiKey): APIKey {
  const { secret: _secret, ...rest } = apiKey;
  return { ...rest, expired: isExpired(apiKey) };
}

function isExpired(apiKey: APIKey): boolean {
  return apiKey.expiration !== null && apiKey.expiration <= Date.now();
}

function normalizeClerkApiUrl(apiUrl: string, apiVersion: string): string {
  const url = new URL(apiUrl);
  const versionSuffix = `/${apiVersion}`;

  if (url.pathname.endsWith(versionSuffix)) {
    url.pathname = url.pathname.slice(0, -versionSuffix.length) || "/";
  }

  return url.toString().replace(/\/$/, "");
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
