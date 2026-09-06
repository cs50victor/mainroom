import { afterEach, expect, test } from "bun:test";
import { checkCodexAccount, codexAuthIdentity } from "./codex-accounts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const jwt = (claims: object) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const credential = JSON.stringify({
  tokens: {
    account_id: "account-a",
    access_token: jwt({ exp: 1 }),
    id_token: jwt({ email: "a@example.com" }),
  },
});

test("parses both supported credential layouts without trusting malformed JSON", () => {
  expect(codexAuthIdentity(credential)?.accountId).toBe("account-a");
  expect(
    codexAuthIdentity(
      JSON.stringify({
        account_id: "flat",
        access_token: "token",
        email: "b@example.com",
      }),
    )?.email,
  ).toBe("b@example.com");
  for (const text of [
    "null",
    "[]",
    "bad",
    '{"tokens":null}',
    '{"tokens":{"account_id":123}}',
  ]) {
    expect(codexAuthIdentity(text)).toBeUndefined();
  }
});

test("checks real access instead of treating an old JWT date as revocation", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toStartWith(
      "https://chatgpt.com/backend-api/codex/models",
    );
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
      "account-a",
    );
    return Response.json({ models: [{ slug: "model-a" }] });
  }) as typeof fetch;
  const result = await checkCodexAccount("a.json", credential);
  expect(result.status).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("access_token");
  expect(JSON.stringify(result)).not.toContain("signature");
});

test("401 requests reauth but 403, rate limits, server errors and timeouts do not", async () => {
  for (const status of [401, 403, 429, 503]) {
    globalThis.fetch = (async () =>
      new Response("error", { status })) as typeof fetch;
    expect((await checkCodexAccount("a.json", credential)).status).toBe(
      status === 401 ? "reauth_required" : "unavailable",
    );
  }
  globalThis.fetch = (async () => {
    throw new Error("network secret details");
  }) as typeof fetch;
  const result = await checkCodexAccount("a.json", credential);
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("secret details");
});

test("disabled accounts do not contact the provider", async () => {
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  expect((await checkCodexAccount("a.json", credential, true)).status).toBe(
    "disabled",
  );
});
