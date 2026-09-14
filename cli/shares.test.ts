import { afterEach, expect, test } from "bun:test";
import { sharingFixture } from "../test/support/sharing";
let fixture: Awaited<ReturnType<typeof sharingFixture>>;
afterEach(async () => {
  if (fixture) await fixture.close();
});
const invite = [
  "invite",
  "bob",
  "--models",
  "test-pro-model",
  "--requests-per-day",
  "10",
];

test("CLI grants by username and distinguishes incoming from outgoing shares", async () => {
  fixture = await sharingFixture();
  const refused = await fixture.cli("alice", invite);
  expect(refused.code).toBe(1);
  expect(fixture.reconciled).toHaveLength(0);
  const created = await fixture.cli("alice", [...invite, "--yes"]);
  expect(created.code).toBe(0);
  expect(created.output).toContain("Access granted to bob");
  const bob = await fixture.cli("bob", ["list", "--json"]);
  expect(bob.code).toBe(0);
  const listing = JSON.parse(bob.output);
  expect(listing.outgoing).toHaveLength(0);
  expect(listing.incoming).toHaveLength(1);
  expect(listing.incoming[0]).toMatchObject({
    provider: "alice",
    limits: { requestsPerDay: 10 },
  });
  const alice = await fixture.cli("alice", ["list", "--json"]);
  expect(JSON.parse(alice.output).outgoing[0].consumerUsername).toBe("bob");
  const carol = await fixture.cli("carol", ["list", "--json"]);
  expect(JSON.parse(carol.output).incoming).toHaveLength(0);
  expect((await fixture.cli("bob", ["connect"])).code).toBe(0);
  expect((await fixture.cli("alice", ["disable", "bob", "--yes"])).code).toBe(
    0,
  );
  const paused = await fixture.cli("bob", ["list", "--json"]);
  expect(JSON.parse(paused.output).incoming[0].status).toBe("disabled");
  expect((await fixture.cli("alice", ["revoke", "bob", "--yes"])).code).toBe(0);
  const updates = fixture.reconciled.length;
  expect((await fixture.cli("bob", ["connect"])).code).toBe(0);
  expect(fixture.reconciled.length).toBe(updates + 1);
  expect((await fixture.cli("carol", ["connect"])).code).toBe(1);
});

test("CLI reports persisted sharing separately from a failed node update", async () => {
  fixture = await sharingFixture();
  fixture.failReconcile();
  const result = await fixture.cli("alice", [...invite, "--yes"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Share saved");
  const list = await fixture.cli("bob", ["list", "--json"]);
  expect(JSON.parse(list.output).incoming).toHaveLength(1);
});

test("CLI lists both directions of mutual sharing with independent friend usage", async () => {
  fixture = await sharingFixture();
  for (const [provider, consumer] of [
    ["alice", "bob"],
    ["bob", "alice"],
    ["carol", "alice"],
  ]) {
    expect(
      (
        await fixture.cli(provider, [
          "invite",
          consumer,
          "--models",
          "test-pro-model",
          "--requests-per-day",
          "10",
          "--yes",
        ])
      ).code,
    ).toBe(0);
  }
  expect(
    (
      await fixture.call(
        "alice",
        "/v1/responses",
        "POST",
        { model: "test-pro-model", max_output_tokens: 100 },
        "https://bob.mainroom.sh",
      )
    ).status,
  ).toBe(200);
  const output = await fixture.cli("alice", []);
  expect(output.code).toBe(0);
  expect(output.output).toContain("Sharing with you: active");
  const result = await fixture.cli("alice", ["list", "--json"]);
  const shares = JSON.parse(result.output);
  expect(
    shares.incoming.map((share: { provider: string }) => share.provider).sort(),
  ).toEqual(["bob", "carol"]);
  expect(
    shares.incoming.find(
      (share: { provider: string }) => share.provider === "bob",
    ).usage,
  ).toMatchObject({ requests: 1, reservedOutputTokens: 100 });
  expect(
    shares.incoming.find(
      (share: { provider: string }) => share.provider === "carol",
    ).usage.requests,
  ).toBe(0);
  expect(shares.outgoing[0].consumerUsername).toBe("bob");
  expect(shares.outgoing[0].usage.requests).toBe(0);
});

test("CLI full access discovers concrete models and grants every scope without caps", async () => {
  fixture = await sharingFixture();
  const result = await fixture.cli("alice", [
    "invite",
    "bob",
    "--full-access",
    "--yes",
  ]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("unlimited requests/day");
  expect(result.output).not.toContain("undefined");
  const listing = JSON.parse(
    (await fixture.cli("alice", ["list", "--json"])).output,
  );
  expect(listing.outgoing[0]).toMatchObject({
    models: ["test-pro-model"],
    routes: ["chat_completions", "responses", "messages"],
    serviceTiers: ["auto", "default", "priority", "flex", "fast"],
    supportsResponsesWs: true,
    supportsCompact: true,
    limits: {},
  });
  for (const path of [
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses/compact",
  ]) {
    const response = await fixture.call(
      "bob",
      path,
      "POST",
      {
        model: "test-pro-model",
        service_tier: "fast",
        max_output_tokens: 1000000,
      },
      "https://alice.mainroom.sh",
    );
    expect(response.status).toBe(200);
  }
});

test("CLI configures arbitrary models, scopes and independent caps", async () => {
  fixture = await sharingFixture();
  const result = await fixture.cli("alice", [
    "invite",
    "bob",
    "--models",
    "other-provider/model",
    "test-pro-model",
    "--routes",
    "responses",
    "messages",
    "--service-tiers",
    "auto",
    "priority",
    "--tokens-per-day",
    "500",
    "--max-concurrent-requests",
    "2",
    "--supports-responses-ws",
    "--supports-compact",
    "--yes",
  ]);
  expect(result.code).toBe(0);
  const listing = JSON.parse(
    (await fixture.cli("alice", ["list", "--json"])).output,
  );
  expect(listing.outgoing[0]).toMatchObject({
    models: ["other-provider/model", "test-pro-model"],
    routes: ["responses", "messages"],
    serviceTiers: ["auto", "priority"],
    supportsResponsesWs: true,
    supportsCompact: true,
    limits: { tokensPerDay: 500, maxConcurrentRequests: 2 },
  });
  expect(listing.outgoing[0].limits.requestsPerDay).toBeUndefined();
  const denied = await fixture.call(
    "bob",
    "/v1/responses",
    "POST",
    {
      model: "other-provider/model",
      max_output_tokens: 501,
    },
    "https://alice.mainroom.sh",
  );
  expect(denied.status).toBe(429);
});

test("CLI can share discovered or explicit models without limits", async () => {
  fixture = await sharingFixture();
  for (const models of [
    ["--all-models"],
    ["--models", "other-provider/model"],
  ]) {
    const result = await fixture.cli("alice", [
      "invite",
      "bob",
      ...models,
      "--unlimited",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    const listing = JSON.parse(
      (await fixture.cli("alice", ["list", "--json"])).output,
    );
    expect(listing.outgoing[0].limits).toEqual({});
    expect(listing.outgoing[0].routes).toEqual(["responses"]);
    expect(listing.outgoing[0].serviceTiers).toEqual(["auto"]);
  }
});

test("CLI rejects contradictory grants and invalid limits without changing access", async () => {
  fixture = await sharingFixture();
  const invalid = [
    ["--full-access", "--requests-per-day", "1"],
    ["--full-access", "--models", "test-pro-model"],
    ["--full-access", "--service-tiers", "auto"],
    ["--full-access", "--routes", "responses"],
    ["--all-models", "--models", "test-pro-model", "--unlimited"],
    ["--models", "test-pro-model", "--unlimited", "--requests-per-day", "1"],
    ["--models", "test-pro-model", "--unlimited", "--tokens-per-day", "1"],
    [
      "--models",
      "test-pro-model",
      "--unlimited",
      "--max-concurrent-requests",
      "1",
    ],
    ["--models", "test-pro-model", "--tokens-per-day", "0"],
    ["--models", "test-pro-model", "--max-concurrent-requests", "1.5"],
    ["--models", "*", "--unlimited"],
  ];
  for (const args of invalid) {
    expect(
      (await fixture.cli("alice", ["invite", "bob", ...args, "--yes"])).code,
    ).toBe(1);
  }
  expect(fixture.reconciled).toHaveLength(0);
  const listing = JSON.parse(
    (await fixture.cli("alice", ["list", "--json"])).output,
  );
  expect(listing.outgoing).toEqual([]);
});
