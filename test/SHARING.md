# Sharing stress tests

Requires Node.js 22+ alongside Bun. Run `bun test src/sharing-stress.test.ts`. For a longer run, use
`bun test src/sharing-stress.test.ts --rerun-each=20`. CI runs the suite once.

Each run sends 695 inference requests through the real Mainroom Worker with
synthetic Alice, Bob, and Carol Pro accounts. Clerk HTTP calls are intercepted
by MSW; the provider returns synthetic Responses API streams. The actual
ShareGrantStore runs in Miniflare/workerd with SQLite Durable Object storage,
including Cloudflare's storage gates. Miniflare runs in a Node subprocess;
Worker forwarding runs in Bun with an observed `waitUntil` context. The separate
UTC rollover test uses Bun's clock control and an in-memory store, without
concurrency. An async Map cannot establish concurrent quota correctness.

The tests cover:

- 400 requests in bursts of 20, checking independent request and reserved-output
  budgets for two friends, exact streamed bytes, UTF-8 splits, and provider routing.
- Ten bursts of 24 requests with four concurrent slots, alternating client
  cancellation and upstream stream failure before reusing every slot.
- CLI completion checks on one-byte chunks: completed, failed, incomplete, and
  EOF without a terminal event. Terminal events arrive before the stream closes.
- Adding a concurrency cap while an uncapped request remains open, revoking
  access during a stream, provider connection failures, and HTTP error responses.
- Existing grants with colliding legacy IDs, including stored daily reservations
  and an open legacy lease. New usage remains independent after that lease drains.
- A request crossing UTC midnight while reading storage, followed by another
  request in the new accounting day.

No real Clerk/OpenAI credentials, paid inference, production traffic, or Fly
machines are involved. The suite tests Mainroom's HTTP SSE sharing boundary;
it does not validate tokenproxy internals, real subscription allowances,
WebSocket frame authorization, or deployed network capacity. The synthetic
$200/month Pro scenario does not imply a fixed token allowance. Usage counts
admitted requests and requested output-token reservations, including failed
requests, rather than upstream billed tokens.

## Upstream fixture patterns

Researched with `gh search code` and `gh api` against `openai/codex`, pinned to
`ac192cd7937b0d73edc6dffe009940ae53782dd4`:

- [responses.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/tests/common/responses.rs#L716)
  constructs `event:` / JSON `data:` frames, created events, text deltas, output
  items, completion usage, and failures. Its Wiremock helpers return these
  fixtures with `Content-Type: text/event-stream`.
- [streaming_sse.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/tests/common/streaming_sse.rs#L13)
  gates individual chunks and records incoming requests. Mainroom uses Web
  Streams and explicit close/error signals for the same control over delivery.
- [stream_no_completed.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/tests/suite/stream_no_completed.rs#L1)
  exercises streams that end without completion, including recovery.

These are synthetic fixtures modeled on official tests, not captured production
responses or an exhaustive OpenAI protocol conformance suite. In particular,
Codex's minimal `response.created` fixture omits status; Mainroom must keep
reading it and require a completed status only on the terminal completion event.

## Quota compatibility

Quota storage now uses the full provider/consumer subject pair. New public grant
IDs use `crypto.randomUUID()`; existing IDs remain stable. Today's legacy daily
reservations are carried forward on the first new admission. Legacy in-flight
counts remain separate until older requests release them. If two old IDs already
collided, their historical counts cannot be attributed reliably, so each grant
conservatively retains that shared baseline; new admissions are independent.

Stream cleanup uses `pipeTo`, `TransformStream`, and
[Cloudflare's `waitUntil`](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
to observe cancellation/errors and await lease release after disconnect. This
does not provide recovery from Worker termination or a storage outage beyond
the runtime's background-execution window. Revocation blocks new admissions;
an already-admitted stream may drain.
