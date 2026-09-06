import { afterEach, expect, setSystemTime, test } from "bun:test";
import { hasCompletedResponse } from "../cli/inference";
import { sharingFixture } from "../test/support/sharing";
import { shareRuntime } from "../test/support/share-runtime";
import { responseEvents, responseStream, sse } from "../test/support/responses";
import { providerConsumerKey, usageKey, inFlightKey } from "./shares";

let fixture: Awaited<ReturnType<typeof sharingFixture>>;
let runtime: Awaited<ReturnType<typeof shareRuntime>>;
afterEach(async () => {
  try {
    await fixture?.close();
  } finally {
    const currentRuntime = runtime;
    fixture = undefined!;
    runtime = undefined!;
    setSystemTime();
    await currentRuntime?.close();
  }
});
const input = {
  models: ["test-pro-model"],
  routes: ["responses"],
  service_tiers: ["auto"],
};
const scope = {
  route: "responses",
  model: "test-pro-model",
  serviceTier: "auto",
  requestedTokens: 10,
  websocket: false,
  compact: false,
};
async function setup() {
  runtime = await shareRuntime();
  fixture = await sharingFixture({ store: runtime });
}
function store(path: string, body?: object) {
  return runtime.fetch(
    new Request(`https://store${path}`, {
      method: body ? "POST" : "GET",
      body: body && JSON.stringify(body),
    }),
  );
}
async function grant(limits: object = {}, consumer = "bob") {
  const response = await fixture.call(
    "alice",
    `/v0/shares/providers/${consumer}`,
    "PUT",
    { ...input, limits },
  );
  expect(response.status).toBe(200);
  return (await response.json()).grant;
}
function infer(consumer = "bob", overrides: object = {}) {
  return fixture.call(
    consumer,
    "/v1/responses",
    "POST",
    {
      model: "test-pro-model",
      service_tier: "auto",
      max_output_tokens: 10,
      stream: true,
      ...overrides,
    },
    "https://alice.mainroom.sh",
  );
}
async function usage(consumer = "bob") {
  return (
    await (await fixture.call(consumer, "/v0/shares/consumers/me")).json()
  ).shares[0].usage;
}

test("concurrent shared streams preserve every byte and enforce per-friend daily budgets in workerd", async () => {
  await setup();
  await grant({ requests_per_day: 31, tokens_per_day: 1000 });
  await grant({ requests_per_day: 1000, tokens_per_day: 290 }, "carol");
  const expected = sse(responseEvents("resp_stress", "café 日本語"), "\r\n");
  let forwarded = 0;
  fixture.setUpstream(
    async () =>
      responseStream(expected, [1, 7, 127, 4096][forwarded++ % 4]!).response,
  );
  const results: { consumer: string; status: number }[] = [];
  for (let wave = 0; wave < 20; wave++)
    results.push(
      ...(await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const consumer = i % 2 ? "bob" : "carol";
          const response = await infer(consumer);
          if (response.ok) {
            expect(response.headers.get("content-type")).toBe(
              "text/event-stream",
            );
            expect(response.headers.get("x-request-id")).toBe("synthetic");
            expect(await response.text()).toBe(expected);
          } else expect(response.status).toBe(429);
          return { consumer, status: response.status };
        }),
      )),
    );
  await fixture.drain();
  expect(
    results.filter((r) => r.consumer === "bob" && r.status === 200),
  ).toHaveLength(31);
  expect(
    results.filter((r) => r.consumer === "carol" && r.status === 200),
  ).toHaveLength(29);
  expect(forwarded).toBe(60);
  expect(await usage()).toMatchObject({
    requests: 31,
    reservedOutputTokens: 310,
    inFlight: 0,
  });
  expect(await usage("carol")).toMatchObject({
    requests: 29,
    reservedOutputTokens: 290,
    inFlight: 0,
  });
  expect(fixture.forwarded.every((name) => name.includes("user_alice"))).toBe(
    true,
  );
}, 30000);

test("held streams enforce concurrency across bursts and release slots on cancellation and failure", async () => {
  await setup();
  await grant({ max_concurrent_requests: 4 });
  for (let wave = 0; wave < 10; wave++) {
    const streams: ReturnType<typeof responseStream>[] = [];
    fixture.setUpstream(async () => {
      const stream = responseStream(
        sse(responseEvents(`resp_${wave}`, "pending").slice(0, 3)),
        17,
        true,
      );
      stream.response.headers.set("x-fixture-index", String(streams.length));
      streams.push(stream);
      return stream.response;
    });
    const results = await Promise.all(
      Array.from({ length: 24 }, () => infer()),
    );
    const admitted = results.filter((r) => r.status === 200);
    expect(admitted).toHaveLength(4);
    expect(results.filter((r) => r.status === 429)).toHaveLength(20);
    expect((await usage()).inFlight).toBe(4);
    for (let i = 0; i < admitted.length; i++) {
      const response = admitted[i]!;
      const source = streams[Number(response.headers.get("x-fixture-index"))]!;
      if (i % 2) {
        const read = response.text();
        source.fail();
        await expect(read).rejects.toThrow("Synthetic stream reset");
      } else {
        await response.body!.cancel("client disconnected");
        await fixture.settled(response);
        expect(source.canceled).toBe(true);
      }
    }
    await fixture.drain();
    expect((await usage()).inFlight).toBe(0);
  }
  expect(await usage()).toMatchObject({
    requests: 40,
    reservedOutputTokens: 400,
  });
}, 30000);

test("CLI completion detection through sharing releases open streams for every terminal outcome", async () => {
  await setup();
  await grant({ max_concurrent_requests: 1 });
  for (const terminal of ["completed", "failed", "incomplete", "eof"]) {
    const events = responseEvents(`resp_${terminal}`, "café", terminal);
    const stream = responseStream(
      sse(terminal === "eof" ? events.slice(0, -1) : events),
      1,
      terminal !== "eof",
    );
    fixture.setUpstream(async () => stream.response);
    const response = await infer();
    expect(response.status).toBe(200);
    expect(await hasCompletedResponse(response)).toBe(terminal === "completed");
    await fixture.drain();
    expect((await usage()).inFlight).toBe(0);
    if (terminal !== "eof") expect(stream.canceled).toBe(true);
  }
});

test("an uncapped request cannot release a newer capped request's lease", async () => {
  await setup();
  await grant();
  fixture.setUpstream(async () => responseStream("", 1, true).response);
  const uncapped = await infer();
  await grant({ max_concurrent_requests: 1 });
  const capped = await infer();
  expect(capped.status).toBe(200);
  await uncapped.body!.cancel();
  await fixture.settled(uncapped);
  expect((await usage()).inFlight).toBe(1);
  expect((await infer()).status).toBe(429);
  await capped.body!.cancel();
  await fixture.drain();
  expect((await usage()).inFlight).toBe(0);
});

test("revoking a grant blocks new streams while an admitted stream drains", async () => {
  await setup();
  await grant({ max_concurrent_requests: 1 });
  const expected = sse(responseEvents("resp_revoke", "already admitted"));
  const stream = responseStream(expected, 13, true);
  fixture.setUpstream(async () => stream.response);
  const admitted = await infer();
  const reading = admitted.text();
  expect(
    (await fixture.call("alice", "/v0/shares/providers/bob", "DELETE")).status,
  ).toBe(200);
  const denied = await Promise.all(Array.from({ length: 40 }, () => infer()));
  expect(denied.every((r) => r.status === 403)).toBe(true);
  await stream.delivered;
  stream.close();
  expect(await reading).toBe(expected);
  await fixture.drain();
  expect((await usage()).inFlight).toBe(0);
  expect(fixture.forwarded).toHaveLength(1);
});

test("provider errors and bodyless responses release capacity without refunding admitted requests", async () => {
  await setup();
  await grant({ max_concurrent_requests: 1 });
  for (const status of [204, 429, 503, 500]) {
    fixture.setUpstream(async () => {
      if (status === 500)
        throw new Error("Synthetic provider connection failure");
      return new Response(status === 204 ? null : "upstream error", { status });
    });
    const response = await infer();
    expect(response.status).toBe(status);
    await response.text();
    await fixture.drain();
    expect((await usage()).inFlight).toBe(0);
  }
  expect((await usage()).requests).toBe(4);
});

test("legacy hash collisions retain reservations and draining leases while new quotas stay isolated", async () => {
  runtime = await shareRuntime();
  const legacyId = "share_18k371r";
  const seeded: Record<string, unknown> = {
    [usageKey(legacyId)]: 1,
    [`${usageKey(legacyId)}:tokens`]: 10,
    [inFlightKey(legacyId)]: 1,
  };
  for (const providerSubject of ["user_Aa", "user_BB"]) {
    const response = await runtime.fetch(
      new Request("https://store/grants", {
        method: "PUT",
        body: JSON.stringify({
          input: {
            ...input,
            limits: {
              requests_per_day: 2,
              tokens_per_day: 20,
              max_concurrent_requests: 1,
            },
          },
          identity: {
            providerSubject,
            providerUsername: providerSubject,
            consumerSubject: "bob",
            consumerUsername: "bob",
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    seeded[providerConsumerKey(providerSubject, "bob")] = {
      ...(await response.json()).grant,
      grantId: legacyId,
    };
  }
  expect((await store("/__seed", seeded)).status).toBe(204);
  expect(
    (
      await store("/authorize", {
        providerSubject: "user_Aa",
        consumerSubject: "bob",
        scope,
      })
    ).status,
  ).toBe(429);
  await store("/release", { grantId: legacyId });
  const leases: string[] = [];
  for (const providerSubject of ["user_Aa", "user_BB"]) {
    const request = { providerSubject, consumerSubject: "bob", scope };
    const response = await store("/authorize", request);
    expect(response.status).toBe(200);
    leases.push((await response.json()).grantId);
    expect((await store("/authorize", request)).status).toBe(429);
  }
  expect(new Set(leases).size).toBe(2);
  await store("/release", { grantId: leases[0] });
  const shares = (await (await store("/consumers?consumerSubject=bob")).json())
    .shares;
  expect(shares.map((share: { usage: object }) => share.usage)).toEqual([
    {
      day: new Date().toISOString().slice(0, 10),
      requests: 2,
      reservedOutputTokens: 20,
      inFlight: 0,
    },
    {
      day: new Date().toISOString().slice(0, 10),
      requests: 2,
      reservedOutputTokens: 20,
      inFlight: 1,
    },
  ]);
  await store("/release", { grantId: leases[1] });
});

test("an admission crossing UTC midnight cannot carry yesterday's usage into today", async () => {
  setSystemTime(new Date("2026-09-05T23:59:59Z"));
  let crossMidnight = false;
  fixture = await sharingFixture({
    onStorageRead(key) {
      if (crossMidnight && key.startsWith("usage:")) {
        crossMidnight = false;
        setSystemTime(new Date("2026-09-06T00:00:00Z"));
      }
    },
  });
  await grant({ requests_per_day: 10 });
  expect((await infer()).status).toBe(200);
  crossMidnight = true;
  expect((await infer()).status).toBe(200);
  expect(await usage()).toMatchObject({
    day: "2026-09-06",
    requests: 0,
    reservedOutputTokens: 0,
  });
  expect((await infer()).status).toBe(200);
  expect(await usage()).toMatchObject({
    requests: 1,
    reservedOutputTokens: 10,
  });
});
