import { Hono } from "hono";

import { ClerkApiError, createCliApiKey, type AppConfig } from "../helpers";
import { apiKeySchema } from "../schemas/api-keys";

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
      const body = await readOptionalJson(c.req.raw.clone());
      const result = await createCliApiKey(config, c.req.raw, body.username);
      const apiKey = apiKeySchema.parse(result.apiKey);

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
        username: result.username,
      });
    } catch (error) {
      const response = authError(error);
      return c.json({ error: response.error }, response.status);
    }
  });

  return cliAuth;
}

async function readOptionalJson(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
  status: 400 | 401 | 409 | 502;
} {
  if (error instanceof ClerkApiError) {
    if (error.status === 401) return { error: "Login failed", status: 401 };
    if (error.status === 409) return { error: error.message, status: 409 };
    if (error.status >= 400 && error.status < 500) {
      return { error: error.message, status: 400 };
    }
  }

  return { error: "Mainroom could not complete login", status: 502 };
}
