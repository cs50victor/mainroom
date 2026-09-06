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
