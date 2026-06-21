import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createOpenApiDocument, openApi } from "hono-zod-openapi";
import { z } from "zod";

import { readConfig } from "./helpers";
import { createV0Route } from "./routes/v0";
import { mainroomVersion } from "./version";

const config = readConfig(Bun.env);

const app = new Hono();

app.use(logger());
app.use(secureHeaders());
app.use(
  "*",
  cors({
    origin:
      config.corsOrigins.length === 1
        ? config.corsOrigins[0]
        : config.corsOrigins,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["DELETE", "GET", "PATCH", "POST", "OPTIONS"],
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

app.route("/v0", createV0Route(config));

const openApiDocument = createOpenApiDocument(
  app,
  {
    info: {
      title: "Mainroom API",
      version: mainroomVersion,
    },
    components: {
      securitySchemes: {
        clerkApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Mainroom API key secret",
        },
      },
    },
  },
  { addRoute: false },
);

app.get("/openapi.json", (c) => c.json(openApiDocument));
app.get("/docs", Scalar({ url: "/openapi.json" }));

export default {
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
