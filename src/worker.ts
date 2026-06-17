import { Container, getContainer, getRandom } from "@cloudflare/containers";

const instanceCount = 3;
const machinePath = "/v0/machines";

type Env = {
  CLERK_SECRET_KEY: string;
  CORS_ORIGIN?: string;
  MACHINE_CONTROL_TOKEN: string;
  MAINROOM_CONTAINER: DurableObjectNamespace<MainroomContainer>;
  USER_MACHINE_CONTAINER: DurableObjectNamespace<UserMachineContainer>;
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

    if (!subject) {
      return json({ error: "subject is required" }, 400);
    }

    const id = machineId(subject);
    const machine = getContainer(env.USER_MACHINE_CONTAINER, id);

    await machine.startAndWaitForPorts();

    return json({
      id,
      subject,
      state: await machine.getState(),
    });
  }

  const match = url.pathname.match(/^\/v0\/machines\/([^/]+)$/);
  if (!match) return json({ error: "Not found" }, 404);

  const id = decodeURIComponent(match[1] ?? "");
  if (!id) return json({ error: "machine id is required" }, 400);

  const machine = getContainer(env.USER_MACHINE_CONTAINER, id);

  if (request.method === "GET") {
    return json({ id, state: await machine.getState() });
  }

  if (request.method === "DELETE") {
    await machine.destroy();
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
