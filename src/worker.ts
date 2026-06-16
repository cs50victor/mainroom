import { Container, getRandom } from "@cloudflare/containers";

const instanceCount = 3;

type Env = {
  API_TOKEN: string;
  CORS_ORIGIN?: string;
  MAINROOM_CONTAINER: DurableObjectNamespace<MainroomContainer>;
};

export class MainroomContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      API_TOKEN: env.API_TOKEN,
      CORS_ORIGIN: env.CORS_ORIGIN ?? "https://mainroom.sh",
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

export default {
  async fetch(request, env) {
    const container = await getRandom(env.MAINROOM_CONTAINER, instanceCount);
    return container.fetch(proxiedRequest(request));
  },
} satisfies ExportedHandler<Env>;
