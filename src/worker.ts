import { Container, getContainer, getRandom } from "@cloudflare/containers";

const instanceCount = 3;
const machinePath = "/v0/machines";

type Env = {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  CLERK_SECRET_KEY: string;
  CORS_ORIGIN?: string;
  MACHINE_CONTROL_TOKEN: string;
  MAINROOM_CONTAINER: DurableObjectNamespace<MainroomContainer>;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  USER_MACHINE_CONTAINER: DurableObjectNamespace<UserMachineContainer>;
};

type UserMachineRecord = {
  bucketPrefix: string;
  id: string;
  subject: string;
};

export class MainroomContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CORS_ORIGIN: env.CORS_ORIGIN ?? "https://mainroom.sh",
      NODE_ENV: "production",
      PORT: "3000",
    };
  }
}

export class UserMachineContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";
  storageKey = "user-machine";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CORS_ORIGIN: env.CORS_ORIGIN ?? "https://mainroom.sh",
      MACHINE_KIND: "user",
      NODE_ENV: "production",
      PORT: "3000",
    };
  }

  async create(record: UserMachineRecord): Promise<{
    bucketPrefix: string;
    id: string;
    state: Awaited<ReturnType<UserMachineContainer["getState"]>>;
    subject: string;
  }> {
    await this.ctx.storage.put(this.storageKey, record);
    await this.startMachine(record);

    return {
      bucketPrefix: record.bucketPrefix,
      id: record.id,
      state: await this.getState(),
      subject: record.subject,
    };
  }

  async info(): Promise<{
    bucketPrefix?: string;
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
    const r2 = r2Config(this.env);

    if (r2 instanceof Response) {
      throw new Error("User machine R2 configuration is incomplete");
    }

    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          ...this.envVars,
          AWS_ACCESS_KEY_ID: r2.awsAccessKeyId,
          AWS_SECRET_ACCESS_KEY: r2.awsSecretAccessKey,
          R2_ACCOUNT_ID: r2.accountId,
          R2_BUCKET_NAME: r2.bucketName,
          R2_BUCKET_PREFIX: record.bucketPrefix,
          USER_MACHINE_ID: record.id,
          USER_SUBJECT: record.subject,
        },
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
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const r2 = r2Config(env);

    if (r2 instanceof Response) {
      return r2;
    }

    if (!subject) {
      return json({ error: "subject is required" }, 400);
    }

    const id = machineId(subject);
    const machine = getContainer(env.USER_MACHINE_CONTAINER, id);
    const bucketPrefix = bucketPrefixForSubject(subject);

    return json(
      await machine.create({
        bucketPrefix,
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

function bucketPrefixForSubject(subject: string): string {
  return `users/${encodeURIComponent(subject)}`;
}

function r2Config(env: Env):
  | {
      accountId: string;
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      bucketName: string;
    }
  | Response {
  const missing = [
    ["AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID],
    ["AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY],
    ["R2_ACCOUNT_ID", env.R2_ACCOUNT_ID],
    ["R2_BUCKET_NAME", env.R2_BUCKET_NAME],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    return json(
      { error: `Missing user machine bucket config: ${missing.join(", ")}` },
      500,
    );
  }

  return {
    accountId: env.R2_ACCOUNT_ID!,
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID!,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    bucketName: env.R2_BUCKET_NAME!,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(request, env) {
    const machineResponse = await machineRequest(request, env);
    if (machineResponse) return machineResponse;

    const container = await getRandom(env.MAINROOM_CONTAINER, instanceCount);
    return container.fetch(proxiedRequest(request));
  },
} satisfies ExportedHandler<Env>;
