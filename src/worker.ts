import { Container, getContainer, getRandom } from "@cloudflare/containers";

import {
  authenticateOAuthToken,
  ClerkApiError,
  createApiKey,
  getApiKeySecret,
  readConfig,
} from "./helpers";
import { apiKeySchema } from "./schemas/api-keys";

const instanceCount = 3;
const cliApiKeyName = "Mainroom CLI";
const machinePath = "/v0/machines";
const tokenproxyEntrypoint = [
  "tokenproxy",
  "-c",
  "server.bind='0.0.0.0:8787'",
  "-c",
  "server.allow_non_loopback=true",
];

type Env = {
  AUTH_MODE?: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_ALLOW_HTTP?: string;
  AWS_DEFAULT_REGION?: string;
  AWS_ENDPOINT?: string;
  AWS_ENDPOINT_URL_S3?: string;
  AWS_REGION?: string;
  AWS_BUCKET?: string;
  AWS_REQUEST_PAYER?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  CLERK_API_URL?: string;
  CLERK_API_VERSION?: string;
  CLERK_OAUTH_AUTHORIZE_URL?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_OAUTH_TOKEN_URL?: string;
  CLERK_SECRET_KEY: string;
  CORS_ORIGIN?: string;
  MACHINE_CONTROL_TOKEN: string;
  MAINROOM_CONTAINER: DurableObjectNamespace<MainroomContainer>;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  USER_MACHINE_CONTAINER: DurableObjectNamespace<UserMachineContainer>;
};

type UserMachineRecord = {
  apiKeyId: string;
  id: string;
  subject: string;
};

export class MainroomContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      ...s3EnvVars(env),
      ...optionalEnvVars(env, [
        "AUTH_MODE",
        "CLERK_API_URL",
        "CLERK_API_VERSION",
        "CLERK_OAUTH_AUTHORIZE_URL",
        "CLERK_OAUTH_CLIENT_ID",
        "CLERK_OAUTH_TOKEN_URL",
      ]),
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CORS_ORIGIN: env.CORS_ORIGIN ?? "https://mainroom.sh",
      NODE_ENV: "production",
      PORT: "3000",
    };
  }
}

export class UserMachineContainer extends Container<Env> {
  defaultPort = 8787;
  sleepAfter = "30m";
  storageKey = "user-machine";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      MACHINE_KIND: "user",
      NODE_ENV: "production",
    };
  }

  async create(record: UserMachineRecord): Promise<{
    apiKeyId: string;
    id: string;
    state: Awaited<ReturnType<UserMachineContainer["getState"]>>;
    subject: string;
  }> {
    await this.ctx.storage.put(this.storageKey, record);
    await this.startMachine(record);

    return {
      apiKeyId: record.apiKeyId,
      id: record.id,
      state: await this.getState(),
      subject: record.subject,
    };
  }

  async info(): Promise<{
    apiKeyId?: string;
    id?: string;
    state: Awaited<ReturnType<UserMachineContainer["getState"]>>;
    subject?: string;
  }> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );

    return {
      ...record,
      state: await this.getState(),
    };
  }

  async delete(): Promise<void> {
    await this.destroy();
    await this.ctx.storage.delete(this.storageKey);
  }

  override async fetch(request: Request): Promise<Response> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );

    if (record) {
      await this.startMachine(record);
    }

    return super.fetch(request);
  }

  private async startMachine(record: UserMachineRecord): Promise<void> {
    const { secret } = await getApiKeySecret(
      workerAppConfig(this.env),
      record.apiKeyId,
    );

    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          ...this.envVars,
          ...s3EnvVars(this.env),
          TOKENPROXY_CLIENT_KEY: secret,
          USER_MACHINE_ID: record.id,
          USER_SUBJECT: record.subject,
        },
        entrypoint: tokenproxyEntrypoint,
        labels: {
          machine: record.id,
          subject: record.subject,
        },
      },
    });
  }
}

function proxiedRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const cf = request.cf;

  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  headers.set("x-mainroom-host", url.hostname);

  if (typeof cf?.colo === "string") headers.set("x-mainroom-cf-colo", cf.colo);
  if (typeof cf?.country === "string") {
    headers.set("x-mainroom-cf-country", cf.country);
  }
  if (typeof cf?.continent === "string") {
    headers.set("x-mainroom-cf-continent", cf.continent);
  }

  return new Request(request, { headers });
}

async function machineRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (
    url.pathname !== machinePath &&
    !url.pathname.startsWith(`${machinePath}/`)
  ) {
    return undefined;
  }

  const auth = authorizeMachineRequest(request, env);
  if (auth) return auth;

  if (request.method === "POST" && url.pathname === machinePath) {
    const body = await readJson(request);
    const apiKeyId =
      typeof body.apiKeyId === "string" ? body.apiKeyId.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";

    if (!apiKeyId) {
      return json({ error: "apiKeyId is required" }, 400);
    }

    if (!subject) {
      return json({ error: "subject is required" }, 400);
    }

    const id = machineId(subject);
    const machine = getContainer(env.USER_MACHINE_CONTAINER, id);

    return json(
      await machine.create({
        apiKeyId,
        id,
        subject,
      }),
    );
  }

  const match = url.pathname.match(/^\/v0\/machines\/([^/]+)$/);
  if (!match) return json({ error: "Not found" }, 404);

  const id = decodeURIComponent(match[1] ?? "");
  if (!id) return json({ error: "machine id is required" }, 400);

  const machine = getContainer(env.USER_MACHINE_CONTAINER, id);

  if (request.method === "GET") {
    return json(await machine.info());
  }

  if (request.method === "DELETE") {
    await machine.delete();
    return json({ id, deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function cliAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (
    url.pathname !== "/v0/auth/cli/config" &&
    url.pathname !== "/v0/auth/cli/exchange"
  ) {
    return undefined;
  }

  if (request.method === "GET" && url.pathname === "/v0/auth/cli/config") {
    if (
      !env.CLERK_OAUTH_AUTHORIZE_URL ||
      !env.CLERK_OAUTH_CLIENT_ID ||
      !env.CLERK_OAUTH_TOKEN_URL
    ) {
      return json(
        { error: "Browser login is not configured for this Mainroom instance" },
        501,
      );
    }

    return json({
      authorizeUrl: env.CLERK_OAUTH_AUTHORIZE_URL,
      clientId: env.CLERK_OAUTH_CLIENT_ID,
      tokenUrl: env.CLERK_OAUTH_TOKEN_URL,
    });
  }

  if (request.method === "POST" && url.pathname === "/v0/auth/cli/exchange") {
    try {
      const config = workerAppConfig(env);
      const { userId } = await authenticateOAuthToken(config, request);
      const apiKey = apiKeySchema.parse(
        await createApiKey(config, {
          name: cliApiKeyName,
          subject: userId,
          description: "Created by Mainroom CLI",
          createdBy: userId,
        }),
      );

      if (!apiKey.secret) {
        return json(
          { error: "Mainroom could not create a CLI credential" },
          502,
        );
      }

      return json({
        apiKey: {
          id: apiKey.id,
          subject: apiKey.subject,
          secret: apiKey.secret,
        },
      });
    } catch (error) {
      const response = cliAuthError(error);
      return json({ error: response.error }, response.status);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}

function cliAuthError(error: unknown): {
  error: string;
  status: 400 | 401 | 502;
} {
  if (error instanceof ClerkApiError) {
    if (error.status === 401) return { error: "Login failed", status: 401 };
    if (error.status >= 400 && error.status < 500) {
      return { error: error.message, status: 400 };
    }
  }

  return { error: "Mainroom could not complete login", status: 502 };
}

function authorizeMachineRequest(
  request: Request,
  env: Env,
): Response | undefined {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  if (!env.MACHINE_CONTROL_TOKEN || token !== env.MACHINE_CONTROL_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }

  return undefined;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function machineId(subject: string): string {
  return `user:${subject}`;
}

function workerAppConfig(env: Env) {
  return readConfig({
    AUTH_MODE: env.AUTH_MODE,
    CLERK_API_URL: env.CLERK_API_URL,
    CLERK_API_VERSION: env.CLERK_API_VERSION,
    CLERK_OAUTH_AUTHORIZE_URL: env.CLERK_OAUTH_AUTHORIZE_URL,
    CLERK_OAUTH_CLIENT_ID: env.CLERK_OAUTH_CLIENT_ID,
    CLERK_OAUTH_TOKEN_URL: env.CLERK_OAUTH_TOKEN_URL,
    CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
    CORS_ORIGIN: env.CORS_ORIGIN,
    NODE_ENV: "production",
    PORT: "3000",
  });
}

function s3EnvVars(env: Env): Record<string, string> {
  const envVars = optionalEnvVars(env, [
    "AWS_ACCESS_KEY_ID",
    "AWS_ALLOW_HTTP",
    "AWS_BUCKET",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT",
    "AWS_ENDPOINT_URL_S3",
    "AWS_REGION",
    "AWS_REQUEST_PAYER",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "R2_ACCOUNT_ID",
    "R2_BUCKET_NAME",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_SECRET_ACCESS_KEY",
    "S3_SESSION_TOKEN",
  ]);

  if (envVars.S3_BUCKET && !envVars.AWS_BUCKET) {
    envVars.AWS_BUCKET = envVars.S3_BUCKET;
  }

  if (envVars.AWS_BUCKET && !envVars.S3_BUCKET) {
    envVars.S3_BUCKET = envVars.AWS_BUCKET;
  }

  if (envVars.S3_ENDPOINT && !envVars.AWS_ENDPOINT_URL_S3) {
    envVars.AWS_ENDPOINT_URL_S3 = envVars.S3_ENDPOINT;
  }

  if (envVars.AWS_ENDPOINT_URL_S3 && !envVars.S3_ENDPOINT) {
    envVars.S3_ENDPOINT = envVars.AWS_ENDPOINT_URL_S3;
  }

  if (envVars.S3_REGION && !envVars.AWS_REGION) {
    envVars.AWS_REGION = envVars.S3_REGION;
  }

  if (envVars.AWS_REGION && !envVars.S3_REGION) {
    envVars.S3_REGION = envVars.AWS_REGION;
  }

  if (envVars.AWS_DEFAULT_REGION && !envVars.S3_REGION) {
    envVars.S3_REGION = envVars.AWS_DEFAULT_REGION;
    envVars.AWS_REGION = envVars.AWS_DEFAULT_REGION;
  }

  if (!envVars.S3_BUCKET && env.R2_BUCKET_NAME) {
    envVars.S3_BUCKET = env.R2_BUCKET_NAME;
    envVars.AWS_BUCKET = env.R2_BUCKET_NAME;
  }

  if (!envVars.S3_ENDPOINT && !envVars.AWS_ENDPOINT_URL_S3) {
    const endpoint = r2Endpoint(env.R2_ACCOUNT_ID);
    if (endpoint) {
      envVars.S3_ENDPOINT = endpoint;
      envVars.AWS_ENDPOINT_URL_S3 = endpoint;
    }
  }

  if (!envVars.S3_REGION && !envVars.AWS_REGION) {
    envVars.S3_REGION = "auto";
    envVars.AWS_REGION = "auto";
  }

  if (!envVars.AWS_DEFAULT_REGION) {
    envVars.AWS_DEFAULT_REGION = envVars.AWS_REGION;
  }

  return envVars;
}

function optionalEnvVars(
  env: Env,
  names: Array<keyof Env & string>,
): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const name of names) {
    const value = env[name];

    if (typeof value === "string" && value.length > 0) {
      envVars[name] = value;
    }
  }

  return envVars;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function r2Endpoint(accountId: string | undefined): string | undefined {
  return accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : undefined;
}

export default {
  async fetch(request, env) {
    /*
     * USE WORKERS FOR PUBLIC CONTROL-PLANE ROUTES, NOT CONTAINERS.
     *
     * CONTAINERS CAN STAY WARM ACROSS DEPLOYS, SO NEW ENV VARS OR ROUTES MAY
     * NOT BE AVAILABLE IMMEDIATELY. KEEP LOGIN, OAUTH, HEALTH, AND OTHER
     * DEPLOYMENT-SENSITIVE ENTRYPOINTS IN THE WORKER BEFORE THIS FALLTHROUGH.
     */
    const cliResponse = await cliAuthRequest(request, env);
    if (cliResponse) return cliResponse;

    const machineResponse = await machineRequest(request, env);
    if (machineResponse) return machineResponse;

    const container = await getRandom(env.MAINROOM_CONTAINER, instanceCount);
    return container.fetch(proxiedRequest(request));
  },
} satisfies ExportedHandler<Env>;
