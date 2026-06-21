import { Hono } from "hono";

import {
  authenticateOAuthToken,
  ClerkApiError,
  createApiKey,
  type AppConfig,
} from "../helpers";
import { apiKeySchema } from "../schemas/api-keys";

const cliApiKeyName = "Mainroom CLI";

export function createCliAuthRoute(config: AppConfig): Hono {
  const cliAuth = new Hono();

  cliAuth.get("/config", (c) => {
    const oauthConfig = cliOAuthConfig(config);
    if (!oauthConfig) {
      return c.json(
        { error: "Browser login is not configured for this Mainroom instance" },
        501,
      );
    }

    return c.json(oauthConfig);
  });

  cliAuth.post("/exchange", async (c) => {
    try {
      const { userId } = await authenticateOAuthToken(config, c.req.raw);
      const apiKey = apiKeySchema.parse(
        await createApiKey(config, {
          name: cliApiKeyName,
          subject: userId,
          description: "Created by Mainroom CLI",
          createdBy: userId,
        }),
      );

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
      });
    } catch (error) {
      const response = authError(error);
      return c.json({ error: response.error }, response.status);
    }
  });

  return cliAuth;
}

function cliOAuthConfig(config: AppConfig):
  | {
      authorizeUrl: string;
      clientId: string;
      tokenUrl: string;
    }
  | undefined {
  if (
    !config.clerkOAuthAuthorizeUrl ||
    !config.clerkOAuthClientId ||
    !config.clerkOAuthTokenUrl
  ) {
    return undefined;
  }

  return {
    authorizeUrl: config.clerkOAuthAuthorizeUrl,
    clientId: config.clerkOAuthClientId,
    tokenUrl: config.clerkOAuthTokenUrl,
  };
}

function authError(error: unknown): {
  error: string;
  status: 400 | 401 | 502;
} {
  if (error instanceof ClerkApiError) {
    if (error.status === 401) return { error: "Login failed", status: 401 };
    if (error.status >= 400 && error.status < 500) {
      return { error: error.message, status: 400 };
    }
  }

  return { error: "Mainroom could not complete login", status: 502 };
}
