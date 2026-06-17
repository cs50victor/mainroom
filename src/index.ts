import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createOpenApiDocument, openApi } from "hono-zod-openapi";
import { z } from "zod";

import {
  ClerkApiError,
  bearerToken,
  createApiKey,
  deleteApiKey,
  getApiKey,
  getApiKeySecret,
  isApiKeyValid,
  listApiKeys,
  readConfig,
  revokeApiKey,
  updateApiKey,
  verifyApiKey,
} from "./helpers";

const config = readConfig(Bun.env);

const errorSchema = z.object({
  error: z.string(),
});

const apiKeySchema = z.object({
  object: z.literal("api_key"),
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  claims: z.unknown().nullable(),
  scopes: z.array(z.string()),
  secret: z.string().optional(),
  revoked: z.boolean(),
  revocation_reason: z.string().nullable(),
  expired: z.boolean(),
  expiration: z.number().nullable(),
  created_by: z.string().nullable(),
  last_used_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const apiKeyListSchema = z.object({
  data: z.array(apiKeySchema),
  total_count: z.number(),
});

const createApiKeySchema = z.object({
  type: z.string().min(3).max(25).optional(),
  name: z.string().min(3),
  description: z.string().max(255).nullable().optional(),
  subject: z.string().min(1),
  claims: z.unknown().nullable().optional(),
  scopes: z.array(z.string()).optional(),
  created_by: z.string().nullable().optional(),
  seconds_until_expiration: z.number().positive().nullable().optional(),
});

const updateApiKeySchema = z.object({
  claims: z.unknown().nullable().optional(),
  scopes: z.array(z.string()).optional(),
  description: z.string().max(255).nullable().optional(),
  subject: z.string().min(1).optional(),
  seconds_until_expiration: z.number().positive().nullable().optional(),
});

const listApiKeysQuerySchema = z.object({
  type: z.string().min(3).optional(),
  subject: z.string().min(1),
  include_invalid: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  query: z.string().optional(),
});

const apiKeyIdParamSchema = z.object({
  id: z.string().min(1),
});

const revokeApiKeySchema = z.object({
  revocation_reason: z.string().nullable().optional(),
});

const verifyApiKeySchema = z.object({
  secret: z.string().min(1),
});

const apiKeySecretSchema = z.object({
  secret: z.string(),
});

const deletedApiKeySchema = z.object({
  id: z.string(),
  object: z.literal("api_key"),
  deleted: z.literal(true),
});

function clerkError(error: unknown): {
  error: string;
  status: 400 | 404 | 409 | 502;
} {
  if (error instanceof ClerkApiError) {
    if (error.status === 404) return { error: error.message, status: 404 };
    if (error.status === 409) return { error: error.message, status: 409 };
    if (error.status >= 400 && error.status < 500) {
      return { error: error.message, status: 400 };
    }
  }

  return { error: "Clerk request failed", status: 502 };
}

const keyRouteResponses = {
  400: errorSchema,
  404: errorSchema,
  409: errorSchema,
  502: errorSchema,
};

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

const v0 = new Hono();

v0.use("*", async (c, next) => {
  const token = bearerToken(c.req.raw);

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (config.authMode === "mock") {
    await next();
    return;
  }

  try {
    if (!(await isApiKeyValid(config, token))) {
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

v0.post(
  "/api-keys",
  openApi({
    tags: ["API Keys"],
    summary: "Create API key",
    security: [{ clerkApiKey: [] }],
    request: {
      json: createApiKeySchema,
    },
    responses: {
      200: apiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const apiKey = apiKeySchema.parse(
        await createApiKey(config, c.req.valid("json")),
      );
      return c.var.res(200, apiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.get(
  "/api-keys",
  openApi({
    tags: ["API Keys"],
    summary: "List API keys",
    security: [{ clerkApiKey: [] }],
    request: {
      query: listApiKeysQuerySchema,
    },
    responses: {
      200: apiKeyListSchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const apiKeys = apiKeyListSchema.parse(
        await listApiKeys(config, c.req.valid("query")),
      );
      return c.var.res(200, apiKeys);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.post(
  "/api-keys/verify",
  openApi({
    tags: ["API Keys"],
    summary: "Verify API key",
    security: [{ clerkApiKey: [] }],
    request: {
      json: verifyApiKeySchema,
    },
    responses: {
      200: apiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const apiKey = apiKeySchema.parse(
        await verifyApiKey(config, c.req.valid("json")),
      );
      return c.var.res(200, apiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.get(
  "/api-keys/:id",
  openApi({
    tags: ["API Keys"],
    summary: "Get API key",
    security: [{ clerkApiKey: [] }],
    request: {
      param: apiKeyIdParamSchema,
    },
    responses: {
      200: apiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const apiKey = apiKeySchema.parse(await getApiKey(config, id));
      return c.var.res(200, apiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.patch(
  "/api-keys/:id",
  openApi({
    tags: ["API Keys"],
    summary: "Update API key",
    security: [{ clerkApiKey: [] }],
    request: {
      param: apiKeyIdParamSchema,
      json: updateApiKeySchema,
    },
    responses: {
      200: apiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const apiKey = apiKeySchema.parse(
        await updateApiKey(config, id, c.req.valid("json")),
      );
      return c.var.res(200, apiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.delete(
  "/api-keys/:id",
  openApi({
    tags: ["API Keys"],
    summary: "Delete API key",
    security: [{ clerkApiKey: [] }],
    request: {
      param: apiKeyIdParamSchema,
    },
    responses: {
      200: deletedApiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const deletedApiKey = deletedApiKeySchema.parse(
        await deleteApiKey(config, id),
      );
      return c.var.res(200, deletedApiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.get(
  "/api-keys/:id/secret",
  openApi({
    tags: ["API Keys"],
    summary: "Get API key secret",
    security: [{ clerkApiKey: [] }],
    request: {
      param: apiKeyIdParamSchema,
    },
    responses: {
      200: apiKeySecretSchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const secret = apiKeySecretSchema.parse(
        await getApiKeySecret(config, id),
      );
      return c.var.res(200, secret);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
);

v0.post(
  "/api-keys/:id/revoke",
  openApi({
    tags: ["API Keys"],
    summary: "Revoke API key",
    security: [{ clerkApiKey: [] }],
    request: {
      param: apiKeyIdParamSchema,
      json: revokeApiKeySchema,
    },
    responses: {
      200: apiKeySchema,
      ...keyRouteResponses,
    },
  }),
  async (c) => {
    try {
      const { id } = c.req.valid("param");
      const apiKey = apiKeySchema.parse(
        await revokeApiKey(config, id, c.req.valid("json")),
      );
      return c.var.res(200, apiKey);
    } catch (error) {
      const response = clerkError(error);
      return c.var.res(response.status, { error: response.error });
    }
  },
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
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
