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
    const request = url instanceof Request ? url : new Request(url, init);
    expect(request.url).toStartWith(
      "https://chatgpt.com/backend-api/codex/models",
    );
    expect(request.headers.get("chatgpt-account-id")).toBe("account-a");
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

test("blocked edge checks fall back to the exact account's runtime probe", async () => {
  globalThis.fetch = (async () =>
    new Response("edge block", { status: 403 })) as typeof fetch;
  for (const status of [200, 401, 403, 302]) {
    let calls = 0;
    const result = await checkCodexAccount(
      "a.json",
      credential,
      false,
      async (auth) => {
        calls++;
        expect(auth.accountId).toBe("account-a");
        expect(auth.accessToken).toBe(
          codexAuthIdentity(credential)?.accessToken,
        );
        return Response.json(
          { models: [{ slug: "runtime-model" }] },
          { status },
        );
      },
    );
    expect(calls).toBe(1);
    const statuses: Record<number, string> = {
      200: "ready",
      401: "reauth_required",
    };
    expect(result.status).toBe(statuses[status] ?? "unavailable");
    if (status === 200) expect(result.models).toEqual(["runtime-model"]);
  }
  const result = await checkCodexAccount(
    "a.json",
    credential,
    false,
    async () => {
      throw new Error("Fly error echoing private credential");
    },
  );
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("private credential");
});

test("runtime fallback never overrides a provider rejection or checks disabled accounts", async () => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 401 })) as typeof fetch;
  let calls = 0;
  const fallback = async () => {
    calls++;
    return Response.json({ models: [{ slug: "wrong" }] });
  };
  expect(
    (await checkCodexAccount("a.json", credential, false, fallback)).status,
  ).toBe("reauth_required");
  expect(
    (await checkCodexAccount("a.json", credential, true, fallback)).status,
  ).toBe("disabled");
  expect(calls).toBe(0);
});

test("credential headers reject control characters", () => {
  for (const value of [
    "account\r\nx-header: injected",
    "token\u0000",
    "token\tvalue",
  ]) {
    expect(
      codexAuthIdentity(
        JSON.stringify({ account_id: value, access_token: "token" }),
      ),
    ).toBeUndefined();
    expect(
      codexAuthIdentity(
        JSON.stringify({ account_id: "account", access_token: value }),
      ),
    ).toBeUndefined();
  }
});
