import { Container, getRandom } from "@cloudflare/containers";
import { AwsClient } from "aws4fetch";
import { DurableObject } from "cloudflare:workers";
import { XMLParser } from "fast-xml-parser";
import { Hono, type Context } from "hono";
import { stringify as stringifyToml } from "smol-toml";

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
import {
  flyMachineApi,
  flyMachineConfig,
  flyMachineFetch,
  flyMachineName,
  type FlyMachine,
} from "./fly-machines";
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
const signedConfigTtlSeconds = 10 * 60;
const signedAuthJsonTtlSeconds = 30 * 24 * 60 * 60;
const jsonUploadNamePattern = /^[A-Za-z0-9._@+-]{1,160}\.json$/;
const s3ListParser = new XMLParser();

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
 * Keep the runtime version in the explicit Durable Object id so new requests
 * create/route to a new Fly Machine generation. Old generations are left for
 * their active streams/WebSockets to drain before Fly autostop suspends them.
 * If we add load-balanced slots, keep the generation boundary and append the
 * slot after the version: user:<subject>:<version>:<slot>. Select only
 * active-generation slots for new requests; let older generations drain.
 *
 * References:
 * - Fly Machines API creates, starts, stops, and deletes tokenproxy Machines:
 *   https://fly.io/docs/machines/api/machines-resource/
 * - Fly Proxy can autostart/autostop existing Machines and supports suspend:
 *   https://fly.io/docs/reference/fly-proxy-autostop-autostart/
 *   https://fly.io/docs/reference/suspend-resume/
 * - Fly force-instance routing pins /v1 traffic to the user's Machine. A
 *   2026-06-23 smoke test created two Machines and verified pinned requests.
 *   https://fly.io/docs/networking/dynamic-request-routing/
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
const tokenproxyRuntimeVersion = "v0.1.16";
const tokenproxyEntrypoint = [
  "tokenproxy",
  "--config",
  "__MAINROOM_SIGNED_CONFIG_URL__",
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
  FLY_API_TOKEN?: string;
  FLY_APP_HOSTNAME?: string;
  FLY_APP_NAME?: string;
  FLY_MACHINE_CPUS?: string;
  FLY_MACHINE_MEMORY_MB?: string;
  FLY_MACHINE_REGION?: string;
  FLY_TOKENPROXY_IMAGE?: string;
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
  flyMachineId?: string;
  id: string;
  subject: string;
};

type WorkerHonoEnv = {
  Bindings: Env;
  Variables: {
    providerSubject: string;
  };
};

type WorkerContext = Context<WorkerHonoEnv>;

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

export class UserMachineContainer extends DurableObject<Env> {
  storageKey = "user-machine";

  async create(record: UserMachineRecord): Promise<{
    apiKeyId: string;
    id: string;
    state: string;
    subject: string;
  }> {
    await this.ctx.storage.put(this.storageKey, record);
    const machine = await this.ensureFlyMachine(record);

    return {
      apiKeyId: record.apiKeyId,
      id: record.id,
      state: machine.state,
      subject: record.subject,
    };
  }

  async info(): Promise<{
    apiKeyId?: string;
    id?: string;
    state: string;
    subject?: string;
  }> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );
    const state = record?.flyMachineId
      ? await this.flyMachineState(record.flyMachineId)
      : "missing";

    return {
      ...record,
      state,
    };
  }

  async delete(): Promise<void> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );
    if (record?.flyMachineId) {
      const fly = requiredFlyMachineConfig(this.env);
      await flyMachineApi(fly, `/machines/${record.flyMachineId}?force=true`, {
        method: "DELETE",
      });
    }
    await this.ctx.storage.delete(this.storageKey);
  }

  async restartForShareChange(): Promise<{ restarted: boolean }> {
    const record = await this.ctx.storage.get<UserMachineRecord>(
      this.storageKey,
    );
    if (!record) return { restarted: false };

    const reload = await this.reloadConfig(record);
    if (reload.reloaded) {
      return { restarted: false };
    }

    const fly = requiredFlyMachineConfig(this.env);
    const machine = await this.ensureFlyMachine(record);
    await flyMachineApi(fly, `/machines/${machine.flyMachineId}/stop`, {
      method: "POST",
      body: JSON.stringify({ signal: "SIGKILL", timeout: "0s" }),
    }).catch((error) => {
      const message = workerErrorMessage(error);
      if (!message.includes("not found")) throw error;
    });
    await flyMachineApi(fly, `/machines/${machine.flyMachineId}/start`, {
      method: "POST",
    });

    return { restarted: true };
  }

  async fetch(request: Request): Promise<Response> {
    // Every user-machine fetch is also a wake-up path for sleeping tokenproxy containers.
    let record = await this.ctx.storage.get<UserMachineRecord>(this.storageKey);

    if (!record) return json({ error: "User machine not found" }, 404);

    const { secret } = await getApiKeySecret(
      workerAppConfig(this.env),
      record.apiKeyId,
    );
    const fly = requiredFlyMachineConfig(this.env);
    record = await this.ensureFlyMachine(record);
    return flyMachineFetch(fly, record, tokenproxyRequest(request, secret));
  }

  private async reloadConfig(
    record: UserMachineRecord,
  ): Promise<{ reloaded: boolean }> {
    const { secret } = await getApiKeySecret(
      workerAppConfig(this.env),
      record.apiKeyId,
    );
    const configUrl = await signedMainroomUrl(
      this.env,
      `/v0/tokenproxy/config/${encodeURIComponent(record.subject)}.toml`,
      signedConfigTtlSeconds,
    );
    const body = JSON.stringify({
      revision: Date.now(),
      config_url: configUrl,
    });
    const request = new Request("https://tokenproxy/admin/config/reload", {
      body,
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    });

    try {
      const fly = requiredFlyMachineConfig(this.env);
      const flyRecord = await this.ensureFlyMachine(record);
      const response = await flyMachineFetch(
        fly,
        flyRecord,
        tokenproxyRequest(request, secret),
      );
      if (!response.ok) return { reloaded: false };

      const result = (await response.json()) as { reloaded?: unknown };
      return { reloaded: result.reloaded === true };
    } catch {
      return { reloaded: false };
    }
  }

  private async ensureFlyMachine(
    record: UserMachineRecord,
  ): Promise<UserMachineRecord & { flyMachineId: string; state: string }> {
    const fly = requiredFlyMachineConfig(this.env);
    if (record.flyMachineId) {
      await flyMachineApi(fly, `/machines/${record.flyMachineId}/start`, {
        method: "POST",
      }).catch((error) => {
        const message = workerErrorMessage(error);
        if (!message.includes("machine still active")) throw error;
      });
      const state = await this.flyMachineState(record.flyMachineId);
      return { ...record, flyMachineId: record.flyMachineId, state };
    }

    const { secret } = await getApiKeySecret(
      workerAppConfig(this.env),
      record.apiKeyId,
    );
    const configUrl = await signedMainroomUrl(
      this.env,
      `/v0/tokenproxy/config/${encodeURIComponent(record.subject)}.toml`,
      signedConfigTtlSeconds,
    );
    const existing = await flyMachineApi<FlyMachine[]>(
      fly,
      `/machines?metadata.mainroom_user_machine_id=${encodeURIComponent(record.id)}`,
    );
    const existingMachine = existing.find(
      (machine): machine is FlyMachine & { id: string } =>
        typeof machine.id === "string",
    );
    if (existingMachine) {
      const next = {
        ...record,
        flyMachineId: existingMachine.id,
      };
      await this.ctx.storage.put(this.storageKey, next);
      return {
        ...next,
        state: stringFromFlyMachineState(existingMachine.state),
      };
    }

    const machine = await flyMachineApi<FlyMachine>(fly, "/machines", {
      method: "POST",
      body: JSON.stringify({
        name: flyMachineName(record.subject, tokenproxyRuntimeVersion),
        region: fly.region,
        config: {
          image: fly.image,
          env: {
            ...s3EnvVars(this.env),
            MACHINE_KIND: "user",
            NODE_ENV: "production",
            TOKENPROXY_ADMIN_KEY: secret,
            TOKENPROXY_CLIENT_KEY: secret,
            TOKENPROXY_CONFIG_UPDATE_ENDPOINT: `https://${rootHost}/v0/tokenproxy/auth-json/refresh`,
            USER_MACHINE_ID: record.id,
            USER_SUBJECT: record.subject,
          },
          init: {
            exec: [
              ...tokenproxyEntrypoint.slice(0, 2),
              configUrl,
              ...tokenproxyEntrypoint.slice(3),
            ],
          },
          metadata: {
            mainroom_subject: record.subject,
            mainroom_user_machine_id: record.id,
            mainroom_tokenproxy_runtime: tokenproxyRuntimeVersion,
          },
          guest: {
            cpu_kind: "shared",
            cpus: fly.cpus,
            memory_mb: fly.memoryMb,
          },
          restart: {
            policy: "always",
          },
          services: [
            {
              protocol: "tcp",
              internal_port: 8787,
              autostart: true,
              autostop: "suspend",
              min_machines_running: 0,
              concurrency: {
                type: "connections",
                soft_limit: 20,
                hard_limit: 100,
              },
              ports: [
                { port: 80, handlers: ["http"] },
                { port: 443, handlers: ["tls", "http"] },
              ],
            },
          ],
        },
      }),
    });
    if (typeof machine.id !== "string") {
      throw new Error("Fly did not return a machine id");
    }

    const next = {
      ...record,
      flyMachineId: machine.id,
    };
    await this.ctx.storage.put(this.storageKey, next);
    return { ...next, state: stringFromFlyMachineState(machine.state) };
  }

  private async flyMachineState(machineId: string): Promise<string> {
    const fly = requiredFlyMachineConfig(this.env);
    try {
      const machine = await flyMachineApi<FlyMachine>(
        fly,
        `/machines/${machineId}`,
      );
      return stringFromFlyMachineState(machine.state);
    } catch {
      return "unknown";
    }
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
  const machine = userMachineStub(env, machineId(subject));

  // Durable Object fetch keeps Mainroom's auth gate in front of the Fly data plane.
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

async function createMachine(c: WorkerContext): Promise<Response> {
  const auth = authorizeMachineRequest(c.req.raw, c.env);
  if (auth) return auth;

  const body = await requestJson(c);
  const apiKeyId =
    typeof body.apiKeyId === "string" ? body.apiKeyId.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";

  if (!apiKeyId) {
    return c.json({ error: "apiKeyId is required" }, 400);
  }

  if (!subject) {
    return c.json({ error: "subject is required" }, 400);
  }

  const id = machineId(subject);
  const machine = userMachineStub(c.env, id);

  return c.json(
    await machine.create({
      apiKeyId,
      id,
      subject,
    }),
  );
}

async function machineInfo(c: WorkerContext): Promise<Response> {
  const auth = authorizeMachineRequest(c.req.raw, c.env);
  if (auth) return auth;

  const machine = getMachine(c);
  if (machine instanceof Response) return machine;

  return c.json(await machine.stub.info());
}

async function deleteMachine(c: WorkerContext): Promise<Response> {
  const auth = authorizeMachineRequest(c.req.raw, c.env);
  if (auth) return auth;

  const machine = getMachine(c);
  if (machine instanceof Response) return machine;

  await machine.stub.delete();
  return c.json({ id: machine.id, deleted: true });
}

function getMachine(c: WorkerContext):
  | {
      id: string;
      stub: DurableObjectStub<UserMachineContainer>;
    }
  | Response {
  const id = c.req.param("id")?.trim() ?? "";
  if (!id) return c.json({ error: "machine id is required" }, 400);

  return {
    id,
    stub: userMachineStub(c.env, id),
  };
}

function machineMethodNotAllowed(c: WorkerContext): Response {
  const auth = authorizeMachineRequest(c.req.raw, c.env);
  if (auth) return auth;

  return c.json({ error: "Method not allowed" }, 405);
}

function machineNotFound(c: WorkerContext): Response {
  const auth = authorizeMachineRequest(c.req.raw, c.env);
  if (auth) return auth;

  return c.json({ error: "Not found" }, 404);
}

function cliAuthConfig(c: WorkerContext): Response {
  if (
    !c.env.CLERK_OAUTH_AUTHORIZE_URL ||
    !c.env.CLERK_OAUTH_CLIENT_ID ||
    !c.env.CLERK_OAUTH_TOKEN_URL
  ) {
    return c.json(
      { error: "Browser login is not configured for this Mainroom instance" },
      501,
    );
  }

  return c.json({
    authorizeUrl: c.env.CLERK_OAUTH_AUTHORIZE_URL,
    clientId: c.env.CLERK_OAUTH_CLIENT_ID,
    tokenUrl: c.env.CLERK_OAUTH_TOKEN_URL,
  });
}

async function cliAuthExchange(c: WorkerContext): Promise<Response> {
  try {
    const config = workerAppConfig(c.env);
    const body = await requestJson(c);
    const result = await createCliApiKey(config, c.req.raw, body.username);
    const apiKey = apiKeySchema.parse(result.apiKey);

    if (!apiKey.secret) {
      return c.json(
        { error: "Mainroom could not create a CLI credential" },
        502,
      );
    }

    return c.json({
      apiKey: {
        id: apiKey.id,
        subject: apiKey.subject,
        secret: apiKey.secret,
      },
      username: result.username,
    });
  } catch (error) {
    const response = cliAuthError(error);
    return c.json({ error: response.error }, response.status);
  }
}

function methodNotAllowed(c: WorkerContext): Response {
  return c.json({ error: "Method not allowed" }, 405);
}

async function requireShareProvider(
  c: WorkerContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  const providerSubject = await verifiedApiKeySubject(
    workerAppConfig(c.env),
    c.req.raw,
  );
  if (!providerSubject) return json({ error: "Unauthorized" }, 401);

  c.set("providerSubject", providerSubject);
  await next();
}

async function listShareProviders(c: WorkerContext): Promise<Response> {
  const response = await shareStore(c.env).fetch(
    new Request(
      `https://share-store/providers?providerSubject=${encodeURIComponent(c.var.providerSubject)}`,
    ),
  );

  return json(await response.json(), response.status);
}

async function listConsumerShares(c: WorkerContext): Promise<Response> {
  const response = await shareStore(c.env).fetch(
    new Request(
      `https://share-store/consumers?consumerSubject=${encodeURIComponent(c.var.providerSubject)}`,
    ),
  );

  return json(await response.json(), response.status);
}

async function upsertProviderShare(c: WorkerContext): Promise<Response> {
  const context = await providerConsumerShare(c);
  if (context instanceof Response) return context;

  const providerUsername = await getCliSubjectUsername(
    context.config,
    context.providerSubject,
  );
  if (!providerUsername) {
    return c.json({ error: "Provider username not found" }, 404);
  }

  const input = normalizeShareGrantInput(await requestJson(c));
  if ("error" in input) return c.json({ error: input.error }, 400);

  const response = await shareStore(c.env).fetch(
    new Request("https://share-store/grants", {
      method: "PUT",
      body: JSON.stringify({
        identity: {
          consumerSubject: context.consumerSubject,
          consumerUsername: context.consumerUsername,
          providerSubject: context.providerSubject,
          providerUsername,
        },
        input,
      }),
    }),
  );

  return shareGrantResponse(c, response, context);
}

async function deleteProviderShare(c: WorkerContext): Promise<Response> {
  const context = await providerConsumerShare(c);
  if (context instanceof Response) return context;

  const response = await shareStore(c.env).fetch(
    new Request("https://share-store/grants", {
      method: "DELETE",
      body: JSON.stringify({
        consumerSubject: context.consumerSubject,
        providerSubject: context.providerSubject,
      }),
    }),
  );

  return shareGrantResponse(c, response, context);
}

async function updateProviderShare(c: WorkerContext): Promise<Response> {
  const context = await providerConsumerShare(c);
  if (context instanceof Response) return context;

  const body = await requestJson(c);
  if (body.status !== "active" && body.status !== "disabled") {
    return c.json({ error: "status must be active or disabled" }, 400);
  }

  const response = await shareStore(c.env).fetch(
    new Request("https://share-store/grants", {
      method: "PATCH",
      body: JSON.stringify({
        consumerSubject: context.consumerSubject,
        providerSubject: context.providerSubject,
        status: body.status,
      }),
    }),
  );

  return shareGrantResponse(c, response, context);
}

async function providerShareMethodNotAllowed(
  c: WorkerContext,
): Promise<Response> {
  const context = await providerConsumerShare(c);
  if (context instanceof Response) return context;

  return c.json({ error: "Method not allowed" }, 405);
}

type ProviderConsumerShareContext = {
  config: ReturnType<typeof workerAppConfig>;
  consumerSubject: string;
  consumerUsername: string;
  providerSubject: string;
};

async function providerConsumerShare(
  c: WorkerContext,
): Promise<ProviderConsumerShareContext | Response> {
  const config = workerAppConfig(c.env);
  const consumerUsername = c.req.param("consumerUsername")?.trim() ?? "";
  const consumerSubject = await getCliUsernameSubject(config, consumerUsername);
  if (!consumerSubject) return c.json({ error: "Consumer not found" }, 404);

  return {
    config,
    consumerSubject,
    consumerUsername,
    providerSubject: c.var.providerSubject,
  };
}

async function shareGrantResponse(
  c: WorkerContext,
  response: Response,
  context: ProviderConsumerShareContext,
): Promise<Response> {
  const result = await response.json();

  if (response.ok) {
    const reconcile = await reconcileConsumerMachine(
      c.env,
      context.consumerSubject,
    );
    console.log("share_grant_reconcile", {
      consumerSubject: context.consumerSubject,
      providerSubject: context.providerSubject,
      ...reconcile,
    });
  }

  return json(result, response.status);
}

async function reloadOwnTokenproxyConfig(c: WorkerContext): Promise<Response> {
  const apiKey = await verifiedApiKey(workerAppConfig(c.env), c.req.raw);
  if (!apiKey) return c.json({ error: "Unauthorized" }, 401);

  try {
    const reconcile = await ensureConsumerMachine(
      c.env,
      apiKey.subject,
      apiKey.id,
    );
    console.log("tokenproxy_config_reconcile", {
      subject: apiKey.subject,
      ...reconcile,
    });

    return c.json(reconcile);
  } catch (error) {
    console.error("tokenproxy_config_reconcile_failed", {
      subject: apiKey.subject,
      error: workerErrorMessage(error),
    });
    return c.json({ error: workerErrorMessage(error) }, 500);
  }
}

async function signedTokenproxyConfig(c: WorkerContext): Promise<Response> {
  const subject = decodeURIComponent(c.req.param("subject") ?? "").replace(
    /\.toml$/,
    "",
  );
  if (!subject) return c.json({ error: "subject is required" }, 400);

  if (!(await verifySignedMainroomUrl(c.env, c.req.raw))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const config = await renderTokenproxyConfig(c.env, subject);
  if ("error" in config) return c.json({ error: config.error }, config.status);

  return text(config.toml, 200, "application/toml; charset=utf-8");
}

async function signedAuthJson(c: WorkerContext): Promise<Response> {
  const subject = decodeURIComponent(c.req.param("subject") ?? "");
  const uploadName = decodeURIComponent(c.req.param("uploadName") ?? "");
  if (!subject || !isJsonUploadName(uploadName)) {
    return c.json({ error: "Auth JSON object not found" }, 404);
  }

  if (!(await verifySignedMainroomUrl(c.env, c.req.raw))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const object = await s3ReadObject(c.env, jsonUploadKey(subject, uploadName));
  if ("error" in object) return c.json({ error: object.error }, object.status);

  return text(object.text, 200, "application/json; charset=utf-8");
}

async function usernameStatus(c: WorkerContext): Promise<Response> {
  const username = usernameFromMainroomHost(new URL(c.req.url).hostname);
  if (!username) return mainroomContainerRequest(c.req.raw, c.env);

  const taken = await isCliUsernameTaken(workerAppConfig(c.env), username);
  const status = taken ? "taken" : "available";

  if (c.req.header("Accept")?.includes("application/json")) {
    return c.json({ username, status, available: !taken });
  }

  return c.text(usernameStatusText(username, status));
}

function rootMethodNotAllowed(c: WorkerContext): Response | Promise<Response> {
  const username = usernameFromMainroomHost(new URL(c.req.url).hostname);
  if (!username) return mainroomContainerRequest(c.req.raw, c.env);

  return c.json({ error: "Method not allowed" }, 405);
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

async function requestJson(c: WorkerContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>();
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
  return (await verifiedApiKey(config, request))?.subject;
}

async function verifiedApiKey(
  config: ReturnType<typeof workerAppConfig>,
  request: Request,
): Promise<Awaited<ReturnType<typeof verifyApiKey>> | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;

  try {
    return await verifyApiKey(config, { secret: token });
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
  const machine = userMachineStub(env, machineId(consumerSubject));

  return machine.restartForShareChange();
}

async function ensureConsumerMachine(
  env: Env,
  subject: string,
  apiKeyId: string,
): Promise<{ created: boolean; restarted: boolean }> {
  const id = machineId(subject);
  const machine = userMachineStub(env, id);
  const info = await machine.info();
  if (info.subject) {
    return { created: false, ...(await machine.restartForShareChange()) };
  }

  await machine.create({ apiKeyId, id, subject });
  return { created: true, restarted: false };
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

function userMachineStub(
  env: Env,
  id: string,
): DurableObjectStub<UserMachineContainer> {
  return env.USER_MACHINE_CONTAINER.get(
    env.USER_MACHINE_CONTAINER.idFromName(id),
  );
}

function requiredFlyMachineConfig(env: Env) {
  const config = flyMachineConfig(env);
  if (!config) {
    throw new Error(
      "Fly user machines are not configured; set FLY_API_TOKEN, FLY_APP_NAME, and FLY_TOKENPROXY_IMAGE",
    );
  }
  return config;
}

function stringFromFlyMachineState(state: unknown): string {
  return typeof state === "string" && state ? state : "unknown";
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

async function s3ListJsonUploads(
  env: Env,
  subject: string,
): Promise<{ names: string[] } | { error: string; status: 502 }> {
  const prefix = `uploads/json/${encodeURIComponent(subject)}/`;
  const result = await s3Fetch(env, "", {
    query: { "list-type": "2", prefix },
  });
  if ("error" in result) return result;
  if (!result.response.ok) {
    return { error: "S3 upload list failed", status: 502 };
  }

  const xml = await result.response.text();
  const parsed = s3ListParser.parse(xml) as {
    ListBucketResult?: { Contents?: unknown };
  };
  const contents = Array.isArray(parsed.ListBucketResult?.Contents)
    ? parsed.ListBucketResult.Contents
    : parsed.ListBucketResult?.Contents
      ? [parsed.ListBucketResult.Contents]
      : [];
  const names = contents
    .map((content) =>
      content && typeof content === "object"
        ? (content as Record<string, unknown>).Key
        : undefined,
    )
    .filter((key): key is string => typeof key === "string")
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter(isJsonUploadName)
    .sort();

  return { names };
}

async function s3ReadObject(
  env: Env,
  key: string,
): Promise<{ text: string } | { error: string; status: 404 | 502 }> {
  const result = await s3Fetch(env, key);
  if ("error" in result) return result;
  if (result.response.status === 404) {
    return { error: "Auth JSON object not found", status: 404 };
  }
  if (!result.response.ok) {
    return { error: "S3 object read failed", status: 502 };
  }

  return { text: await result.response.text() };
}

async function s3Fetch(
  env: Env,
  key: string,
  options: { query?: Record<string, string> } = {},
): Promise<{ response: Response } | { error: string; status: 502 }> {
  const bucket = env.S3_BUCKET ?? env.AWS_BUCKET;
  const endpoint =
    env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT;
  const region =
    env.S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "auto";
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    return { error: "S3 bucket is not configured", status: 502 };
  }

  const base = endpoint.replace(/\/+$/, "");
  const encodedBucket = encodeS3PathPart(bucket);
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map(encodeS3PathPart)
    .join("/");
  const path = encodedKey
    ? `/${encodedBucket}/${encodedKey}`
    : `/${encodedBucket}`;
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(name, value);
  }

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service: "s3",
    region,
  });

  try {
    return { response: await aws.fetch(url.toString(), { method: "GET" }) };
  } catch {
    return { error: "S3 object read failed", status: 502 };
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  return bytesToHex(await hmacBytes(utf8(secret), message));
}

async function hmacBytes(
  secret: BufferSource,
  message: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, utf8(message));
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodeS3PathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function jsonUploadKey(userId: string, uploadName: string): string {
  return `uploads/json/${encodeURIComponent(userId)}/${uploadName}`;
}

function isJsonUploadName(value: string): boolean {
  return jsonUploadNamePattern.test(value);
}

function workerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function text(
  body: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
    },
  });
}

async function renderTokenproxyConfig(
  env: Env,
  subject: string,
): Promise<{ toml: string } | { error: string; status: 502 }> {
  const uploads = await s3ListJsonUploads(env, subject);
  if ("error" in uploads) return uploads;

  const shareResponse = await shareStore(env).fetch(
    new Request(
      `https://share-store/consumers?consumerSubject=${encodeURIComponent(subject)}`,
    ),
  );
  if (!shareResponse.ok) {
    return { error: "Share grants are not available", status: 502 };
  }
  const shares = (await shareResponse.json()) as {
    tokenproxy_accounts?: unknown;
  };
  const peerAccounts = Array.isArray(shares.tokenproxy_accounts)
    ? (shares.tokenproxy_accounts as Array<Record<string, unknown>>)
    : [];

  const config = {
    server: {
      id: `tokenproxy-${subject}`,
    },
    admin_auth: {
      token_env: "TOKENPROXY_ADMIN_KEY",
    },
    downstream_auth: {
      mode: "bearer",
      token_env: "TOKENPROXY_CLIENT_KEY",
    },
    accounts: [] as Array<Record<string, unknown>>,
  };

  for (const uploadName of uploads.names) {
    const authJsonUrl = await signedMainroomUrl(
      env,
      `/v0/tokenproxy/auth-json/${encodeURIComponent(subject)}/${uploadName}`,
      signedAuthJsonTtlSeconds,
    );
    config.accounts.push({
      id: `codex:${uploadName.replace(/\.json$/, "")}`,
      kind: "chatgpt_codex_auth_json",
      auth_json_path: authJsonUrl,
      supports_responses: true,
      supports_responses_ws: true,
      supports_compact: true,
    });
  }

  for (const account of peerAccounts) {
    config.accounts.push(peerAccountConfig(account));
  }

  return { toml: stringifyToml(config) };
}

function peerAccountConfig(
  account: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: stringFromRecord(account, "id"),
    kind: stringFromRecord(account, "kind"),
    base_url: stringFromRecord(account, "base_url"),
    priority: integerFromRecord(account, "priority", 50),
    models: stringArray(account.models),
    supports_chat_completions: booleanFromRecord(
      account,
      "supports_chat_completions",
    ),
    supports_responses: booleanFromRecord(account, "supports_responses"),
    supports_responses_ws: booleanFromRecord(account, "supports_responses_ws"),
    supports_compact: booleanFromRecord(account, "supports_compact"),
    supports_anthropic_messages: booleanFromRecord(
      account,
      "supports_anthropic_messages",
    ),
    service_tiers: stringArray(account.service_tiers),
  };
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function booleanFromRecord(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === true;
}

function integerFromRecord(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

async function signedMainroomUrl(
  env: Env,
  pathname: string,
  ttlSeconds: number,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await mainroomSignature(env, "GET", pathname, expires);
  const url = new URL(`https://${rootHost}${pathname}`);
  url.searchParams.set("expires", expires.toString());
  url.searchParams.set("signature", signature);
  return url.toString();
}

async function verifySignedMainroomUrl(
  env: Env,
  request: Request,
): Promise<boolean> {
  const url = new URL(request.url);
  const expires = Number.parseInt(url.searchParams.get("expires") ?? "", 10);
  const signature = url.searchParams.get("signature") ?? "";
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await mainroomSignature(
    env,
    request.method,
    url.pathname,
    expires,
  );
  return constantTimeEqual(signature, expected);
}

async function mainroomSignature(
  env: Env,
  method: string,
  pathname: string,
  expires: number,
): Promise<string> {
  return hmacHex(
    env.MACHINE_CONTROL_TOKEN,
    `${method.toUpperCase()}\n${pathname}\n${expires}`,
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
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

const workerApp = new Hono<{ Bindings: Env }>();

/*
 * USE WORKERS FOR PUBLIC CONTROL-PLANE ROUTES, NOT CONTAINERS.
 *
 * CONTAINERS CAN STAY WARM ACROSS DEPLOYS, SO NEW ENV VARS OR ROUTES MAY
 * NOT BE AVAILABLE IMMEDIATELY. KEEP LOGIN, OAUTH, HEALTH, AND OTHER
 * DEPLOYMENT-SENSITIVE ENTRYPOINTS IN THE WORKER BEFORE THE CONTAINER FALLBACK.
 */
workerApp.get("/v0/auth/cli/config", cliAuthConfig);
workerApp.all("/v0/auth/cli/config", methodNotAllowed);

workerApp.post("/v0/auth/cli/exchange", cliAuthExchange);
workerApp.all("/v0/auth/cli/exchange", methodNotAllowed);

workerApp.use("/v0/shares/providers", requireShareProvider);
workerApp.use("/v0/shares/consumers/me", requireShareProvider);
workerApp.use("/v0/shares/providers/*", requireShareProvider);
workerApp.get("/v0/shares/providers", listShareProviders);
workerApp.all("/v0/shares/providers", methodNotAllowed);
workerApp.get("/v0/shares/consumers/me", listConsumerShares);
workerApp.all("/v0/shares/consumers/me", methodNotAllowed);
workerApp.put("/v0/shares/providers/:consumerUsername", upsertProviderShare);
workerApp.delete("/v0/shares/providers/:consumerUsername", deleteProviderShare);
workerApp.patch("/v0/shares/providers/:consumerUsername", updateProviderShare);
workerApp.all(
  "/v0/shares/providers/:consumerUsername",
  providerShareMethodNotAllowed,
);
workerApp.all("/v0/shares/providers/*", (c) =>
  c.json({ error: "Not found" }, 404),
);
workerApp.post("/v0/tokenproxy/config/reload", reloadOwnTokenproxyConfig);
workerApp.all("/v0/tokenproxy/config/reload", methodNotAllowed);
workerApp.get("/v0/tokenproxy/config/:subject", signedTokenproxyConfig);
workerApp.all("/v0/tokenproxy/config/:subject", methodNotAllowed);
workerApp.get("/v0/tokenproxy/auth-json/:subject/:uploadName", signedAuthJson);
workerApp.all(
  "/v0/tokenproxy/auth-json/:subject/:uploadName",
  methodNotAllowed,
);
workerApp.all("/v1/*", async (c) => {
  const response = await userMachineV1Request(c.req.raw, c.env);
  return response ?? mainroomContainerRequest(c.req.raw, c.env);
});
workerApp.get("/", usernameStatus);
workerApp.all("/", rootMethodNotAllowed);
workerApp.post(machinePath, createMachine);
workerApp.all(machinePath, machineMethodNotAllowed);
workerApp.get(`${machinePath}/:id`, machineInfo);
workerApp.delete(`${machinePath}/:id`, deleteMachine);
workerApp.all(`${machinePath}/:id`, machineMethodNotAllowed);
workerApp.all(`${machinePath}/*`, machineNotFound);
workerApp.notFound((c) => mainroomContainerRequest(c.req.raw, c.env));

async function mainroomContainerRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const container = await getRandom(env.MAINROOM_CONTAINER, instanceCount);
  return container.fetch(proxiedRequest(request));
}

export default {
  fetch(request, env, ctx) {
    return workerApp.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
