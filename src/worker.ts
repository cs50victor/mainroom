import { Container, getContainer, getRandom } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";

import {
  bearerToken,
  ClerkApiError,
  createCliApiKey,
  getApiKeySecret,
  getCliSubjectUsername,
  getCliUsernameSubject,
  isCliUsernameTaken,
  readConfig,
  verifyApiKey,
} from "./helpers";
import { apiKeySchema } from "./schemas/api-keys";
import {
  authorizeShareGrant,
  inFlightKey,
  normalizeShareGrantInput,
  parsePeerRequestScope,
  providerConsumerKey,
  renderConsumerShare,
  renderPeerAccount,
  requiresPeerGrant,
  stripUntrustedPeerHeaders,
  upsertShareGrant,
  usageKey,
  type PeerRequestScope,
  type ShareGrantRecord,
} from "./shares";

const rootHost = "mainroom.sh";
const instanceCount = 3;
const machinePath = "/v0/machines";

/*
 * tokenproxy is the inference data plane; Mainroom only starts it and routes to it.
 *
 * Tokenproxy rollout invariant:
 *
 * Runtime/image/env changes must create a new user-machine generation, not
 * destroy the currently running generation. Tokenproxy traffic can include
 * long-lived /v1/chat/completions streams, /v1/responses streams, and
 * WebSockets; destroying the running container can visibly abort those
 * connections.
 *
 * Keep the runtime version in the explicit Container Durable Object id so new
 * requests route to the new generation while old requests drain on the old
 * generation until they finish or sleepAfter idles it out. If we add
 * load-balanced slots, keep the generation boundary and append the slot after
 * the version: user:<subject>:<version>:<slot>. Select only active-generation
 * slots for new requests; let older generations drain.
 *
 * References:
 * - Cloudflare Containers are Durable Object wrappers with lifecycle/state:
 *   https://developers.cloudflare.com/containers/container-class/
 * - Cloudflare Containers support explicit IDs and getRandom routing:
 *   https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/
 * - Cloudflare Containers forward WebSockets through fetch:
 *   https://developers.cloudflare.com/containers/examples/websocket/
 * - Durable Object WebSockets are long-lived TCP connections:
 *   https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * - Durable Object lifecycle keeps active WebSockets alive:
 *   https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
 * - Production analogs: Kubernetes rolling updates, AWS ELB deregistration
 *   draining, Envoy listener draining, and NGINX graceful reload:
 *   https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
 *   https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_DeregisterTargets.html
 *   https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/draining
 *   https://nginx.org/en/docs/control.html
 */
const tokenproxyRuntimeVersion = "v0.1.14";
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
  CLERK_PUBLISHABLE_KEY: string;
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
  SHARE_GRANT_STORE: DurableObjectNamespace<ShareGrantStore>;
  USER_MACHINE_CONTAINER: DurableObjectNamespace<UserMachineContainer>;
};

// Durable Object storage is the machine source of truth; tokenproxy process state is disposable.
// Future desired config fields belong here, while live tokenproxy status stays observational.
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
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
      CORS_ORIGIN: env.CORS_ORIGIN ?? "https://mainroom.sh",
      NODE_ENV: "production",
      PORT: "3000",
    };
  }
}

export class ShareGrantStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/grants") {
      const body = await readJson(request);
      const input = normalizeShareGrantInput(body.input);
      if ("error" in input) return json({ error: input.error }, 400);
      const identity = shareIdentityFrom(body.identity);
      const key = providerConsumerKey(
        identity.providerSubject,
        identity.consumerSubject,
      );
      const existing = await this.ctx.storage.get<ShareGrantRecord>(key);
      const grant = upsertShareGrant(
        existing,
        input,
        identity,
        new Date().toISOString(),
      );

      // Mainroom owns grant authority; tokenproxy receives only routing metadata.
      await this.ctx.storage.put(key, grant);
      console.log("share_grant_upsert", auditGrant(grant));

      return json({ grant });
    }

    if (request.method === "DELETE" && url.pathname === "/grants") {
      const body = await readJson(request);
      const providerSubject = stringField(body.providerSubject);
      const consumerSubject = stringField(body.consumerSubject);
      const key = providerConsumerKey(providerSubject, consumerSubject);
      const grant = await this.ctx.storage.get<ShareGrantRecord>(key);
      if (!grant || grant.status !== "active") {
        return json({ error: "Active grant not found" }, 404);
      }

      const revoked = {
        ...grant,
        revokedAt: new Date().toISOString(),
        status: "revoked" as const,
        updatedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(key, revoked);
      console.log("share_grant_revoke", auditGrant(revoked));

      return json({ grant: revoked });
    }

    if (request.method === "PATCH" && url.pathname === "/grants") {
      const body = await readJson(request);
      const providerSubject = stringField(body.providerSubject);
      const consumerSubject = stringField(body.consumerSubject);
      const status: ShareGrantRecord["status"] =
        body.status === "active" ? "active" : "disabled";
      const key = providerConsumerKey(providerSubject, consumerSubject);
      const grant = await this.ctx.storage.get<ShareGrantRecord>(key);
      if (!grant || grant.status === "revoked") {
        return json({ error: "Grant not found" }, 404);
      }

      const next = {
        ...grant,
        status,
        updatedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(key, next);
      console.log("share_grant_status", auditGrant(next));

      return json({ grant: next });
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      const providerSubject = url.searchParams.get("providerSubject") ?? "";
      const grants = await this.listGrants(
        (grant) => grant.providerSubject === providerSubject,
      );

      return json({ grants });
    }

    if (request.method === "GET" && url.pathname === "/consumers") {
      const consumerSubject = url.searchParams.get("consumerSubject") ?? "";
      const grants = await this.listGrants(
        (grant) =>
          grant.consumerSubject === consumerSubject &&
          grant.status === "active",
      );

      return json({
        providers: grants.map(renderConsumerShare),
        tokenproxy_accounts: grants.map(renderPeerAccount),
      });
    }

    if (request.method === "POST" && url.pathname === "/authorize") {
      const body = await readJson(request);
      const providerSubject = stringField(body.providerSubject);
      const consumerSubject = stringField(body.consumerSubject);
      const scope = body.scope as PeerRequestScope;
      const key = providerConsumerKey(providerSubject, consumerSubject);
      const grant = await this.ctx.storage.get<ShareGrantRecord>(key);

      const usage = await this.grantUsage(grant);
      const decision = authorizeShareGrant(grant, scope, usage);

      if (!decision.ok) {
        if (!grant || decision.error === "No active grant") {
          console.log("share_grant_deny", {
            consumerSubject,
            providerSubject,
            reason: "missing_grant",
          });
        } else if (decision.status === 403) {
          console.log("share_grant_deny", {
            ...auditGrant(grant),
            reason: decision.error,
          });
        } else {
          console.log("share_grant_cap_deny", auditGrant(grant));
        }

        return json({ error: decision.error }, decision.status);
      }

      if (!grant) return json({ error: "No active grant" }, 403);
      const requestKey = usageKey(grant.grantId);

      if (decision.lease) {
        await this.ctx.storage.put(
          inFlightKey(grant.grantId),
          decision.usage.inFlight,
        );
      }
      await this.ctx.storage.put(`${requestKey}:tokens`, decision.usage.tokens);
      await this.ctx.storage.put(requestKey, decision.usage.requests);
      console.log("share_grant_allow", auditGrant(grant));
      return json({ grantId: grant.grantId });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = await readJson(request);
      const key = inFlightKey(stringField(body.grantId));
      const used = (await this.ctx.storage.get<number>(key)) ?? 0;
      await this.ctx.storage.put(key, Math.max(0, used - 1));

      return json({ released: true });
    }

    return json({ error: "Not found" }, 404);
  }

  private async listGrants(
    predicate: (grant: ShareGrantRecord) => boolean,
  ): Promise<ShareGrantRecord[]> {
    const entries = await this.ctx.storage.list<ShareGrantRecord>({
      prefix: "grant:",
    });

    return [...entries.values()].filter(predicate);
  }

  private async grantUsage(
    grant: ShareGrantRecord | undefined,
  ): Promise<{ requests: number; tokens: number; inFlight: number }> {
    if (!grant) return { requests: 0, tokens: 0, inFlight: 0 };

    const requestKey = usageKey(grant.grantId);
    return {
      requests: (await this.ctx.storage.get<number>(requestKey)) ?? 0,
      tokens: (await this.ctx.storage.get<number>(`${requestKey}:tokens`)) ?? 0,
      inFlight:
        (await this.ctx.storage.get<number>(inFlightKey(grant.grantId))) ?? 0,
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

  async restartForShareChange(): Promise<{ restarted: boolean }> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );
    if (!record) return { restarted: false };

    // Grant changes alter consumer-visible tokenproxy config; restart is the current reload primitive.
    await this.destroy();
    await this.startMachine(record);

    return { restarted: true };
  }

  override async fetch(request: Request): Promise<Response> {
    // Every user-machine fetch is also a wake-up path for sleeping tokenproxy containers.
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );

    if (!record) return json({ error: "User machine not found" }, 404);

    await this.startMachine(record);
    const { secret } = await getApiKeySecret(
      workerAppConfig(this.env),
      record.apiKeyId,
    );

    return super.fetch(tokenproxyRequest(request, secret));
  }

  private async startMachine(record: UserMachineRecord): Promise<void> {
    // Mainroom injects only the user's private tokenproxy bearer on the private container hop.
    // Runtime object reads should move to signed HTTPS URLs, not long-lived S3 credentials.
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
          TOKENPROXY_CONFIG_UPDATE_ENDPOINT: `https://${rootHost}/v0/tokenproxy/auth-json/refresh`,
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
  // Forwarding metadata belongs to Mainroom; OpenAI-compatible request parsing stays in tokenproxy.
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

function tokenproxyRequest(
  request: Request,
  tokenproxyClientKey: string,
): Request {
  // Provider tokenproxy receives only its private bearer, never the peer caller bearer.
  const forwarded = proxiedRequest(request);
  const headers = new Headers(forwarded.headers);

  stripUntrustedPeerHeaders(headers);
  headers.set("Authorization", `Bearer ${tokenproxyClientKey}`);

  return new Request(forwarded, { headers });
}

async function userMachineV1Request(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return undefined;

  const username = usernameFromMainroomHost(url.hostname);
  if (!username) return undefined;

  // The subdomain names the provider; Clerk maps that public name back to the durable subject.
  const subject = await getCliUsernameSubject(workerAppConfig(env), username);
  if (!subject) return json({ error: "User machine not found" }, 404);

  const auth = await providerEdgeAuth(request, env, subject);
  if (auth instanceof Response) return auth;

  // Non-owner peer calls are authorized here before Mainroom injects the provider bearer.
  // Deterministic user:<subject> routing keeps one logical tokenproxy machine per user.
  const machine = getContainer(env.USER_MACHINE_CONTAINER, machineId(subject));

  // Container.fetch, not containerFetch, preserves WebSocket upgrades for /v1/responses.
  try {
    return releaseGrantWhenDone(
      env,
      auth.grantId,
      await machine.fetch(request),
    );
  } catch (error) {
    if (auth.grantId) await releaseShareGrant(env, auth.grantId);
    throw error;
  }
}

async function providerEdgeAuth(
  request: Request,
  env: Env,
  providerSubject: string,
): Promise<{ consumerSubject: string; grantId?: string } | Response> {
  const token = bearerToken(request);
  if (!token) {
    console.log("share_grant_deny", {
      providerSubject,
      reason: "missing_bearer",
    });
    return json({ error: "Unauthorized" }, 401);
  }

  let consumerSubject: string;
  try {
    const apiKey = await verifyApiKey(workerAppConfig(env), { secret: token });
    consumerSubject = apiKey.subject;
  } catch {
    console.log("share_grant_deny", {
      providerSubject,
      reason: "invalid_bearer",
    });
    return json({ error: "Unauthorized" }, 401);
  }

  if (!requiresPeerGrant(providerSubject, consumerSubject)) {
    return { consumerSubject };
  }

  const body = await readJson(request.clone());
  const scope = parsePeerRequestScope(request, body);
  const response = await shareStore(env).fetch(
    new Request("https://share-store/authorize", {
      method: "POST",
      body: JSON.stringify({ providerSubject, consumerSubject, scope }),
    }),
  );

  if (!response.ok) {
    return json(await response.json(), response.status);
  }

  const result = (await response.json()) as { grantId?: unknown };
  const grantId =
    typeof result.grantId === "string" ? result.grantId : undefined;
  return { consumerSubject, grantId };
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
      const body = await readJson(request.clone());
      const result = await createCliApiKey(config, request, body.username);
      const apiKey = apiKeySchema.parse(result.apiKey);

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
        username: result.username,
      });
    } catch (error) {
      const response = cliAuthError(error);
      return json({ error: response.error }, response.status);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}

async function shareRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/v0/shares/providers" &&
    url.pathname !== "/v0/shares/consumers/me" &&
    !url.pathname.startsWith("/v0/shares/providers/")
  ) {
    return undefined;
  }

  const config = workerAppConfig(env);
  const providerSubject = await verifiedApiKeySubject(config, request);
  if (!providerSubject) return json({ error: "Unauthorized" }, 401);

  if (request.method === "GET" && url.pathname === "/v0/shares/providers") {
    const response = await shareStore(env).fetch(
      new Request(
        `https://share-store/providers?providerSubject=${encodeURIComponent(providerSubject)}`,
      ),
    );

    return json(await response.json(), response.status);
  }

  if (request.method === "GET" && url.pathname === "/v0/shares/consumers/me") {
    const response = await shareStore(env).fetch(
      new Request(
        `https://share-store/consumers?consumerSubject=${encodeURIComponent(providerSubject)}`,
      ),
    );

    return json(await response.json(), response.status);
  }

  const match = url.pathname.match(/^\/v0\/shares\/providers\/([^/]+)$/);
  if (!match) return json({ error: "Not found" }, 404);

  const consumerUsername = decodeURIComponent(match[1] ?? "").trim();
  const consumerSubject = await getCliUsernameSubject(config, consumerUsername);
  if (!consumerSubject) return json({ error: "Consumer not found" }, 404);

  if (request.method === "PUT") {
    const providerUsername = await getCliSubjectUsername(
      config,
      providerSubject,
    );
    if (!providerUsername)
      return json({ error: "Provider username not found" }, 404);

    const input = normalizeShareGrantInput(await readJson(request));
    if ("error" in input) return json({ error: input.error }, 400);

    const response = await shareStore(env).fetch(
      new Request("https://share-store/grants", {
        method: "PUT",
        body: JSON.stringify({
          identity: {
            providerSubject,
            providerUsername,
            consumerSubject,
            consumerUsername,
          },
          input,
        }),
      }),
    );
    const result = await response.json();

    if (response.ok) {
      const reconcile = await reconcileConsumerMachine(env, consumerSubject);
      console.log("share_grant_reconcile", {
        consumerSubject,
        providerSubject,
        ...reconcile,
      });
    }

    return json(result, response.status);
  }

  if (request.method === "DELETE") {
    const response = await shareStore(env).fetch(
      new Request("https://share-store/grants", {
        method: "DELETE",
        body: JSON.stringify({ providerSubject, consumerSubject }),
      }),
    );
    const result = await response.json();

    if (response.ok) {
      const reconcile = await reconcileConsumerMachine(env, consumerSubject);
      console.log("share_grant_reconcile", {
        consumerSubject,
        providerSubject,
        ...reconcile,
      });
    }

    return json(result, response.status);
  }

  if (request.method === "PATCH") {
    const body = await readJson(request);
    if (body.status !== "active" && body.status !== "disabled") {
      return json({ error: "status must be active or disabled" }, 400);
    }

    const response = await shareStore(env).fetch(
      new Request("https://share-store/grants", {
        method: "PATCH",
        body: JSON.stringify({
          providerSubject,
          consumerSubject,
          status: body.status,
        }),
      }),
    );
    const result = await response.json();

    if (response.ok) {
      const reconcile = await reconcileConsumerMachine(env, consumerSubject);
      console.log("share_grant_reconcile", {
        consumerSubject,
        providerSubject,
        ...reconcile,
      });
    }

    return json(result, response.status);
  }

  return json({ error: "Method not allowed" }, 405);
}

async function usernameStatusRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname !== "/") return undefined;
  const username = usernameFromMainroomHost(url.hostname);
  if (!username) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  const taken = await isCliUsernameTaken(workerAppConfig(env), username);
  const status = taken ? "taken" : "available";

  if (request.headers.get("Accept")?.includes("application/json")) {
    return json({ username, status, available: !taken });
  }

  return text(usernameStatusText(username, status));
}

function usernameFromMainroomHost(hostname: string): string | undefined {
  // Only single-label user subdomains are routable; nested labels stay out of user identity.
  const suffix = `.${rootHost}`;
  if (!hostname.endsWith(suffix)) return undefined;

  const username = hostname.slice(0, -1 * suffix.length);
  if (!username || username.includes(".")) return undefined;

  return username;
}

function cliAuthError(error: unknown): {
  error: string;
  status: 400 | 401 | 409 | 502;
} {
  if (error instanceof ClerkApiError) {
    if (error.status === 401) return { error: "Login failed", status: 401 };
    if (error.status === 409) return { error: error.message, status: 409 };
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

async function verifiedApiKeySubject(
  config: ReturnType<typeof workerAppConfig>,
  request: Request,
): Promise<string | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;

  try {
    return (await verifyApiKey(config, { secret: token })).subject;
  } catch {
    return undefined;
  }
}

function shareStore(env: Env): DurableObjectStub<ShareGrantStore> {
  return env.SHARE_GRANT_STORE.get(
    env.SHARE_GRANT_STORE.idFromName("mainroom-share-grants"),
  );
}

async function reconcileConsumerMachine(
  env: Env,
  consumerSubject: string,
): Promise<{ restarted: boolean }> {
  const machine = getContainer(
    env.USER_MACHINE_CONTAINER,
    machineId(consumerSubject),
  );

  return machine.restartForShareChange();
}

async function releaseShareGrant(env: Env, grantId: string): Promise<void> {
  await shareStore(env).fetch(
    new Request("https://share-store/release", {
      method: "POST",
      body: JSON.stringify({ grantId }),
    }),
  );
}

function releaseGrantWhenDone(
  env: Env,
  grantId: string | undefined,
  response: Response,
): Response {
  if (!grantId) return response;

  if (!response.body) {
    void releaseShareGrant(env, grantId);
    return response;
  }

  const stream = new TransformStream();
  response.body.pipeTo(stream.writable).finally(() => {
    void releaseShareGrant(env, grantId);
  });

  return new Response(stream.readable, response);
}

function shareIdentityFrom(value: unknown): {
  consumerSubject: string;
  consumerUsername: string;
  providerSubject: string;
  providerUsername: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("identity is required");
  }

  const identity = value as Record<string, unknown>;
  return {
    consumerSubject: stringField(identity.consumerSubject),
    consumerUsername: stringField(identity.consumerUsername),
    providerSubject: stringField(identity.providerSubject),
    providerUsername: stringField(identity.providerUsername),
  };
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected a non-empty string");
  }

  return value.trim();
}

function auditGrant(grant: ShareGrantRecord) {
  return {
    consumerSubject: grant.consumerSubject,
    grantId: grant.grantId,
    providerSubject: grant.providerSubject,
    status: grant.status,
  };
}

function machineId(subject: string): string {
  // User machines are keyed by subject plus runtime generation, not username.
  return `user:${subject}:${tokenproxyRuntimeVersion}`;
}

function workerAppConfig(env: Env) {
  return readConfig({
    AUTH_MODE: env.AUTH_MODE,
    CLERK_API_URL: env.CLERK_API_URL,
    CLERK_API_VERSION: env.CLERK_API_VERSION,
    CLERK_OAUTH_AUTHORIZE_URL: env.CLERK_OAUTH_AUTHORIZE_URL,
    CLERK_OAUTH_CLIENT_ID: env.CLERK_OAUTH_CLIENT_ID,
    CLERK_OAUTH_TOKEN_URL: env.CLERK_OAUTH_TOKEN_URL,
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
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

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function usernameStatusText(username: string, status: "available" | "taken") {
  const detail =
    status === "available"
      ? "This Mainroom username is available."
      : "This Mainroom username is already taken.";

  return `${username}.mainroom.sh is ${status}\n${detail}\n`;
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

    const shareResponse = await shareRequest(request, env);
    if (shareResponse) return shareResponse;

    // User subdomain inference traffic stays on the Worker edge instead of the app container.
    const userMachineResponse = await userMachineV1Request(request, env);
    if (userMachineResponse) return userMachineResponse;

    const usernameStatusResponse = await usernameStatusRequest(request, env);
    if (usernameStatusResponse) return usernameStatusResponse;

    const machineResponse = await machineRequest(request, env);
    if (machineResponse) return machineResponse;

    const container = await getRandom(env.MAINROOM_CONTAINER, instanceCount);
    return container.fetch(proxiedRequest(request));
  },
} satisfies ExportedHandler<Env>;
