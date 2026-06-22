import { describe, expect, test } from "bun:test";

import {
  authorizeShareGrant,
  normalizeShareGrantInput,
  parsePeerRequestScope,
  renderPeerAccount,
  requiresPeerGrant,
  shareScopeDenial,
  upsertShareGrant,
  stripUntrustedPeerHeaders,
  type PeerRequestScope,
  type ShareGrantRecord,
} from "./shares";

function grant(overrides: Partial<ShareGrantRecord> = {}): ShareGrantRecord {
  return {
    grantId: "grant_1",
    providerSubject: "provider",
    providerUsername: "userb",
    consumerSubject: "consumer",
    consumerUsername: "usera",
    status: "active",
    routes: ["responses"],
    models: ["gpt-5.1"],
    serviceTiers: ["auto"],
    supportsResponsesWs: false,
    supportsCompact: false,
    limits: { requestsPerDay: 10 },
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

const scope: PeerRequestScope = {
  route: "responses",
  model: "gpt-5.1",
  serviceTier: "auto",
  requestedTokens: 100,
  websocket: false,
  compact: false,
};

describe("peerAccount", () => {
  test("renders only tokenproxy routing metadata", () => {
    const account = renderPeerAccount(grant());

    expect(account).toEqual({
      id: "peer:userb",
      kind: "mainroom_peer",
      base_url: "https://userb.mainroom.sh/v1",
      priority: 50,
      models: ["gpt-5.1"],
      supports_chat_completions: false,
      supports_responses: true,
      supports_responses_ws: false,
      supports_compact: false,
      supports_anthropic_messages: false,
      service_tiers: ["auto"],
    });
  });
});

describe("share grants", () => {
  test("upserts keep one stable grant per provider-consumer pair", () => {
    const first = upsertShareGrant(
      undefined,
      {
        routes: ["responses"],
        models: ["gpt-5.1"],
        serviceTiers: ["auto"],
        supportsResponsesWs: false,
        supportsCompact: false,
        limits: {},
      },
      {
        providerSubject: "provider",
        providerUsername: "userb",
        consumerSubject: "consumer",
        consumerUsername: "usera",
      },
      "2026-06-21T00:00:00.000Z",
    );
    const second = upsertShareGrant(
      first,
      { ...first, models: ["gpt-5.2"], limits: { requestsPerDay: 2 } },
      {
        providerSubject: first.providerSubject,
        providerUsername: first.providerUsername,
        consumerSubject: first.consumerSubject,
        consumerUsername: first.consumerUsername,
      },
      "2026-06-21T01:00:00.000Z",
    );

    expect(second.grantId).toBe(first.grantId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-06-21T01:00:00.000Z");
    expect(second.models).toEqual(["gpt-5.2"]);
    expect(second.status).toBe("active");
  });
});

describe("scopeDenial", () => {
  test("returns undefined when route model and service tier are allowed", () => {
    expect(
      shareScopeDenial(grant(), {
        route: "responses",
        model: "gpt-5.1",
        serviceTier: "auto",
        requestedTokens: 0,
        websocket: false,
        compact: false,
      }),
    ).toBeUndefined();
  });

  test("rejects models outside the grant", () => {
    expect(
      shareScopeDenial(grant(), {
        route: "responses",
        model: "gpt-4o",
        serviceTier: "auto",
        requestedTokens: 0,
        websocket: false,
        compact: false,
      }),
    ).toBe("Model is not shared");
  });

  test("rejects compact and WebSocket scopes unless explicitly allowed", () => {
    expect(
      shareScopeDenial(grant(), {
        route: "responses",
        requestedTokens: 0,
        websocket: true,
        compact: false,
      }),
    ).toBe("Responses WebSocket is not shared");

    expect(
      shareScopeDenial(grant(), {
        route: "responses",
        requestedTokens: 0,
        websocket: false,
        compact: true,
      }),
    ).toBe("Compact requests are not shared");
  });
});

describe("authorizeShareGrant", () => {
  test("does not require a grant for provider-owned calls", () => {
    expect(requiresPeerGrant("provider", "provider")).toBe(false);
    expect(requiresPeerGrant("provider", "consumer")).toBe(true);
  });

  test("allows valid peer calls and returns updated counters", () => {
    expect(
      authorizeShareGrant(grant(), scope, {
        requests: 0,
        tokens: 0,
        inFlight: 0,
      }),
    ).toEqual({
      ok: true,
      lease: false,
      usage: { requests: 1, tokens: 100, inFlight: 0 },
    });
  });

  test("returns a lease for max-concurrency limited grants", () => {
    expect(
      authorizeShareGrant(
        grant({ limits: { maxConcurrentRequests: 2 } }),
        scope,
        {
          requests: 0,
          tokens: 0,
          inFlight: 1,
        },
      ),
    ).toEqual({
      ok: true,
      lease: true,
      usage: { requests: 1, tokens: 100, inFlight: 2 },
    });
  });

  test("rejects missing revoked model route and cap failures", () => {
    expect(
      authorizeShareGrant(undefined, scope, {
        requests: 0,
        tokens: 0,
        inFlight: 0,
      }),
    ).toEqual({ ok: false, status: 403, error: "No active grant" });

    expect(
      authorizeShareGrant(grant({ status: "revoked" }), scope, {
        requests: 0,
        tokens: 0,
        inFlight: 0,
      }),
    ).toEqual({ ok: false, status: 403, error: "No active grant" });

    expect(
      authorizeShareGrant(
        grant(),
        { ...scope, model: "gpt-4o" },
        { requests: 0, tokens: 0, inFlight: 0 },
      ),
    ).toEqual({ ok: false, status: 403, error: "Model is not shared" });

    expect(
      authorizeShareGrant(
        grant(),
        { ...scope, route: "chat_completions" },
        { requests: 0, tokens: 0, inFlight: 0 },
      ),
    ).toEqual({ ok: false, status: 403, error: "Route is not shared" });

    expect(
      authorizeShareGrant(grant({ limits: { requestsPerDay: 1 } }), scope, {
        requests: 1,
        tokens: 0,
        inFlight: 0,
      }),
    ).toEqual({
      ok: false,
      status: 429,
      error: "Daily request cap exhausted",
    });

    expect(
      authorizeShareGrant(grant({ limits: { tokensPerDay: 150 } }), scope, {
        requests: 0,
        tokens: 100,
        inFlight: 0,
      }),
    ).toEqual({
      ok: false,
      status: 429,
      error: "Daily token cap exhausted",
    });

    expect(
      authorizeShareGrant(
        grant({ limits: { maxConcurrentRequests: 1 } }),
        scope,
        {
          requests: 0,
          tokens: 0,
          inFlight: 1,
        },
      ),
    ).toEqual({
      ok: false,
      status: 429,
      error: "Concurrent request cap exhausted",
    });
  });
});

describe("normalizeShareGrantInput", () => {
  test("deduplicates lists and rejects malformed limits", () => {
    expect(
      normalizeShareGrantInput({
        models: ["gpt-5.1", "gpt-5.1"],
        routes: ["responses", "invalid"],
        service_tiers: ["auto"],
        limits: { requests_per_day: 10, tokens_per_day: 1000 },
      }),
    ).toEqual({
      models: ["gpt-5.1"],
      routes: ["responses"],
      serviceTiers: ["auto"],
      supportsResponsesWs: false,
      supportsCompact: false,
      limits: { requestsPerDay: 10, tokensPerDay: 1000 },
    });

    expect(
      normalizeShareGrantInput({
        models: ["gpt-5.1"],
        routes: ["responses"],
        service_tiers: ["auto"],
        limits: { requests_per_day: 0 },
      }),
    ).toEqual({ error: "requests_per_day must be a positive integer" });
  });
});

describe("parsePeerRequestScope", () => {
  test("extracts route model tier WebSocket compact and token budget", () => {
    const request = new Request("https://userb.mainroom.sh/v1/responses", {
      method: "POST",
      headers: { Upgrade: "websocket" },
    });

    expect(
      parsePeerRequestScope(request, {
        model: "gpt-5.1",
        service_tier: "auto",
        max_output_tokens: 2000,
      }),
    ).toEqual({
      route: "responses",
      model: "gpt-5.1",
      serviceTier: "auto",
      requestedTokens: 2000,
      websocket: true,
      compact: false,
    });
  });
});

describe("stripUntrustedPeerHeaders", () => {
  test("removes hostile caller-supplied peer headers", () => {
    const headers = new Headers({
      "x-mainroom-peer-grant-id": "stale",
      "x-mainroom-peer-provider": "wrong",
      "x-mainroom-host": "userb.mainroom.sh",
    });

    stripUntrustedPeerHeaders(headers);

    expect(headers.has("x-mainroom-peer-grant-id")).toBe(false);
    expect(headers.has("x-mainroom-peer-provider")).toBe(false);
    expect(headers.get("x-mainroom-host")).toBe("userb.mainroom.sh");
  });
});
