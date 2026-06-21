# Mainroom and tokenproxy federation design

Status: design spec for the Mainroom and tokenproxy repos.

Date: 2026-06-21.

This spec describes how Mainroom should give each user an immediately usable
OpenAI-compatible token inference endpoint, how `mainroom sync` should keep
remote tokenproxy state current, and how trusted friends should share token
capacity without sharing raw upstream credentials.

The design is deliberately split:

- Mainroom is the durable control plane. It owns identity, subdomains, machine
  desired state, S3/R2 objects, sharing grants, config revisions, and hard
  sharing caps.
- tokenproxy is the data plane. It owns OpenAI-compatible request parsing,
  endpoint support, account selection, streaming, WebSocket proxying, upstream
  health, failover, and usage telemetry.

## Source map

### Mainroom facts

- The Worker currently defines `mainroom.sh` as the root host, creates a
  tokenproxy entrypoint, and starts tokenproxy on `0.0.0.0:8787` with
  `server.allow_non_loopback=true`.
  Source: [`src/worker.ts`](../src/worker.ts#L12-L21).
- `UserMachineContainer` has `defaultPort = 8787`, sleeps after 30 minutes, and
  stores one durable record under `user-machine`.
  Source: [`src/worker.ts`](../src/worker.ts#L87-L90).
- Creating a machine persists the record in Durable Object storage, then starts
  tokenproxy.
  Source: [`src/worker.ts`](../src/worker.ts#L100-L108).
- Any fetch to a user machine reloads the durable record and starts the
  container before forwarding.
  Source: [`src/worker.ts`](../src/worker.ts#L138-L147).
- `startMachine` gets the user's API key secret, injects
  `TOKENPROXY_CLIENT_KEY`, and runs the tokenproxy entrypoint. Mainroom should
  pass temporary signed object URLs for config/auth material rather than S3/R2
  credentials.
  Source: [`src/worker.ts`](../src/worker.ts#L150-L171).
- Mainroom API keys can be fetched, verified, and revoked through the current
  Clerk-backed helper path. The first federation design should reuse that
  existing consumer identity check instead of adding a second token issuer.
  Source: [`src/helpers.ts`](../src/helpers.ts#L201-L248).
- The machine control API creates deterministic per-subject machines by calling
  `getContainer(env.USER_MACHINE_CONTAINER, id)` where `id = user:${subject}`.
  Source: [`src/worker.ts`](../src/worker.ts#L211-L235) and
  [`src/worker.ts`](../src/worker.ts#L395-L397).
- Mainroom already forwards host metadata with `x-forwarded-host`,
  `x-forwarded-proto`, and `x-mainroom-host`.
  Source: [`src/worker.ts`](../src/worker.ts#L175-L192).
- `proxiedRequest()` preserves the incoming `Authorization` header when it
  constructs the request sent to the container.
  Source: [`src/worker.ts`](../src/worker.ts#L175-L192).
- Mainroom currently only checks subdomain username availability on `/`; it does
  not yet route `victor.mainroom.sh/v1/*` to the user's tokenproxy machine.
  Source: [`src/worker.ts`](../src/worker.ts#L320-L351).
- `mainroom codex sync` currently checks sign-in, scans local Codex auth files,
  uploads selected unexpired JSON files, prints the resulting `s3://` object,
  and stops. The target runtime path should use signed object URLs instead of
  passing S3 credentials into tokenproxy.
  Source: [`cli/codex.ts`](../cli/codex.ts#L45-L106).
- The CLI finds `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.
  Source: [`cli/codex.ts`](../cli/codex.ts#L197-L202).
- Uploaded JSON goes to `uploads/json/<encoded user id>/<upload name>`.
  Source: [`src/routes/uploads.ts`](../src/routes/uploads.ts#L71-L90).
- The user-machine image currently downloads the latest tokenproxy release at
  image build time.
  Source: [`Dockerfile.user-machine`](../Dockerfile.user-machine#L7-L20).

### tokenproxy facts

These citations point at tokenproxy `upstream/main` commit
`eb3d4501bc52d36eee3b0005f019e67c8e7e4702` / `v0.1.14`, not the local dirty
checkout.

- tokenproxy parses local or signed `https://` config URLs and CLI
  `-c key=value` overrides, then calls
  `load_effective_config`, discovers models, creates `AppState`, and serves the
  Axum app.
  Source:
  [`src/main.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/main.rs).
- tokenproxy's top-level `--config` accepts a local file or signed HTTPS URL.
  Remote config reads use `FileProvider::read_remote_url_to_string`, and signed
  URL query strings are redacted in read errors.
  Source:
  [`src/main.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/main.rs) and
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- `AppState` stores `effective: Arc<RwLock<Arc<EffectiveConfig>>>`, a shared
  reqwest client, usage windows, per-account health, config status, and a reload
  gate.
  Source:
  [`src/server/state.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state.rs).
- tokenproxy exposes admin config status and reload routes:
  `GET /admin/config/status` and `POST /admin/config/reload`.
  Source:
  [`src/server/state/proxy.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state/proxy.rs).
- Supported routes already include `/v1/models`, `/v1/chat/completions`,
  `/v1/messages`, `POST /v1/responses`, `GET /v1/responses` for WebSockets,
  and `/v1/responses/compact`.
  Source:
  [`src/server/state/proxy.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state/proxy.rs).
- tokenproxy does not currently route legacy `POST /v1/completions`; this spec
  treats "completions" as Chat Completions unless a later tokenproxy change adds
  the legacy route.
  Source:
  [`src/server/state/proxy.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state/proxy.rs).
- tokenproxy exposes `/usage` and `/metrics` built from usage windows and account
  health.
  Source:
  [`src/server/state/proxy.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state/proxy.rs).
- Account config already has endpoint capability booleans for chat
  completions, responses, responses WebSocket, compact, and Anthropic messages.
  Source:
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- Current account kinds are `openai_api_key`, `anthropic_api_key`,
  `chatgpt_codex_auth_json`, and `mainroom_peer`.
  Source:
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- `load_effective_config` turns API-key accounts into bearer tokens from env
  vars and ChatGPT Codex accounts into bearer tokens from `auth_json_path`.
  Source:
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- `auth_json_path` may be a local absolute path or signed HTTPS URL. Remote auth
  JSON reads use the same remote URL reader and redact signed query strings in
  errors.
  Source:
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- tokenproxy no longer needs S3/R2 credentials for remote config or auth JSON
  reads in the Mainroom path. The remote object interface is signed HTTPS URLs,
  not `s3://` URIs.
  Source:
  [`src/config.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/config.rs).
- tokenproxy rejects `chatgpt_codex_auth_json` accounts that claim chat
  completion support. This means Codex OAuth can back Responses/Codex-style
  traffic, but not OpenAI Chat Completions in current tokenproxy.
  Source:
- For each selected account, tokenproxy builds upstream auth from the account
  kind. `mainroom_peer` forwards the inbound bearer to the peer Mainroom edge.
  Source:
  [`src/http/forward.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/http/forward.rs).
- Selection already filters on endpoint support, model allowlists, service
  tiers, WebSocket support, health, and pinned continuation account.
  Source:
  [`src/routing/select.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/routing/select.rs).
- Route requests already carry `pinned_account_id` and a flag for incremental
  `previous_response_id` support.
  Source:
  [`src/routing/account.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/routing/account.rs).
- tokenproxy only retries before upstream commit.
  Source:
  [`src/server/state/proxy.rs`](https://github.com/cs50victor/tokenproxy/blob/eb3d4501bc52d36eee3b0005f019e67c8e7e4702/src/server/state/proxy.rs).

### Platform and API facts

- Cloudflare describes a binding as "a permission and an API in one piece" where
  the underlying secret is not exposed to Worker code. This supports keeping
  platform credentials in the control plane rather than rendering new per-peer
  secrets into tokenproxy containers.
  Source: <https://developers.cloudflare.com/workers/runtime-apis/bindings/>.
- Cloudflare Service Bindings allow Worker-to-Worker calls without a public URL
  and are commonly used for shared internal services and public-internet
  isolation. This is useful future context for splitting a Mainroom auth helper
  out of the public Worker, but it is not required for the first peer-sharing
  design.
  Source:
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>.
- OAuth 2.0 Token Exchange defines a Security Token Service pattern for
  exchanging one valid token for another token scoped to a downstream resource.
  It is the right future pattern if Mainroom later needs narrower, short-lived
  peer assertions, but the first design can get the same authorization boundary
  by validating the existing caller bearer at B's Mainroom edge.
  Source: <https://datatracker.ietf.org/doc/html/rfc8693>.
- API gateway token-exchange guidance places identity translation and
  downscoping at the gateway so backend services do not each solve identity
  complexity. Mainroom's Worker is already the gateway in front of every
  `*.mainroom.sh` machine, so B's edge should remain the hard policy
  enforcement point.
  Source: <https://konghq.com/blog/engineering/token-exchange-at-the-gateway>.

- Cloudflare Container classes extend Durable Objects; the Durable Object owns
  routing, lifecycle, and persistent storage, while the container filesystem is
  ephemeral.
  Source: [Cloudflare Container class docs](https://developers.cloudflare.com/containers/container-class/).
- Cloudflare Containers `fetch()` starts the container if it is not running and
  forwards to the default port. The docs also call out that `fetch` is the
  container method that supports WebSocket proxying.
  Source: [Cloudflare Container class docs](https://developers.cloudflare.com/containers/container-class/).
- Cloudflare recommends explicit `getContainer(namespace, id)` routing for one
  logical entity, such as a user session or sandbox, and `getRandom` for
  stateless load balancing.
  Source: [Cloudflare Containers scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/).
- Durable Objects provide a globally unique name and strongly consistent durable
  storage. In-memory state can disappear on hibernation, so durable state must
  be written before relying on it.
  Source: [Cloudflare Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).
- R2 is S3-compatible and strongly consistent.
  Sources: [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) and
  [How R2 works](https://developers.cloudflare.com/r2/how-r2-works/).
- OpenAI Chat Completions are exposed as `POST /chat/completions`.
  Source: [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat).
- OpenAI Responses are exposed as `POST /responses`.
  Source: [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).
- OpenAI recommends Responses for stateful conversations; Chat Completions
  callers manage conversation state manually.
  Source: [OpenAI conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state).
- OpenAI streaming uses server-sent events for streaming responses and chat
  completions.
  Source: [OpenAI streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).
- OpenAI WebSocket mode keeps a persistent `/v1/responses` connection and uses
  `previous_response_id` to continue conversation state.
  Source: [OpenAI WebSocket mode guide](https://developers.openai.com/api/docs/guides/websocket-mode).

## Goals

1. A user should be able to use `https://victor.mainroom.sh/v1/chat/completions`,
   `https://victor.mainroom.sh/v1/responses`, and
   `https://victor.mainroom.sh/v1/messages` as ready-to-use token inference
   endpoints.
2. `mainroom sync` should upload usable local auth material to S3/R2, update the
   durable desired tokenproxy config, and reconcile the user's running
   tokenproxy machine.
3. If a tokenproxy server is running and its desired config changes, Mainroom
   should reload it live when possible and restart it when needed.
4. If the tokenproxy server has stopped, the next start must use the latest
   persisted desired config, not whatever happened to be in old process memory.
5. Friend sharing should let user A route through user B's Mainroom endpoint
   only when B has authorized that spend and A has accepted B as a trusted peer.
6. Mainroom must enforce hard sharing caps and revocation before B's upstream
   credentials are spent.
7. tokenproxy should reuse its current route parser, account selector, health,
   cooldown, pre-commit failover, streaming, and WebSocket behavior.

## Non-goals

1. Mainroom should not invent a second inference proxy in the Worker. The Worker
   can terminate auth and route to containers, but tokenproxy should remain the
   OpenAI-compatible proxy.
2. Friends should never receive each other's upstream OpenAI, ChatGPT, Anthropic,
   or tokenproxy internal bearer tokens.
3. Mainroom should not rely on remote container disk as durable state. Container
   disk is ephemeral; DO storage and R2/S3 are the durable sources of truth.
4. A request that has already committed bytes upstream should not fail over to a
   different peer. That would corrupt streaming and Responses conversation
   continuity.

## Target request flows

### User-owned endpoint

The simple path for `victor.mainroom.sh/v1/responses` is:

1. The client sends a normal OpenAI-compatible request to
   `https://victor.mainroom.sh/v1/responses` with the Mainroom CLI bearer token.
2. The Cloudflare Worker derives `victor` from the host, resolves it to the
   Clerk subject, and gets the deterministic `UserMachineContainer` for
   `user:<subject>`.
3. `UserMachineContainer.fetch()` reconciles desired state before proxying.
4. The Worker forwards to tokenproxy on port 8787 with the original path and
   relevant forwarded host headers.
5. tokenproxy validates `TOKENPROXY_CLIENT_KEY`, selects a configured local or
   peer account, forwards upstream, and streams the response if requested.

The existing machine ID shape already matches the Cloudflare guidance for a
single logical user container: use explicit container IDs, not random container
selection.

### Friend-shared endpoint

When user A consumes user B's shared tokens:

1. B creates a provider grant for A in Mainroom.
2. A accepts B as a trusted peer candidate.
3. Mainroom renders A's desired tokenproxy config with a peer account:

   ```toml
   [[accounts]]
   id = "peer:userb"
   kind = "mainroom_peer"
   base_url = "https://userb.mainroom.sh/v1"
   priority = 50
   models = ["gpt-5.1", "o3"]
   supports_chat_completions = true
   supports_responses = true
   supports_responses_ws = false
   supports_compact = false
   supports_anthropic_messages = false
   service_tiers = ["auto", "default", "priority"]
   ```

4. A's tokenproxy treats that peer like any other account during selection.
5. If A's tokenproxy selects B, it forwards the request to
   `https://userb.mainroom.sh/v1/...` with the original Mainroom caller bearer.
   This bearer identifies consumer A. The host identifies provider B.
6. B's Mainroom edge verifies the caller bearer through the existing API-key
   path, checks the active provider grant from A to B, enforces hard caps, strips
   A's bearer, injects B's internal tokenproxy bearer, and forwards to B's user
   machine.
7. B's tokenproxy spends B's configured upstream account and returns the result.
8. B's edge records final usage against the grant. A's tokenproxy also records
   local usage and health for routing decisions.

This keeps selection local to A and enforcement local to B's control plane. The
peer account config is routing metadata, not an authorization record.

## Sharing model

The phrase "A trusts B" is useful, but it is not enough to authorize token spend.
There are two separate relationships:

1. Provider grant: B authorizes A to spend B's capacity under specific scopes.
2. Consumer trust: A allows B to appear as a selectable peer account.

Mainroom should render a peer account only when both exist and both are active.
The durable sharing state should look like this:

```json
{
  "grant_id": "grant_01j...",
  "provider_subject": "userB",
  "consumer_subject": "userA",
  "consumer_trust_id": "trust_01j...",
  "revision": 12,
  "status": "active",
  "scopes": {
    "endpoints": ["responses", "chat_completions"],
    "models": ["gpt-5.1", "o3"],
    "service_tiers": ["auto", "default", "priority"],
    "daily_request_cap": 100,
    "daily_token_cap": 1000000,
    "stream": true,
    "websocket": false
  },
  "created_at": "2026-06-21T00:00:00Z",
  "updated_at": "2026-06-21T00:00:00Z",
  "revoked_at": null
}
```

The provider grant is the hard authorization record. The consumer trust record
is a routing preference. Removing either record removes the peer account from
A's next rendered config.

## Peer authorization model

The first implementation should not mint or render per-peer bearer tokens such
as `MAINROOM_PEER_TOKEN_USERB_GRANT_01J`. Those variables would require one
container environment entry per active peer grant and would make a dynamic
control-plane object look like process-startup state. That is the wrong
operational boundary for friend sharing.

Use the existing Mainroom caller bearer as the consumer proof:

1. `userb.mainroom.sh` identifies the provider subject from the host.
2. The `Authorization: Bearer ...` header identifies the consumer subject after
   Mainroom verifies it through the existing API-key path.
3. B's Mainroom edge resolves the single active grant for
   `(provider_subject, verified_consumer_subject)`.
4. Mainroom storage enforces at most one active grant per
   `(provider_subject, consumer_subject)`, so tokenproxy does not need to pass a
   grant selector.
5. B's edge checks grant status, path scope, model scope, streaming/WebSocket
   scope, and remaining request/token budget.
6. B's edge strips A's caller bearer before the request reaches B's tokenproxy.
7. B's edge injects B's internal `TOKENPROXY_CLIENT_KEY` only on the private hop
   to B's user machine.

The provider-side Mainroom edge validates:

1. The caller bearer is a valid non-revoked Mainroom API key.
2. The provider subject derived from the host exists and maps to a user machine.
3. For non-owner callers, exactly one active grant exists for
   `(provider_subject, caller_subject)`.
4. The resolved grant's `consumer_subject` and `provider_subject` match the
   verified caller and host-derived provider.
5. Request path is allowed by `scopes.endpoints`.
6. Request body model is allowed by `scopes.models`.
7. Streaming and WebSocket mode are allowed.
8. The daily request and token caps still have budget.

The provider-side edge should reject with `403` for revoked or disallowed
scope, and `429` for exhausted grant caps.

If Mainroom later needs narrower peer credentials than the caller API key, add a
small Mainroom token-exchange endpoint that returns short-lived
audience-scoped peer assertions. That would follow the RFC 8693 STS pattern, but
it should be a later hardening step rather than a first-version dependency.

## Config source of truth

The remote tokenproxy process should not be the source of truth. Mainroom should
persist desired state in two places:

1. Durable Object storage for small strongly consistent records:
   machine record, desired revision, running revision, selected auth object IDs,
   sharing graph revision, peer grants, and reconcile status.
2. R2/S3 for larger or secret-bearing blobs:
   uploaded auth JSON, rendered tokenproxy config, and immutable revision
   snapshots. Mainroom stores object keys durably and mints temporary signed
   HTTPS URLs when tokenproxy needs to read an object.

Suggested object layout:

```text
uploads/json/<encoded-subject>/<auth-upload-name>.json
tokenproxy/users/<encoded-subject>/configs/rev-00000042.toml
tokenproxy/users/<encoded-subject>/configs/current.toml
tokenproxy/users/<encoded-subject>/configs/current.json
```

`current.json` should be a small pointer:

```json
{
  "revision": 42,
  "config_key": "tokenproxy/users/userA/configs/rev-00000042.toml",
  "config_signed_url_expires_at": "2026-06-21T00:15:00Z",
  "config_sha256": "9f...",
  "rendered_at": "2026-06-21T00:00:00Z",
  "tokenproxy_version": "0.8.0"
}
```

The immutable revision object makes audits and rollbacks easy. The stable
`current.*` objects make startup simple.

## Current tokenproxy support

Recent tokenproxy commits already landed the data-plane primitives this spec
needs:

### 1. Signed remote object loading

tokenproxy accepts signed HTTPS URLs for remote runtime objects. This is the
Mainroom runtime contract: Mainroom owns S3/R2 credentials, stores durable object
keys, and passes tokenproxy only temporary signed read URLs.

Reasoning:

- tokenproxy `v0.1.14` replaced the old `s3://` remote read path with signed
  HTTPS URL reads.
- `--config` accepts `FILE_OR_URL` and fetches signed `https://` config URLs.
- `auth_json_path` accepts signed `https://` auth JSON URLs.
- Admin reload accepts `config_url` for signed remote config reloads.
- Remote URL read errors redact signed query strings.

Startup should use:

```text
tokenproxy --config https://storage.example/tokenproxy/users/<subject>/configs/current.toml?X-Amz-Signature=... \
  -c server.bind='0.0.0.0:8787' \
  -c server.allow_non_loopback=true
```

### 2. `mainroom_peer` account kind

tokenproxy has a fourth account kind:

```rust
enum AccountKind {
    OpenAiApiKey,
    AnthropicApiKey,
    ChatgptCodexAuthJson,
    MainroomPeer,
}
```

`MainroomPeer`:

- Use `base_url` as an OpenAI-compatible upstream root.
- Support any subset of `/v1/chat/completions`, `/v1/responses`,
  `/v1/responses` WebSocket, `/v1/responses/compact`, and `/v1/messages`
  according to config.
- Forward with the original downstream `Authorization` bearer so the provider
  Mainroom edge can verify the consumer subject and grant. It must not forward
  A's internal tokenproxy bearer to B's tokenproxy; B's edge strips the consumer
  bearer and injects B's internal bearer on the private machine hop.
- Not require `token_env`, `mainroom_peer_grant_id`,
  `mainroom_peer_provider`, or `mainroom_peer_consumer`; those are Mainroom
  control-plane facts, not tokenproxy routing facts.
- Avoid sending caller-controlled `x-mainroom-peer-*` headers. If Mainroom wants
  resolved grant or consumer metadata for logs, B's edge should add those
  headers after it verifies the caller and resolves the grant.
- Avoid sending OpenAI-specific beta or organization headers unless the existing
  upstream header policy allows them.

This is smaller than building a separate friend load balancer because the
selector already filters by endpoint, model, service tier, health, WebSocket
support, and pinned account.

It is also smaller than a first-version token-exchange service. The host already
names provider B, Mainroom already has the consumer API-key verification path,
and B's edge already sits in front of B's tokenproxy machine. A short-lived
Mainroom peer assertion can be added later if the existing caller bearer becomes
too broad for the threat model.

### 3. Live config status and reload

tokenproxy exposes admin endpoints bound to the configured admin token:

```text
GET  /admin/config/status
POST /admin/config/reload
```

`GET /admin/config/status` should return:

```json
{
  "revision": 42,
  "config_sha256": "9f...",
  "tokenproxy_version": "0.8.0",
  "started_at": "2026-06-21T00:00:00Z",
  "accounts": [
    {
      "id": "codex-primary",
      "kind": "chatgpt_codex_auth_json",
      "health": "open"
    },
    {
      "id": "peer:userb:grant_01j",
      "kind": "mainroom_peer",
      "health": "open"
    }
  ],
  "reload_in_progress": false
}
```

`POST /admin/config/reload` accepts inline config or a signed config URL and can
preserve the same container-level CLI overrides used at startup:

```json
{
  "revision": 43,
  "config_sha256": "ab...",
  "config_url": "https://storage.example/tokenproxy/users/userA/configs/rev-00000043.toml?X-Amz-Signature=..."
}
```

Mainroom can keep the durable source in S3/R2, mint a short-lived signed URL,
and submit that URL for reload without exposing S3/R2 credentials to tokenproxy.

Reload algorithm:

1. Authenticate the admin request.
2. Fetch and hash the candidate config.
3. Parse it and apply CLI overrides that are immutable for the container
   environment, such as bind address.
4. Call the same validation path used at startup.
5. Discover models if needed.
6. Build the replacement runtime config.
7. Preserve health cells and usage windows for account IDs that still exist.
8. Create health cells for new account IDs.
9. Mark removed account IDs as unavailable for new routing.
10. Atomically swap the runtime config.
11. Return the new revision and effective account count.

Implementation detail: tokenproxy now stores
`AppState.effective: Arc<RwLock<Arc<EffectiveConfig>>>`, so reload swaps the
effective config for new requests while in-flight requests keep using the config
they already captured.

Requests that already captured an `Arc` continue using the old config until
they finish. New requests see the new config. This is the reason to swap an
`Arc` instead of mutating config in place.

### 4. Restart-required changes

Not every change should live reload. Mainroom should restart the user machine
when any of these change:

- tokenproxy binary version.
- container image version.
- bind address or externally visible port.
- environment variables that tokenproxy reads only during process startup.
- TLS/root CA/base system package changes.
- a failed config reload that leaves the process healthy on the old revision.

For simple account list, auth JSON, model allowlist, peer grant metadata, and
priority changes, live reload should be enough. Peer grant changes must not
require adding per-peer environment variables to the container.

## Required Mainroom changes

### 1. Subdomain `/v1/*` router

Add Worker routing for:

```text
https://<username>.mainroom.sh/v1/*
```

The route should:

1. Parse `<username>` using the existing host parsing rule.
2. Resolve username to subject.
3. Load the `UserMachineContainer` for `user:<subject>`.
4. Call `reconcile()` before forwarding.
5. Forward OpenAI-compatible requests to the container.
6. Preserve WebSocket upgrades for `GET /v1/responses`.

Root `/` can continue to return username status for now, but `/v1/*` must route
to tokenproxy.

### 2. Desired machine state

Extend `UserMachineRecord` from:

```ts
type UserMachineRecord = {
  apiKeyId: string;
  id: string;
  subject: string;
};
```

to:

```ts
type UserMachineRecord = {
  apiKeyId: string;
  id: string;
  subject: string;
  username: string;
  desiredRevision: number;
  desiredConfigSha256: string;
  desiredConfigObjectKey: string;
  desiredConfigSignedUrl?: string;
  desiredConfigSignedUrlExpiresAt?: string;
  desiredTokenproxyVersion: string;
  runningRevision?: number;
  runningConfigSha256?: string;
  runningTokenproxyVersion?: string;
  lastReconciledAt?: string;
  lastReconcileError?: string;
};
```

The key rule: desired state is durable. Running state is observational.

### 3. Reconcile path

Add a method on `UserMachineContainer`:

```ts
async reconcile(reason: "sync" | "fetch" | "share-update"): Promise<MachineStatus>
```

Algorithm:

1. Load `UserMachineRecord` from Durable Object storage.
2. If no record exists, return `404`.
3. If the container is stopped, mint a fresh signed config URL and start it with
   that URL.
4. If the container is running, call tokenproxy
   `GET /admin/config/status`.
5. If status revision and hash match desired state, record running state and
   return.
6. If tokenproxy version differs, restart the container.
7. If revision/hash differ, call `POST /admin/config/reload`.
8. If reload succeeds, update running state in Durable Object storage.
9. If reload returns `404` or admin unsupported, restart the container. This
   handles old tokenproxy releases.
10. If reload fails validation, keep the old process running, record the error,
    and return a clear `502` to the sync caller.

The Worker's regular `/v1/*` path should run a cheap reconcile check before
forwarding. It can skip the admin status call when the DO record already says
`runningRevision === desiredRevision` and `lastReconciledAt` is recent.

### 4. Sync API

The CLI should move from "upload JSON only" to a desired-state sync:

```text
mainroom sync
mainroom codex sync
```

`mainroom codex sync` may remain as an alias, but the broader `mainroom sync`
should be the product command because it affects machine state too.

The CLI should send:

```json
{
  "auth_files": [
    {
      "path_label": "~/.codex/auth.json",
      "upload_name": "codex-acct-user@example.com.json",
      "sha256": "51...",
      "expires_at": "2026-06-22T00:00:00Z",
      "last_refresh": "2026-06-21T00:00:00Z",
      "content": "{...}"
    }
  ],
  "start_machine": true,
  "reconcile": true
}
```

The server should:

1. Verify the Mainroom CLI bearer token.
2. Validate JSON and expiry.
3. Write changed auth blobs to S3/R2.
4. Mint temporary signed auth JSON URLs and render the desired tokenproxy config
   from current auth objects and sharing graph.
5. Write immutable and current config objects.
6. Increment the desired config revision if the rendered config hash changed.
7. Persist desired state in the user machine DO.
8. Reconcile the running machine.
9. Return endpoint URLs and machine status.

Response:

```json
{
  "endpoint": "https://victor.mainroom.sh/v1",
  "routes": {
    "chat_completions": "https://victor.mainroom.sh/v1/chat/completions",
    "responses": "https://victor.mainroom.sh/v1/responses",
    "messages": "https://victor.mainroom.sh/v1/messages"
  },
  "revision": 43,
  "config_sha256": "ab...",
  "machine": {
    "state": "running",
    "running_revision": 43,
    "reconciled": true
  }
}
```

## Running server behavior

### If tokenproxy is already running

Mainroom should not assume that changing S3 objects affects a running
tokenproxy process. A running process has already loaded its config into memory.

The sequence should be:

1. Sync writes new desired config to R2/S3.
2. Sync updates DO desired revision.
3. Sync calls `reconcile`.
4. `reconcile` asks tokenproxy for its live config status.
5. If stale, `reconcile` mints fresh signed URLs and calls live reload.
6. If live reload is unsupported or unsafe, `reconcile` restarts the container.

This answers the question "should tokenproxy have an endpoint to update config
live in memory?" Yes. It should have one, but Mainroom still needs a restart
fallback because older tokenproxy releases and process-env changes cannot be
live reloaded safely.

### If tokenproxy stops

Nothing important should be lost. On the next request or explicit sync:

1. `UserMachineContainer.fetch()` loads the durable machine record.
2. `startMachine` mints a fresh signed URL for the latest persisted config.
3. tokenproxy reads current config from the signed URL.
4. The DO records the observed running revision after status succeeds.

This answers the persistence question: tokenproxy's in-memory config is a cache,
not storage. Mainroom's DO plus S3/R2 config object persists the sharing config
across process stops, and signed URLs are temporary read handles, not durable
state.

## Keeping S3 auth JSON fresh

There are two different stale-file cases.

### Local auth file changes after a sync

No remote system can know a laptop file changed. Mainroom should support
explicit sync:

```text
mainroom sync
```

Explicit sync computes a SHA-256 of each local auth file and uploads when the
local hash differs from the server's last stored hash.

The minimum reliable rule is content hash.

### Remote tokenproxy auth changes

Remote tokenproxy should not edit OAuth JSON on container disk. The remote
process should read auth JSON through temporary signed URLs at startup and
reload. If tokenproxy later learns to refresh OAuth tokens itself, it must write
the refreshed token back to Mainroom through an authenticated callback, and
Mainroom must update the S3/R2 object plus desired config revision.

For the first version, keep OAuth refresh outside remote tokenproxy and make the
local `mainroom sync` responsible for pushing refreshed local files when the user
runs it.

### Upload object strategy

The current upload endpoint writes to a stable key derived from user ID and
upload name. That can stay, but the server should store hash metadata:

```json
{
  "upload_name": "codex-acct-user@example.com.json",
  "s3_key": "uploads/json/userA/codex-acct-user@example.com.json",
  "sha256": "51...",
  "last_seen_local_path": "~/.codex/auth.json",
  "expires_at": "2026-06-22T00:00:00Z",
  "last_refresh": "2026-06-21T00:00:00Z",
  "updated_at": "2026-06-21T00:00:00Z"
}
```

If compliance or auditability needs immutable auth revisions, add:

```text
uploads/json/<subject>/<upload-name>.json
uploads/json/<subject>/revisions/<sha256>.json
```

The stable key is what tokenproxy config references. The revision key is for
audit and rollback.

## Endpoint readiness by credential type

The product promise is "ready to use endpoints", but not every credential can
support every endpoint.

Current tokenproxy rejects `chatgpt_codex_auth_json` for
`/v1/chat/completions`. Therefore:

- `/v1/responses` can be ready when the user has a usable Codex/ChatGPT auth
  JSON account.
- `/v1/chat/completions` is ready only when the rendered config includes an
  OpenAI API key account or a `mainroom_peer` account that allows chat
  completions.
- `/v1/messages` is ready only when the rendered config includes an Anthropic
  API key account or a peer that allows Anthropic messages.

Mainroom should expose all three route URLs immediately, but the route should
return tokenproxy's clear unsupported-account error if no configured account can
serve it. The CLI should print readiness by route:

```text
Endpoint: https://victor.mainroom.sh/v1
Ready:
  /v1/responses          codex-primary
Not configured:
  /v1/chat/completions   add OpenAI API key or trusted peer
  /v1/messages           add Anthropic key or trusted peer
```

This is more honest than silently pretending Codex OAuth can do chat
completions when tokenproxy currently rejects that combination.

## Streaming and WebSockets

Streaming and WebSockets are policy-sensitive sharing scopes.

Rules:

1. A peer account is selectable for streaming only if the grant allows
   `stream = true`.
2. A peer account is selectable for WebSocket only if the grant allows
   `websocket = true`.
3. A WebSocket connection selects one account at connection setup and sticks to
   it for the whole connection.
4. A Responses continuation using `previous_response_id` must route to the same
   account that created that response when the upstream requires stateful
   continuation.
5. tokenproxy may pre-commit fail over before bytes are committed, but once an
   upstream response stream starts, it must not switch peers.

tokenproxy already has the right primitives: endpoint filters, WebSocket
filters, pinned account filtering, and pre-commit failover. The peer account
work should extend those primitives instead of adding a separate code path.

## Cap enforcement

Caps should be enforced in two places:

1. Soft cap in A's tokenproxy selection state. If A knows B's grant is exhausted,
   stop selecting it.
2. Hard cap in B's Mainroom edge. B's edge is authoritative because it protects
   B's upstream tokens.

Suggested hard-cap flow:

1. Before forwarding to B's tokenproxy, reserve one request against the grant.
2. If the request body or headers indicate stream mode, mark the reservation as
   open.
3. On final response, parse usage if available and reconcile token usage.
4. If the response stream disconnects before final usage, charge a conservative
   request unit and leave token usage unknown.
5. Reset daily counters by UTC day unless the grant specifies a timezone.

Counters should be keyed by:

```text
grant_id + yyyy-mm-dd
```

`grant_id` is an internal Mainroom primary key after B's edge resolves the active
grant. It is not rendered into A's tokenproxy config and is not accepted from
tokenproxy as an authorization selector.

## Revocation

Revocation is a provider-side action and must take effect at the hard
enforcement edge.

When B revokes A's grant:

1. Mainroom marks the grant revoked in durable storage.
2. B's edge rejects future peer calls from A with `403`.
3. Mainroom increments A's desired config revision so A's tokenproxy removes the
   peer account on reload.
4. Existing in-flight HTTP streams can finish, unless B selects "close active
   streams" in a later UI.
5. Existing WebSocket connections should receive a policy error and close on the
   next message boundary if immediate revocation is required.

The hard edge check means revocation works even if A's tokenproxy has not yet
reloaded.

## Security boundaries

- The user's own tokenproxy downstream bearer stays private to that user's
  machine and Mainroom edge.
- The consumer's Mainroom caller bearer may reach the provider's Mainroom edge
  for peer authorization, but it must be stripped before the provider's
  tokenproxy receives the request.
- Mainroom should log grant IDs and hashed account IDs, not raw bearer tokens.
- The upload route should continue rejecting non-JSON and over-large JSON files.
- Mainroom should keep S3/R2 signing credentials in the control plane. The
  tokenproxy process should receive only temporary signed read URLs, not S3
  access keys or R2 credentials.
- Mainroom should never send B's upstream OAuth, API key, or internal
  `TOKENPROXY_CLIENT_KEY` to A.
- If Mainroom later adds peer assertions, they should be scoped,
  audience-bound, short-lived, revocable, and useless outside the provider's
  Mainroom subdomain.

## Failure modes

| Failure                                                    | Expected behavior                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A syncs new auth JSON while tokenproxy is running          | Mainroom uploads changed JSON, renders new config, then reloads tokenproxy or restarts it.              |
| tokenproxy has no admin reload endpoint                    | Mainroom restarts the container after detecting `404` or unsupported admin route.                       |
| tokenproxy reload validation fails                         | Keep old config running, record error in DO state, and return sync failure.                             |
| B revokes A while A is still sending requests              | B's edge rejects immediately, even before A reloads.                                                    |
| B's machine is asleep                                      | `userb.mainroom.sh/v1/*` fetch starts it through the provider's `UserMachineContainer`.                 |
| B's tokenproxy is unhealthy                                | A's tokenproxy records peer health and cools it down like any other account.                            |
| Peer grant cap is exhausted                                | B's edge returns `429`; A's tokenproxy marks the peer usage-limited if headers/body expose reset data.  |
| `previous_response_id` routes to the wrong peer            | tokenproxy must pin response chains to the original account and reject or replay rather than fail over. |
| S3/R2 object changed but running tokenproxy did not reload | Mainroom detects revision/hash mismatch via admin status, mints fresh signed URLs, and reconciles.      |
| Container restarts after sleep                             | Mainroom mints a signed config URL; tokenproxy reads it and reports the current revision.               |

## CLI behavior

`mainroom sync` should be the command users run after local auth changes.
`mainroom codex sync` can call the same implementation with a Codex-only source
filter.

Expected output:

```text
Checking Mainroom sign-in...
Scanning local auth files...
Uploading 1 changed auth file...
Rendering tokenproxy config rev 43...
Reconciling victor.mainroom.sh...
Reloaded tokenproxy rev 42 -> rev 43.

Endpoint:
  https://victor.mainroom.sh/v1

Routes:
  /v1/responses          ready
  /v1/chat/completions   needs OpenAI API key or peer
  /v1/messages           needs Anthropic key or peer
```

## API additions

### Mainroom

```text
POST /v0/sync
POST /v0/sync/codex
GET  /v0/machines/:id
POST /v0/machines/:id/reconcile
GET  /v0/shares
POST /v0/shares/grants
POST /v0/shares/grants/:id/revoke
POST /v0/shares/trust
DELETE /v0/shares/trust/:id
GET  /.well-known/mainroom-jwks.json
```

The existing `/v0/uploads/json` can stay as a low-level upload endpoint, but the
sync endpoint should become the high-level path because it knows when to render
config and reconcile the machine.

### tokenproxy

```text
GET  /admin/config/status
POST /admin/config/reload
```

Optionally:

```text
POST /admin/shutdown
```

Mainroom can usually restart through the Container API without a tokenproxy
shutdown endpoint, so shutdown is not required for the first implementation.

## Implementation order

1. Mainroom spec and data model.
2. Mainroom rendered config objects and desired machine state.
3. Mainroom subdomain `/v1/*` routing.
4. `mainroom sync` high-level command.
5. Provider grant and consumer trust APIs.
6. Provider-side edge enforcement and cap counters.

This order lets Mainroom ship useful value early now that tokenproxy has signed
HTTPS config loading, `mainroom_peer`, and admin reload support. Subdomain
routing and desired-state sync make `victor.mainroom.sh/v1/responses` real
before friend sharing is complete.

Tracking issues:

- Mainroom peer sharing and provider-edge enforcement:
  <https://github.com/cs50victor/mainroom/issues/12>.
- tokenproxy signed URL remote reads:
  <https://github.com/cs50victor/tokenproxy/pull/31>.

## Tiny experiments run for this spec

### CLI help

Command:

```text
bun run cli/mainroom.ts --help
bun run cli/mainroom.ts codex sync --help
```

Observed:

```text
Commands:
  auth            Log in, sign up, and manage saved credentials.
  codex           Upload Codex auth files.
  ping            Check the API connection.

Usage: mainroom codex sync [options]
Upload unexpired local Codex auth JSON files.
```

Conclusion: the current CLI UX confirms that sync is upload-only and should be
expanded into desired-state reconciliation.

### tokenproxy recent federation commits

Command:

```text
git -C ../tokenproxy log --oneline --decorate -5
git -C ../tokenproxy grep -n "mainroom_peer\\|config/status\\|config/reload\\|config_url\\|read_remote_url" HEAD -- src
```

Observed:

```text
eb3d450 feat: replace s3 remote reads with signed urls (#31)
896fcd5 chore: release v0.1.13
a1ce344 feat: add Mainroom federation support (#28)
eb8e8bd refactor: nest server proxy under state (#29)
```

Conclusion: tokenproxy already has the federation data-plane primitives this
spec needs, including signed HTTP URL remote object reads in `v0.1.14`. The
remaining work is Mainroom control-plane integration and edge policy.

### config drift state machine

Command:

```text
bun --eval 'const machine={desired:7,running:5,runningState:"running"}; const action=machine.running===machine.desired?"noop":machine.runningState==="running"?"reload-or-restart":"start"; console.log(JSON.stringify({desired:machine.desired,running:machine.running,action}));'
```

Observed:

```json
{ "desired": 7, "running": 5, "action": "reload-or-restart" }
```

Conclusion: the durable desired revision and observed running revision are
enough to decide whether a running server is stale.

### peer selection filter

Command:

```text
bun --eval 'const accounts=[{id:"usera-local",priority:0,endpoints:["responses"],models:["gpt-5.1"],health:"open"},{id:"peer-userb",priority:10,endpoints:["responses","chat"],models:["gpt-5.1"],health:"open",grant:{dailyRemaining:3,ws:true}},{id:"peer-userc",priority:20,endpoints:["chat"],models:["gpt-4o"],health:"open",grant:{dailyRemaining:0,ws:true}}]; const req={endpoint:"responses",model:"gpt-5.1",ws:true,pinned:"peer-userb"}; const candidates=accounts.filter(a=>a.health==="open"&&a.endpoints.includes(req.endpoint)&&a.models.includes(req.model)&&(!req.ws||a.grant?.ws||a.id.endsWith("local"))&&(!req.pinned||a.id===req.pinned)&&((a.grant?.dailyRemaining??1)>0)); console.log(JSON.stringify({selected:candidates.sort((a,b)=>b.priority-a.priority)[0].id,candidates:candidates.map(a=>a.id)}));'
```

Observed:

```json
{ "selected": "peer-userb", "candidates": ["peer-userb"] }
```

Conclusion: peer routing can be represented as account selection with extra
scope and cap filters. That matches tokenproxy's existing selector shape.

### auth object stale detection

Command:

```text
bun --eval 'const crypto=await import("node:crypto"); const local="{\"tokens\":{\"access_token\":\"new\"}}"; const s3="{\"tokens\":{\"access_token\":\"old\"}}"; const h=s=>crypto.createHash("sha256").update(s).digest("hex"); console.log(JSON.stringify({local:h(local).slice(0,12),s3:h(s3).slice(0,12),shouldUpload:h(local)!==h(s3)}));'
```

Observed:

```json
{ "local": "514082e09725", "s3": "8c29d2b6463b", "shouldUpload": true }
```

Conclusion: content hash is the right stale detector.

### MCP registry and search surfaces

Commands:

```text
mcpx --help
mcpx registry list
mcpx skills context7
mcpx skills serpapi
mcpx skills exa_search
mcpx skills parallel_search
```

Observed relevant registries and tools:

- `context7` for current framework docs.
- `serpapi`, `exa_search`, and `parallel_search` for external search.
- `github` through `gh search` for source and repository search.
- `clerk` is available for future Clerk-specific implementation details.

GitHub searches run:

```text
gh search code "chatgpt.com/backend-api/codex" "auth.json" --language Rust --limit 10 --json repository,path,url
gh search code "prompt_cache_key" "previous_response_id" --language Rust --limit 10 --json repository,path,url
gh search code "OpenAI-compatible" "load balancing" "failover" --language Go --limit 10 --json repository,path,url
```

Signals:

- Public Rust projects commonly read Codex or ChatGPT auth JSON and use the
  access token as the upstream credential for Codex/ChatGPT-style traffic.
- OpenAI-compatible gateway projects commonly model routing and failover at the
  account/provider layer.
- No search result contradicted the local source constraint that tokenproxy
  currently treats Codex OAuth differently from OpenAI Chat Completions.

## Final design choice

The simplest correct architecture is:

1. Mainroom owns durable desired state and edge policy.
2. tokenproxy owns inference proxy behavior.
3. A friend is rendered as a tokenproxy account kind.
4. The provider's Mainroom edge validates peer grants and caps before any
   provider token is spent.
5. Running tokenproxy config is reloadable, but never authoritative.
6. Stopped tokenproxy instances always reconstruct from Mainroom's durable state.

This keeps friend sharing inside the existing tokenproxy routing model while
putting persistence, revocation, and hard authorization in the system that
already owns identity and subdomains.
