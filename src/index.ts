import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createOpenApiDocument, openApi } from "hono-zod-openapi";
import { z } from "zod";

const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);
const authMode =
  Bun.env.AUTH_MODE ?? (Bun.env.NODE_ENV === "production" ? "clerk" : "mock");
const clerkSecretKey = Bun.env.CLERK_SECRET_KEY;
const clerkApiUrl = Bun.env.CLERK_API_URL ?? "https://api.clerk.com";
const corsOrigins = (Bun.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (authMode !== "clerk" && authMode !== "mock") {
  throw new Error("AUTH_MODE must be either clerk or mock");
}

if (authMode === "mock" && Bun.env.NODE_ENV === "production") {
  throw new Error("AUTH_MODE=mock is not allowed when NODE_ENV=production");
}

if (authMode === "clerk" && !clerkSecretKey) {
  throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token ? token : undefined;
}

async function verifyClerkApiKey(secret: string): Promise<boolean> {
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required when AUTH_MODE=clerk");
  }

  const response = await fetch(new URL("/api_keys/verify", clerkApiUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clerkSecretKey}`,
      "Clerk-API-Version": "2026-05-12",
      "Content-Type": "application/json",
      "User-Agent": "mainroom/0.1.0",
    },
    body: JSON.stringify({ secret }),
  });

  return response.ok;
}

const app = new Hono();

app.use(logger());
app.use(secureHeaders());
app.use(
  "*",
  cors({
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/", (c) => c.redirect("/docs"));

app.get(
  "/health",
  openApi({
    tags: ["System"],
    summary: "Health check",
    responses: {
      200: z.object({
        ok: z.boolean(),
        service: z.string(),
      }),
    },
  }),
  (c) => c.var.res(200, { ok: true, service: "mainroom" }),
);

const v0 = new Hono();

v0.use("*", async (c, next) => {
  const token = bearerToken(c.req.raw);

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (authMode === "mock") {
    await next();
    return;
  }

  try {
    if (!(await verifyClerkApiKey(token))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

v0.get(
  "/ping",
  openApi({
    tags: ["V0"],
    summary: "API key authenticated ping",
    security: [{ clerkApiKey: [] }],
    responses: {
      200: z.object({
        ok: z.boolean(),
        version: z.string(),
      }),
    },
  }),
  (c) => c.var.res(200, { ok: true, version: "v0" }),
);

app.route("/v0", v0);

const openApiDocument = createOpenApiDocument(
  app,
  {
    info: {
      title: "Mainroom API",
      version: "0.1.0",
    },
    components: {
      securitySchemes: {
        clerkApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Clerk API key secret",
        },
      },
    },
  },
  { addRoute: false },
);

app.get("/openapi.json", (c) => c.json(openApiDocument));
app.get("/docs", Scalar({ url: "/openapi.json" }));

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
