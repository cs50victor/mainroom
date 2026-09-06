import { afterEach, expect, test } from "bun:test";
import { sharingFixture } from "../test/support/sharing";

let fixture: Awaited<ReturnType<typeof sharingFixture>>;
afterEach(async () => {
  if (fixture) await fixture.close();
});
const access = {
  models: ["test-pro-model"],
  routes: ["responses"],
  service_tiers: ["auto"],
  limits: { requests_per_day: 2, tokens_per_day: 1000 },
};

test("Clerk OAuth identities, usernames and keys stay distinct for three Pro subscribers", async () => {
  fixture = await sharingFixture();
  for (const user of fixture.users) {
    const response = await fixture.exchange(user.username);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      username: user.username,
      apiKey: { subject: user.id, secret: `sk_${user.username}_test` },
    });
    const accounts = await fixture.call(
      user.username,
      "/v0/tokenproxy/accounts",
    );
    expect(accounts.status).toBe(200);
    const body = await accounts.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      accountId: `codex_${user.username}`,
      status: "ready",
      models: ["test-pro-model"],
    });
  }
  expect((await fixture.exchange("unknown")).status).toBe(401);
});

test("a real Worker-to-store grant permits Bob, denies Carol, and exposes only scoped usage", async () => {
  fixture = await sharingFixture();
  const granted = await fixture.call(
    "alice",
    "/v0/shares/providers/bob",
    "PUT",
    access,
  );
  expect(granted.status).toBe(200);
  expect((await granted.json()).grant).toMatchObject({
    providerSubject: "user_alice",
    consumerSubject: "user_bob",
    serviceTiers: ["auto"],
    limits: { requestsPerDay: 2, tokensPerDay: 1000 },
  });
  const infer = (user: string, model = "test-pro-model") =>
    fixture.call(
      user,
      "/v1/responses",
      "POST",
      { model, service_tier: "auto", max_output_tokens: 100 },
      "https://alice.mainroom.sh",
    );
  expect((await infer("carol")).status).toBe(403);
  expect((await infer("bob", "unshared-model")).status).toBe(403);
  expect(fixture.forwarded).toHaveLength(0);
  expect((await infer("bob")).status).toBe(200);
  expect(fixture.forwarded[0]).toContain("user_alice");
  const bob = await (
    await fixture.call("bob", "/v0/shares/consumers/me")
  ).json();
  expect(bob.providers).toHaveLength(1);
  expect(bob.providers[0]).toMatchObject({
    provider: "alice",
    limits: { requestsPerDay: 2 },
    usage: { requests: 1, reservedOutputTokens: 100 },
  });
  for (const user of ["alice", "carol"]) {
    expect(
      (await (await fixture.call(user, "/v0/shares/consumers/me")).json())
        .providers,
    ).toHaveLength(0);
  }
  expect(JSON.stringify(bob)).not.toContain("private-refresh");
  expect(JSON.stringify(bob)).not.toContain("test-signature");
  expect((await infer("bob")).status).toBe(200);
  expect((await infer("bob")).status).toBe(429);
  expect(fixture.forwarded).toHaveLength(2);
  expect(
    (await fixture.call("bob", "/v0/shares/providers/alice", "DELETE")).status,
  ).toBe(404);
  expect(
    (
      await fixture.call("alice", "/v0/shares/providers/bob", "PATCH", {
        status: "disabled",
      })
    ).status,
  ).toBe(200);
  expect((await infer("bob")).status).toBe(403);
  expect(
    (await fixture.call("alice", "/v0/shares/providers/bob", "DELETE")).status,
  ).toBe(200);
  expect(
    (await (await fixture.call("bob", "/v0/shares/consumers/me")).json())
      .providers,
  ).toHaveLength(0);
  expect(fixture.objects.size).toBe(3);
});

test("unknown and revoked keys, self-sharing and missing friends cannot create grants", async () => {
  fixture = await sharingFixture();
  fixture.keys.get("sk_carol_test")!.revoked = true;
  for (const user of ["unknown", "carol"]) {
    expect(
      (await fixture.call(user, "/v0/shares/providers/bob", "PUT", access))
        .status,
    ).toBe(401);
  }
  expect(
    (await fixture.call("alice", "/v0/shares/providers/alice", "PUT", access))
      .status,
  ).toBe(400);
  expect(
    (await fixture.call("alice", "/v0/shares/providers/missing", "PUT", access))
      .status,
  ).toBe(404);
  expect(fixture.reconciled).toHaveLength(0);
});
