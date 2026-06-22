import { describe, expect, test } from "bun:test";

import {
  normalizeShareGrantInput,
  parsePeerRequestScope,
  renderPeerAccount,
  shareScopeDenial,
  stripUntrustedPeerHeaders,
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
  test("removes caller-supplied peer headers", () => {
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
