import { z } from "zod";
import { errorMessage } from "./errors";
import type { CliOAuthConfig } from "./types";

type RequestOptions = {
  method?: "GET" | "POST";
  token?: string;
};

const errorResponseSchema = z.object({
  error: z.string(),
});

const pingResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
});

const cliOAuthConfigSchema = z.object({
  authorizeUrl: z.string(),
  clientId: z.string(),
  tokenUrl: z.string(),
});

const cliExchangeResponseSchema = z.object({
  apiKey: z.object({
    id: z.string(),
    subject: z.string(),
    secret: z.string(),
  }),
});

type RequestResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function normalizeApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function verifyApiKey(
  apiUrl: string,
  token: string,
): Promise<RequestResult<z.infer<typeof pingResponseSchema>>> {
  return requestJson(apiUrl, "/v0/ping", pingResponseSchema, { token });
}

export async function fetchCliOAuthConfig(
  apiUrl: string,
): Promise<RequestResult<CliOAuthConfig>> {
  return requestJson(apiUrl, "/v0/auth/cli/config", cliOAuthConfigSchema);
}

export async function mintCliApiKey(
  apiUrl: string,
  oauthToken: string,
): Promise<z.infer<typeof cliExchangeResponseSchema>["apiKey"]> {
  const result = await requestJson(
    apiUrl,
    "/v0/auth/cli/exchange",
    cliExchangeResponseSchema,
    { method: "POST", token: oauthToken },
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data.apiKey;
}

async function requestJson<T>(
  apiUrl: string,
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<RequestResult<T>> {
  try {
    const response = await fetch(new URL(path, `${apiUrl}/`), {
      method: options.method ?? "GET",
      headers: options.token
        ? { Authorization: `Bearer ${options.token}` }
        : undefined,
    });
    const body = await response.json().catch(() => undefined);

    if (!response.ok) {
      return {
        ok: false,
        error:
          errorFromBody(body) ??
          `Mainroom request failed with HTTP ${response.status}`,
      };
    }

    return { ok: true, data: schema.parse(body) };
  } catch (error) {
    return {
      ok: false,
      error: `Mainroom request failed: ${errorMessage(error)}`,
    };
  }
}

function errorFromBody(body: unknown): string | undefined {
  return errorResponseSchema.safeParse(body).data?.error;
}
