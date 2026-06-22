import { describe, expect, test } from "bun:test";

import {
  authenticateOAuthToken,
  ClerkApiError,
  createApiKey,
  readConfig,
  verifyApiKey,
} from "./helpers";

describe("authenticateOAuthToken", () => {
  test("returns a typed 401 when an OAuth bearer token is invalid", async () => {
    const config = readConfig({
      AUTH_MODE: "clerk",
      CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_fake",
      NODE_ENV: "test",
    });
    const request = new Request("https://mainroom.sh/v0/auth/cli/exchange", {
      headers: { Authorization: "Bearer bad" },
    });

    await expect(authenticateOAuthToken(config, request)).rejects.toMatchObject(
      {
        message: "Unauthorized",
        status: 401,
      },
    );

    await expect(
      authenticateOAuthToken(config, request),
    ).rejects.toBeInstanceOf(ClerkApiError);
  });
});

describe("verifyApiKey", () => {
  test("derives subject from a valid mock API key and rejects bad secrets", async () => {
    const config = readConfig({ AUTH_MODE: "mock", NODE_ENV: "test" });
    const apiKey = await createApiKey(config, {
      name: "Mainroom CLI",
      subject: "user_provider",
    });

    await expect(
      verifyApiKey(config, { secret: apiKey.secret ?? "" }),
    ).resolves.toMatchObject({ subject: "user_provider" });

    await expect(verifyApiKey(config, { secret: "bad" })).rejects.toMatchObject(
      { status: 401 },
    );
  });
});
