# Testing friends and shared usage

Run `bun test src/worker-sharing.test.ts cli/shares.test.ts` after installing
dependencies and building CSS. These tests use local fixtures and make no live
Clerk or OpenAI requests.

Mainroom's permissive `AUTH_MODE=mock` maps several authentication paths to one
user. It cannot establish isolation between friends. The sharing fixture runs
with `AUTH_MODE=clerk` and the real installed Clerk backend SDK, using MSW to
intercept its HTTP requests. Unexpected requests fail instead of reaching the
network. Each test owns its users, API keys, storage, temporary CLI credentials,
and per-user machine doubles, and cleans them up afterward.

Alice, Bob, and Carol have distinct Clerk IDs, usernames, OAuth tokens, Mainroom
API keys, and synthetic Codex Pro credentials. This models the requested
$200/month subscription scenario; it does not derive a token allowance from
price or verify paid entitlements. Clerk identity and Codex identity stay separate.
The tests cover OAuth exchange, private account discovery, directional and mutual
sharing, independent usage, unauthorized access, request caps, and revocation.
They run actual CLI processes and Worker/ShareGrantStore handlers; Fly Machines
and inference responses are simulated. They do not verify browser signup or live
provider inference.

## Clerk research

- [Clerk backend tests](https://github.com/clerk/javascript/blob/bc3c89e023c42a5fd231b81b99ac68540193801b/packages/backend/src/mock-server.ts)
  use MSW, and their [API-key tests](https://github.com/clerk/javascript/blob/bc3c89e023c42a5fd231b81b99ac68540193801b/packages/backend/src/api/__tests__/APIKeysApi.test.ts)
  exercise the SDK against mocked HTTP responses. Mainroom follows this boundary.
- Clerk's `@clerk/msw` example package is private to its monorepo; Mainroom uses
  the public MSW package as a development dependency.
- [Testing Tokens](https://clerk.com/docs/guides/development/testing/overview#testing-tokens)
  bypass bot detection; they are not authentication credentials.
- For live browser tests, [Clerk's Playwright helpers](https://clerk.com/docs/guides/development/testing/playwright/test-authenticated-flows)
  authenticate test users. Use a development instance, separate browser contexts
  for each user, and [test email addresses](https://clerk.com/docs/guides/development/testing/test-emails-and-phones)
  containing `+clerk_test` for code-based verification with `424242`.

The CLI uses Clerk OAuth tokens to obtain Mainroom API keys. A session token
cannot substitute for either token type in these tests.
