# Authentication

Public guides, the setup skill, and the OpenAPI document are readable without signing in. API credentials are required for account operations and inference.

## Mainroom API keys

Send a Mainroom API key in the `Authorization: Bearer <key>` header. The CLI stores its credential in `~/.config/mainroom/credentials.json`, or in the directory selected by `MAINROOM_CONFIG_DIR`. The file contains the API origin and token and is written with owner-only permissions.

Keep credentials out of prompts, logs, source control, and public documentation. An inference client needs the Mainroom key, not the contents of a Codex authentication file.

## Browser sign-in

`mainroom auth signup` and `mainroom auth login` use the configured Clerk OAuth flow. The CLI reads public OAuth configuration from `GET /v0/auth/cli/config`, then exchanges the Clerk OAuth access token at `POST /v0/auth/cli/exchange` for a Mainroom API key.

The exchange endpoint accepts a Clerk OAuth bearer token. It is not an endpoint for exchanging an existing Mainroom API key.

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

## Other authentication boundaries

Sharing and tokenproxy configuration operations require a Mainroom API key. Machine administration requires a separate administrator credential. Internal configuration and authentication-file download URLs use expiring signatures. Neither administrator credentials nor signed private URLs belong in public documentation exports.
