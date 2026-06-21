import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";

import { bearerToken, isApiKeyValid, type AppConfig } from "../helpers";
import { createApiKeysRoute } from "./api-keys";
import { createCliAuthRoute } from "./cli-auth";
import { createUploadsRoute } from "./uploads";

export function createV0Route(config: AppConfig): Hono {
  const v0 = new Hono();

  v0.route("/auth/cli", createCliAuthRoute(config));

  v0.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname.startsWith("/v0/auth/cli/")) {
      await next();
      return;
    }

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
      summary: "Check API key access",
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

  v0.route("/api-keys", createApiKeysRoute(config));
  v0.route("/uploads", createUploadsRoute());

  return v0;
}
