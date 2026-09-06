# Implementation primitives review

Reviewed September 6, 2026 for PR #17, including Node filesystem, OS/path,
Web Streams and subprocess APIs; Bun runtime compatibility; Hono validation,
JWT, errors, streaming and proxy helpers; and the installed package sources.

| Area                       | Choice                                                                                                                                           | Reason                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Inference SSE              | [eventsource-parser](https://github.com/rexxars/eventsource-parser/tree/v4.1.0), TextDecoderStream, async stream iteration                       | Handles multiline events, CR/LF framing and split UTF-8; completion cancels the remaining stream; buffering is bounded.                  |
| Credential persistence     | [write-file-atomic](https://github.com/npm/write-file-atomic) with mode 0600                                                                     | Creates a private temporary file, fsyncs and renames it, serializes writes and cleans up failed writes.                                  |
| Home and file paths        | [node:os homedir](https://nodejs.org/api/os.html#oshomedir), node:path join                                                                      | Uses the runtime's platform-aware home-directory fallback while preserving Mainroom and Codex overrides.                                 |
| JWT metadata               | [hono/jwt decode](https://hono.dev/docs/helpers/jwt)                                                                                             | Replaces handwritten base64url and UTF-8 decoding; provider requests still determine whether credentials work.                           |
| Account API contract       | [Zod](https://zod.dev/api), z.infer, shared schemas                                                                                              | CLI responses, Worker request validation and account types use the same definitions.                                                     |
| HTTP validation and errors | [Hono middleware](https://hono.dev/docs/guides/validation), [hono-zod-openapi](https://github.com/paolostyle/hono-zod-openapi) and HTTPException | Authentication runs first; validated JSON and path parameters reach handlers through c.req.valid; errors retain the CLI's JSON contract. |

The existing oauth4webapi implementation already supplies PKCE, state checking
and OAuth exchanges. Aws4fetch, fast-xml-parser and smol-toml already handle
request signing and configuration formats. These remain appropriate primitives.

Hono's proxy helper removes connection-upgrade headers and creates a new
Response, so it cannot replace Fly forwarding without preserving Cloudflare's
WebSocket response semantics. Hono streamSSE produces events; it does not parse
upstream events. The grant-release stream also has application-specific lifecycle
responsibilities that require its own code.

Node's newer mkdtempDisposable is absent from Bun 1.3.14, so temporary login
directories retain mkdtemp plus finally/rm. The browser-opening package open
loads an auxiliary executable from disk on Linux; adopting it would require
explicit packaging work for compiled CLI releases.

The project runs on Bun, including compiled CLI binaries. The atomic-write
package's Node engine range is newer than some Node installations; its used
filesystem/crypto APIs are exercised by the Bun tests and compiled CLI smoke
check. CI uses Bun 1.3.14.

Remaining review candidates are shared validation for the older CLI-auth routes,
an OAuth callback deadline, and cancellation spanning the entire recovery command.
Those change existing lifecycle behavior and need focused tests before replacement.
