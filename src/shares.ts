export const shareRoutes = [
  "chat_completions",
  "responses",
  "messages",
] as const;

export type ShareRoute = (typeof shareRoutes)[number];
export type ShareStatus = "active" | "disabled" | "revoked";

export type ShareLimits = {
  requestsPerDay?: number;
  tokensPerDay?: number;
  maxConcurrentRequests?: number;
};

export type ShareGrantInput = {
  models: string[];
  routes: ShareRoute[];
  serviceTiers: string[];
  supportsResponsesWs: boolean;
  supportsCompact: boolean;
  limits: ShareLimits;
};

export type ShareGrantRecord = ShareGrantInput & {
  grantId: string;
  providerSubject: string;
  providerUsername: string;
  consumerSubject: string;
  consumerUsername: string;
  status: ShareStatus;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type ShareGrantIdentity = Pick<
  ShareGrantRecord,
  | "consumerSubject"
  | "consumerUsername"
  | "providerSubject"
  | "providerUsername"
>;

export type PeerRequestScope = {
  route: ShareRoute;
  model?: string;
  requestedTokens: number;
  serviceTier?: string;
  websocket: boolean;
  compact: boolean;
};

export function normalizeShareGrantInput(
  body: unknown,
): ShareGrantInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "share grant body must be an object" };
  }

  const input = body as Record<string, unknown>;
  const models = stringList(input.models);
  if (!models.length)
    return { error: "models must include at least one model" };

  const routes = routeList(input.routes);
  if (!routes.length)
    return { error: "routes must include at least one route" };

  const serviceTiers = stringList(input.service_tiers);
  if (!serviceTiers.length) {
    return { error: "service_tiers must include at least one service tier" };
  }

  const limits = normalizeLimits(input.limits);
  if ("error" in limits) return limits;

  return {
    models,
    routes,
    serviceTiers,
    supportsResponsesWs: input.supports_responses_ws === true,
    supportsCompact: input.supports_compact === true,
    limits,
  };
}

export function parsePeerRequestScope(
  request: Request,
  body: Record<string, unknown>,
): PeerRequestScope {
  const pathname = new URL(request.url).pathname;
  return {
    compact: pathname === "/v1/responses/compact" || body.compact === true,
    model: stringValue(body.model),
    requestedTokens:
      positiveInteger(body.max_output_tokens) ??
      positiveInteger(body.max_tokens) ??
      positiveInteger(body.max_completion_tokens) ??
      0,
    route: routeFromPath(pathname),
    serviceTier: stringValue(body.service_tier),
    websocket: request.headers.get("Upgrade")?.toLowerCase() === "websocket",
  };
}

export function shareScopeDenial(
  grant: ShareGrantRecord,
  scope: PeerRequestScope,
): string | undefined {
  if (!grant.routes.includes(scope.route)) return "Route is not shared";
  if (scope.model && !grant.models.includes(scope.model)) {
    return "Model is not shared";
  }
  if (scope.serviceTier && !grant.serviceTiers.includes(scope.serviceTier)) {
    return "Service tier is not shared";
  }
  if (scope.websocket && !grant.supportsResponsesWs) {
    return "Responses WebSocket is not shared";
  }
  if (scope.compact && !grant.supportsCompact) {
    return "Compact requests are not shared";
  }

  return undefined;
}

export function providerConsumerKey(
  providerSubject: string,
  consumerSubject: string,
): string {
  return `grant:${providerSubject}:${consumerSubject}`;
}

export function renderConsumerShare(grant: ShareGrantRecord) {
  return {
    provider: grant.providerUsername,
    base_url: `https://${grant.providerUsername}.mainroom.sh/v1`,
    models: grant.models,
    routes: grant.routes,
    service_tiers: grant.serviceTiers,
    supports_responses_ws: grant.supportsResponsesWs,
    supports_compact: grant.supportsCompact,
  };
}

export function renderPeerAccount(grant: ShareGrantRecord) {
  return {
    id: `peer:${grant.providerUsername}`,
    kind: "mainroom_peer",
    base_url: `https://${grant.providerUsername}.mainroom.sh/v1`,
    priority: 50,
    models: grant.models,
    supports_chat_completions: grant.routes.includes("chat_completions"),
    supports_responses: grant.routes.includes("responses"),
    supports_responses_ws: grant.supportsResponsesWs,
    supports_compact: grant.supportsCompact,
    supports_anthropic_messages: grant.routes.includes("messages"),
    service_tiers: grant.serviceTiers,
  };
}

export function upsertShareGrant(
  existing: ShareGrantRecord | undefined,
  input: ShareGrantInput,
  identity: ShareGrantIdentity,
  now: string,
): ShareGrantRecord {
  return {
    ...input,
    ...identity,
    grantId:
      existing?.grantId ??
      grantId(identity.providerSubject, identity.consumerSubject),
    createdAt: existing?.createdAt ?? now,
    status: "active",
    updatedAt: now,
  };
}

export function usageKey(grantId: string): string {
  return `usage:${grantId}:${new Date().toISOString().slice(0, 10)}`;
}

export function inFlightKey(grantId: string): string {
  return `inflight:${grantId}`;
}

export function stripUntrustedPeerHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-mainroom-peer-")) {
      headers.delete(name);
    }
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function routeList(value: unknown): ShareRoute[] {
  return stringList(value).filter((item): item is ShareRoute =>
    shareRoutes.includes(item as ShareRoute),
  );
}

function normalizeLimits(value: unknown): ShareLimits | { error: string } {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "limits must be an object" };
  }

  const input = value as Record<string, unknown>;
  const limits: ShareLimits = {};

  for (const [source, target] of [
    ["requests_per_day", "requestsPerDay"],
    ["tokens_per_day", "tokensPerDay"],
    ["max_concurrent_requests", "maxConcurrentRequests"],
  ] as const) {
    const raw = input[source];
    if (raw == null) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      return { error: `${source} must be a positive integer` };
    }
    limits[target] = raw;
  }

  return limits;
}

function routeFromPath(pathname: string): ShareRoute {
  if (pathname === "/v1/chat/completions") return "chat_completions";
  if (pathname === "/v1/messages") return "messages";
  return "responses";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function grantId(providerSubject: string, consumerSubject: string): string {
  const input = `${providerSubject}:${consumerSubject}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return `share_${hash.toString(36)}`;
}
