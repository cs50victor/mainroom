import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createOpenApiDocument, openApi } from "hono-zod-openapi";
import { z } from "zod";

const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);
const apiToken =
  Bun.env.API_TOKEN ??
  (Bun.env.NODE_ENV === "production" ? undefined : "dev-token");
const corsOrigins = (Bun.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!apiToken) {
  throw new Error("API_TOKEN is required when NODE_ENV=production");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
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

app.use("/api/*", bearerAuth({ token: apiToken }));

app.get(
  "/api/hello",
  openApi({
    tags: ["API"],
    summary: "Authenticated greeting",
    security: [{ bearerAuth: [] }],
    responses: {
      200: z.object({
        message: z.string(),
      }),
    },
  }),
  (c) => c.var.res(200, { message: "Hello from Hono on Bun" }),
);

const openApiDocument = createOpenApiDocument(
  app,
  {
    info: {
      title: "Mainroom API",
      version: "0.1.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
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
