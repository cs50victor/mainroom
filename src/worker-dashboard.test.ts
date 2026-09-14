import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { http, HttpResponse } from "msw";
import { sharingFixture } from "../test/support/sharing";

let fixture: Awaited<ReturnType<typeof sharingFixture>>;
afterEach(async () => {
  if (fixture) await fixture.close();
});

async function dashboardFixture() {
  fixture = await sharingFixture();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = crypto.randomUUID();
  fixture.use(
    http.get("https://api.clerk.com/v1/jwks", () =>
      HttpResponse.json({
        keys: [
          {
            ...publicKey.export({ format: "jwk" }),
            kid,
            alg: "RS256",
            use: "sig",
          },
        ],
      }),
    ),
  );
  function token(username: string, overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: `user_${username}`,
      sid: "session_dashboard",
      iss: "https://fake.clerk.accounts.dev",
      azp: "https://mainroom.sh",
      iat: now,
      nbf: now - 1,
      exp: now + 60,
      ...overrides,
    };
    const payload = [{ alg: "RS256", typ: "JWT", kid }, claims]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
  }
  const call = (
    username: string,
    path: string,
    method = "GET",
    body?: object,
  ) =>
    fixture.call(
      username,
      `/v0/dashboard${path}`,
      method,
      body,
      "https://mainroom.sh",
      {
        authorization: `Bearer ${token(username)}`,
        origin: "https://mainroom.sh",
      },
    );
  return { call, token };
}

test("dashboard sessions manage only the signed-in user's accounts and grants", async () => {
  const f = await dashboardFixture();
  const accounts = await f.call("alice", "/accounts");
  expect(accounts.status).toBe(200);
  expect(accounts.headers.get("cache-control")).toContain("no-store");
  const accountData = await accounts.json();
  expect(accountData.username).toBe("alice");
  expect(
    accountData.accounts.map(
      (account: { accountId: string }) => account.accountId,
    ),
  ).toEqual(["codex_alice"]);
  expect(JSON.stringify(accountData)).not.toContain("private-refresh");
  const grant = await f.call("alice", "/shares/providers/bob", "PUT", {
    models: ["test-pro-model"],
    routes: ["responses"],
    service_tiers: ["auto"],
    limits: {},
  });
  expect(grant.status).toBe(200);
  expect((await grant.json()).grant).toMatchObject({
    providerSubject: "user_alice",
    consumerSubject: "user_bob",
    limits: {},
  });
  expect(
    (await (await f.call("bob", "/shares/consumers/me")).json()).providers,
  ).toHaveLength(1);
  expect(
    (await (await f.call("carol", "/shares/providers")).json()).grants,
  ).toHaveLength(0);
  expect(
    (await f.call("carol", "/shares/providers/bob", "DELETE")).status,
  ).toBe(404);
  expect(
    (
      await f.call("alice", "/shares/providers/bob", "PATCH", {
        status: "disabled",
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.call("alice", "/shares/providers/bob", "DELETE")).status,
  ).toBe(200);
});

test("dashboard rejects expired, forged, foreign-origin, cookie-only and API-key credentials", async () => {
  const f = await dashboardFixture();
  const valid = f.token("alice");
  const parts = valid.split(".");
  parts[1] = Buffer.from(JSON.stringify({ sub: "user_bob" })).toString(
    "base64url",
  );
  const cases = [
    { authorization: `Bearer ${f.token("alice", { exp: 1 })}` },
    { authorization: `Bearer ${parts.join(".")}` },
    {
      authorization: `Bearer ${f.token("alice", { azp: "https://evil.example" })}`,
    },
    { authorization: `Bearer ${f.token("alice", { azp: undefined })}` },
    { authorization: `Bearer ${valid}`, origin: "https://evil.example" },
    { authorization: "", cookie: `__session=${valid}` },
    { authorization: "Bearer sk_alice_test" },
  ];
  for (const headers of cases) {
    const response = await fixture.call(
      "alice",
      "/v0/dashboard/shares/providers/bob",
      "PUT",
      {
        models: ["test-pro-model"],
        routes: ["responses"],
        service_tiers: ["auto"],
        limits: {},
      },
      "https://mainroom.sh",
      headers,
    );
    expect(response.status).toBe(401);
  }
  expect(fixture.reconciled).toHaveLength(0);
  expect(
    (
      await fixture.call(
        "alice",
        "/v0/shares/providers",
        "GET",
        undefined,
        "https://mainroom.sh",
        { authorization: `Bearer ${valid}` },
      )
    ).status,
  ).toBe(401);
});

test("enabling an account from the dashboard updates the owner's runtime", async () => {
  const f = await dashboardFixture();
  fixture.use(
    http.delete(
      "https://storage.test/bucket/settings/tokenproxy/disabled/*",
      () => new HttpResponse(null, { status: 204 }),
    ),
  );
  const response = await f.call("alice", "/accounts/codex.json", "PATCH", {
    enabled: true,
  });
  expect(response.status).toBe(200);
  expect(fixture.reconciled).toEqual([expect.stringContaining("user_alice")]);
  fixture.failReconcile();
  const retry = await f.call("alice", "/accounts/codex.json", "PATCH", {
    enabled: true,
  });
  expect(retry.status).toBe(200);
  expect((await retry.json()).reconcile.error).toContain(
    "could not be updated",
  );
});

test("dashboard model discovery uses only the signed-in user's runtime", async () => {
  const f = await dashboardFixture();
  fixture.setUpstream(async (request, name) =>
    Response.json({ path: new URL(request.url).pathname, owner: name }),
  );
  const response = await f.call("alice", "/models");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "/v1/models",
    owner: expect.stringContaining("user_alice"),
  });
});

test("dashboard reads current quota from the exact owner's stored account and redacts failures", async () => {
  const f = await dashboardFixture();
  fixture.setUpstream(async (request, name) => {
    expect(new URL(request.url).pathname).toBe("/usage");
    expect(name).toContain("user_alice");
    return Response.json({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 27,
          limit_window_seconds: 18000,
          reset_at: 1800000000,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: "42.50" },
      user_id: "private-user",
    });
  });
  const response = await f.call("alice", "/usage");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  expect(body.accounts[0]).toMatchObject({
    health: "ready",
    usage: [{ remaining_percent: 73 }],
    credits: { balance: "42.50" },
  });
  expect(JSON.stringify(body)).not.toContain("private-user");
  fixture.setUpstream(async () => {
    throw new Error("private backend details");
  });
  const unavailable = await f.call("alice", "/usage");
  const result = await unavailable.json();
  expect(result.accounts[0]).toMatchObject({
    health: "unavailable",
    usage: [],
  });
  expect(result.accounts[0].credits).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private backend details");
});
