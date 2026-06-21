import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";

import {
  ClerkApiError,
  createApiKey,
  deleteApiKey,
  getApiKey,
  getApiKeySecret,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
  verifyApiKey,
  type AppConfig,
} from "../helpers";
import {
  apiKeyIdParamSchema,
  apiKeyListSchema,
  apiKeySchema,
  apiKeySecretSchema,
  createApiKeySchema,
  deletedApiKeySchema,
  errorSchema,
  listApiKeysQuerySchema,
  revokeApiKeySchema,
  updateApiKeySchema,
  verifyApiKeySchema,
} from "../schemas/api-keys";

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

  return { error: "API key service request failed", status: 502 };
}

const keyRouteResponses = {
  400: errorSchema,
  404: errorSchema,
  409: errorSchema,
  502: errorSchema,
};

export function createApiKeysRoute(config: AppConfig): Hono {
  const apiKeys = new Hono();

  apiKeys.post(
    "/",
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

  apiKeys.get(
    "/",
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
        const apiKeysList = apiKeyListSchema.parse(
          await listApiKeys(config, c.req.valid("query")),
        );
        return c.var.res(200, apiKeysList);
      } catch (error) {
        const response = clerkError(error);
        return c.var.res(response.status, { error: response.error });
      }
    },
  );

  apiKeys.post(
    "/verify",
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

  apiKeys.get(
    "/:id",
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

  apiKeys.patch(
    "/:id",
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

  apiKeys.delete(
    "/:id",
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

  apiKeys.get(
    "/:id/secret",
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

  apiKeys.post(
    "/:id/revoke",
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

  return apiKeys;
}
