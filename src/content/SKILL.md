---
name: mainroom
description: Set up Mainroom to pool subscription inference capacity with friends or a research group. Install the CLI, connect selected Codex accounts, configure peer sharing, and verify one endpoint for local and shared capacity.
---

# Set up Mainroom

Mainroom lets friends and research groups pool subscription inference capacity and share costs. Each person uses one endpoint at `https://<username>.mainroom.sh/v1`, backed by their own accounts and nodes shared with them. Members can contribute and consume different amounts; the group agrees how to split subscription costs. The public control-plane origin is `https://mainroom.sh`.

## Establish the setup

Determine whether the user wants to contribute accounts, use friends' capacity, or do both. Use group details already provided; ask for missing Mainroom usernames and sharing preferences when needed. Continue installation and sign-in while group details are pending. Each member owns their account and key. Configure only the accounts and sharing grants the user has authorized.

## Install

1. Check whether `mainroom` is already installed and inspect `mainroom --version` and `mainroom --help`.
2. If installation is needed, identify the operating system and CPU architecture. Use the [official releases](https://github.com/cs50victor/mainroom/releases/latest), selecting the matching macOS or Linux archive for `amd64` or `arm64`. Verify it against the release's `checksums.txt`, extract `mainroom`, and install it in an appropriate directory on the user's PATH.
3. If building from source is appropriate, follow the [getting started guide](https://mainroom.sh/guides/getting-started.md). The repository uses Bun and is not a published npm package.

## Sign in and contribute accounts

1. Run `mainroom auth status`. For new users run `mainroom auth signup`; for existing users without a valid local credential run `mainroom auth login`. Let the user complete browser sign-in and any username prompts.
2. Run `mainroom ping` to verify the saved credential and API connection.
3. If contributing, run `mainroom codex sync` so the user can select which local Codex authentication files to upload. Use `--yes` only if the user has authorized uploading every eligible account. The files contain account credentials; do not print them, copy them into the conversation, or send them to friends.
4. Check that sync and configuration reload both succeed. If the user intends to contribute but no eligible files exist, have them refresh the intended Codex sign-in before retrying. Users who only consume shared capacity can skip sync. Report unresolved authentication or reload failures before claiming setup is complete.

## Connect friends' nodes

1. Read the [API and sharing guide](https://mainroom.sh/guides/api.md). Use the sharing API; do not invent a CLI sharing command. List existing outgoing grants with `GET /v0/shares/providers` and incoming grants with `GET /v0/shares/consumers/me`, using the user's Mainroom key.
2. To contribute to a friend, use `PUT /v0/shares/providers/{consumerUsername}` with the provider's key. Supply supported `models`, `routes`, and `service_tiers`, plus the authorized optional features and limits. A PUT replaces the existing grant, so preserve authorized access that should remain. Do not silently choose unlimited access or treat guide examples as the user's preferred limits.
3. Explain that grants are directional. Mutual sharing requires a grant from each provider to the other member. A friend creates their own outgoing grant with their own key. Never ask the user to collect friends' keys or subscription credentials. Configure each authorized direction for the group; equal contributions are not required.
4. Verify incoming grants and their permitted scope. Mainroom includes active grants in the consumer's node configuration. If the user skipped sync, call `POST /v0/tokenproxy/config/reload` with their own key to initialize their node after receiving access. Grant changes reconcile an existing consumer node; retry reload if an update failed.
5. Verify a permitted inference request directly against a newly shared provider's endpoint using the consumer's own key, then verify the consumer's combined endpoint. A successful request through an endpoint with local accounts alone does not prove a peer grant works. If another member has not yet granted access, report that specific pending step.

## Configure and verify the client

- Use the user's actual username in the base URL, not the root domain or an invented example username.
- Use a Mainroom API key as the bearer credential. The CLI saves its key in `~/.config/mainroom/credentials.json`, or the directory selected by `MAINROOM_CONFIG_DIR`. Read credentials only when needed for the authorized configuration, and never log or commit them.
- Fetch `GET https://<username>.mainroom.sh/v1/models` with the key and select a returned model. Follow the [inference guide](https://mainroom.sh/guides/inference.md) for request examples.
- Inspect the target client's supported configuration before editing it. Preserve unrelated settings and use its supported secret storage or environment variables.
- Verify a minimal inference request through the intended endpoint and report the base URL, chosen model, and actual result without exposing the key. A successful ping alone does not verify inference.

## Further reference

- [Authentication](https://mainroom.sh/guides/authentication.md)
- [API and sharing](https://mainroom.sh/guides/api.md)
- [OpenAPI](https://mainroom.sh/openapi.json)
- [Documentation index](https://mainroom.sh/llms.txt)
