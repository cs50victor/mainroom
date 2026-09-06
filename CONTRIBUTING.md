# Contributing to Mainroom

Keep each PR focused on a concrete problem. Read the relevant code and the
[architecture in README](README#architecture) before changing it. Search existing
issues and PRs; discuss substantial new behavior before building it.

## Reuse before writing

Every PR should reuse as much suitable existing code as possible: repository
helpers and schemas, standard libraries, and package APIs and primitives.
Inspect their source, types, and documentation before implementing a substitute.

Useful dependencies are welcome. Package count is not a goal; less custom code
and correct behavior are. Explain why custom logic is needed when an existing
primitive looks suitable. Check compatibility with the runtime being changed:
Bun and compiled CLI binaries, Cloudflare Workers, or both. Share validation
schemas and types instead of maintaining parallel definitions.

## Keep tests meaningful

Include only critical, meaningful tests that catch a concrete failure in
Mainroom. Favor authorization and account isolation, credential privacy,
machine lifecycle, request routing, and completed inference. For regression
tests, confirm they fail without the fix and pass with it.

- Test observable behavior and boundaries using the existing related suite.
- Skip tests that repeat implementation logic, freeze incidental wording or
  markup, merely assert mock responses, or retest unmodified library behavior.
- Keep integration tests that prove Mainroom uses a library correctly, such as
  cancelling an inference stream or writing credentials with private permissions.
- Use synthetic credentials, temporary files, and local servers; clean up state.
- Remove redundant tests and explain which remaining check covers the behavior.
  A test that catches a real bug should be fixed, not deleted to make CI pass.

Documentation and cosmetic changes usually need inspection, not new tests.
AI-assisted contributions follow the same standard: the author must understand,
review, and verify every change. Test count and coverage percentage do not prove
that a change works.

## Work locally

Use Bun 1.3.14, matching CI. The tests also use Bash and curl on macOS or Linux;
Docker is needed for the container checks. Local tests use fixtures and do not
require production credentials or an installed tokenproxy CLI.

```sh
bun install --frozen-lockfile
bun run build:css
bun test
AUTH_MODE=mock NODE_ENV=development bun run dev
```

The dev server runs at localhost:3000 unless PORT is set. It watches the Bun/Hono
API and CSS, not the full Worker/Fly deployment. For service integration work,
copy .env.example to .env and configure development services; keep secrets out
of commits and logs. Worker bindings and production requirements are in
wrangler.jsonc. Run the modified CLI with `bun run cli --help`.

Edit public documentation in src/content and UI components in src/site.
src/generated/site.css is rebuilt and stays out of Git. Keep CLI examples and
API documentation aligned with their implementations.

## Verify and open a PR

Run related tests while iterating, for example `bun test cli/inference.test.ts`.
Before requesting review, run the checks in [.github/workflows/ci.yml](.github/workflows/ci.yml):

```sh
bun run build:css
bun run typecheck
bun run lint
bun test
```

CI also builds and smoke-tests both Docker images. For CLI dependency or
packaging changes, build the affected target and exercise the binary outside
the checkout. Inspect rendered pages for visual changes. Report checks that
could not run and their limits.

Open a branch and PR against main with a title such as `fix: preserve account
identity during reauth`. Use the PR template to explain the problem, reused
primitives, and validation. Include a minimal reproduction for bugs. Review
the entire diff and remove unrelated changes before submitting. Maintainers
squash-merge after review and passing CI; successful main CI triggers deployment.

Guide structure informed by [Zig](https://codeberg.org/ziglang/zig/src/commit/e39a2afa24a8f3db4d40b40703254011acc97efa/README.md#contributing),
[Ghostty](https://github.com/ghostty-org/ghostty/blob/492300cad104195411d12217dd22f1cd05f31376/CONTRIBUTING.md),
[Vercel](https://github.com/vercel/vercel/blob/e06cc643cec6a47bd9344af7f4589c736d95ed15/README.md#contributing),
[Next.js](https://github.com/vercel/next.js/blob/4fed8eaf197aaa60fd85371352482199a4c2107f/contributing/core/testing.md),
[Node.js](https://github.com/nodejs/node/blob/5552a068ca6a0e535968b8faa86cae49a417492a/doc/contributing/pull-requests.md),
[Bun](https://github.com/oven-sh/bun/blob/988ce730e56dc96a221d1228d8499128e16634b8/CONTRIBUTING.md),
and [Hono](https://github.com/honojs/hono/blob/eebdf7be39abf0a872671835ccce0c4f03ea497a/docs/CONTRIBUTING.md).
