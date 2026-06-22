import { z } from "zod";
import { errorMessage } from "./errors";
import type { CliExchangeParams, CliOAuthConfig } from "./types";

type RequestOptions = {
  body?: BodyInit;
  contentType?: string;
  method?: "GET" | "POST";
  token?: string;
  uploadName?: string;
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
  username: z.string().optional(),
});

const jsonUploadResponseSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  size: z.number(),
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
  params: CliExchangeParams = {},
): Promise<z.infer<typeof cliExchangeResponseSchema>> {
  const body = JSON.stringify(params);
  const result = await requestJson(
    apiUrl,
    "/v0/auth/cli/exchange",
    cliExchangeResponseSchema,
    {
      body,
      contentType: "application/json; charset=utf-8",
      method: "POST",
      token: oauthToken,
    },
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

export async function uploadJson(
  apiUrl: string,
  token: string,
  text: string,
  uploadName?: string,
): Promise<RequestResult<z.infer<typeof jsonUploadResponseSchema>>> {
  return requestJson(apiUrl, "/v0/uploads/json", jsonUploadResponseSchema, {
    body: text,
    contentType: "application/json; charset=utf-8",
    method: "POST",
    token,
    uploadName,
  });
}

export async function reloadTokenproxyConfig(
  apiUrl: string,
  token: string,
): Promise<RequestResult<{ created: boolean; restarted: boolean }>> {
  return requestJson(
    apiUrl,
    "/v0/tokenproxy/config/reload",
    z.object({ created: z.boolean(), restarted: z.boolean() }),
    {
      method: "POST",
      token,
    },
  );
}

async function requestJson<T>(
  apiUrl: string,
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<RequestResult<T>> {
  try {
    const headers = new Headers();
    if (options.contentType) headers.set("Content-Type", options.contentType);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (options.uploadName)
      headers.set("X-Mainroom-Upload-Name", options.uploadName);

    const response = await fetch(new URL(path, `${apiUrl}/`), {
      body: options.body,
      method: options.method ?? "GET",
      headers,
    });
    const body = await response.json().catch(() => undefined);

    if (!response.ok) {
      return {
        ok: false,
        error:
          errorFromBody(body) ??
          `Mainroom request failed with status ${response.status}`,
      };
    }

    return { ok: true, data: schema.parse(body) };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach Mainroom: ${errorMessage(error)}`,
    };
  }
}

function errorFromBody(body: unknown): string | undefined {
  return errorResponseSchema.safeParse(body).data?.error;
}
