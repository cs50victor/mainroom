# Authentication

Public guides, the setup skill, and the OpenAPI document are readable without signing in. API credentials are required for account operations and inference.

## Mainroom API keys

Send a Mainroom API key in the `Authorization: Bearer <key>` header. The CLI stores its credential in `~/.config/mainroom/credentials.json`, or in the directory selected by `MAINROOM_CONFIG_DIR`. The file contains the API origin and token and is written with owner-only permissions.

Keep credentials out of prompts, logs, source control, and public documentation. An inference client needs the Mainroom key, not the contents of a Codex authentication file.

## Browser sign-in

`mainroom auth signup` and `mainroom auth login` use the configured Clerk OAuth flow. The CLI reads public OAuth configuration from `GET /v0/auth/cli/config`, then exchanges the Clerk OAuth access token at `POST /v0/auth/cli/exchange` for a Mainroom API key.

The exchange endpoint accepts a Clerk OAuth bearer token. It is not an endpoint for exchanging an existing Mainroom API key.

Clerk collects your username during signup. Friends use that username to grant
access; they never need your Mainroom key or Codex credentials.

## Existing credentials

To use an existing Mainroom API key, pass it through standard input:

```sh
mainroom auth login --with-token < mainroom-api-key.txt
```

## Verify and sign out

```sh
mainroom auth status
mainroom ping
mainroom auth logout
```

Logout removes the saved credential on this device. It does not revoke the API key on the server. API key management operations are described in the [interactive API reference](https://mainroom.sh/docs).

## Recover a Codex account

Mainroom login authenticates you to Mainroom. Codex reauth refreshes the separate
credential used by your remote tokenproxy to reach Codex:

```sh
mainroom codex status
mainroom codex reauth --account <filename.json>
```

Choose the stored filename reported by status and sign into that same Codex
account. Reauth requires the official Codex CLI and uses a temporary private
login directory, preserving your usual local login. It checks the account
identity, uploads the replacement credential, enables the account, reloads the
node, and verifies inference. Add `--device-auth` for device-code sign-in.

If an account cannot be recovered, `mainroom codex disable <filename.json>`
keeps its credential but excludes it from configuration. Disabling stops the
node to unload the credential, interrupting requests, then attempts recovery
with remaining accounts. Another unhealthy account can still block recovery.
After disabling the last Codex account, use `mainroom friends connect` to use
incoming shares. See the [CLI reference](https://mainroom.sh/guides/cli) for exit
behavior and the [inference guide](https://mainroom.sh/guides/inference) to verify access.

## Other authentication boundaries

Sharing and tokenproxy configuration operations require a Mainroom API key. Machine administration requires a separate administrator credential. Internal configuration and authentication-file download URLs use expiring signatures. Neither administrator credentials nor signed private URLs belong in public documentation exports.
