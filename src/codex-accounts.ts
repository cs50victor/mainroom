import { decode } from "hono/jwt";
import type { CodexAccountStatus } from "./schemas/codex-accounts";

export function codexAuthIdentity(text: string):
  | {
      accountId: string;
      accessToken: string;
      email?: string;
      expiresAt?: string;
    }
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const auth = record(value);
  if (!auth) return undefined;
  const tokens = record(auth.tokens) ?? auth;
  if (
    typeof tokens.account_id !== "string" ||
    !tokens.account_id ||
    typeof tokens.access_token !== "string" ||
    !tokens.access_token
  )
    return undefined;
  const access = jwtClaims(tokens.access_token);
  const id = jwtClaims(tokens.id_token);
  const email =
    auth.email ??
    id?.email ??
    record(access?.["https://api.openai.com/profile"])?.email;
  const expiresAt =
    typeof access?.exp === "number" &&
    Number.isFinite(access.exp) &&
    Math.abs(access.exp * 1000) <= 8640000000000000
      ? new Date(access.exp * 1000).toISOString()
      : undefined;
  return {
    accountId: tokens.account_id,
    accessToken: tokens.access_token,
    email: typeof email === "string" ? email : undefined,
    expiresAt,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  try {
    // Claims are display metadata; provider requests determine credential validity.
    return record(decode(token).payload);
  } catch {
    return undefined;
  }
}

export async function checkCodexAccount(
  uploadName: string,
  text: string,
  disabled = false,
): Promise<CodexAccountStatus> {
  const auth = codexAuthIdentity(text);
  const identity = {
    uploadName,
    accountId: auth?.accountId,
    email: auth?.email,
    expiresAt: auth?.expiresAt,
  };
  if (disabled) return { ...identity, status: "disabled" };
  if (!auth)
    return {
      ...identity,
      status: "invalid",
      detail: "Unrecognized Codex credential file",
    };
  try {
    // Match tokenproxy v0.1.16's account discovery request.
    const response = await fetch(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.141.0",
      {
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          "user-agent": "codex-cli",
          originator: "codex_cli_rs",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.status === 401) {
      await response.body?.cancel();
      return {
        ...identity,
        status: "reauth_required",
        detail: "Codex rejected this credential. Sign in again.",
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ...identity,
        status: "unavailable",
        detail: `Codex returned HTTP ${response.status}; retry later.`,
      };
    }
    const body = (await response.json()) as {
      models?: unknown[];
      data?: unknown[];
    };
    const models = [
      ...(Array.isArray(body.models) ? body.models : []),
      ...(Array.isArray(body.data) ? body.data : []),
    ];
    const modelIds = models
      .map((model) => record(model)?.slug ?? record(model)?.id)
      .filter((id): id is string => typeof id === "string" && !!id.trim())
      .map((id) => id.trim());
    if (!modelIds.length) {
      return {
        ...identity,
        status: "unavailable",
        detail: "Codex returned no usable models.",
      };
    }
    return { ...identity, status: "ready", models: [...new Set(modelIds)] };
  } catch {
    return {
      ...identity,
      status: "unavailable",
      detail: "Could not check Codex access; retry later.",
    };
  }
}
