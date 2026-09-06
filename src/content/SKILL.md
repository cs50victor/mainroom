---
name: mainroom
description: Install and configure Mainroom, sign in, sync selected Codex accounts, and verify a personal inference endpoint when a user asks to set up Mainroom.
---

# Set up Mainroom

Mainroom provides a personal inference endpoint at `https://<username>.mainroom.sh/v1`. The public control-plane origin is `https://mainroom.sh`.

## Install

1. Check whether `mainroom` is already installed and inspect `mainroom --version` and `mainroom --help`.
2. If installation is needed, identify the operating system and CPU architecture. Use the [official releases](https://github.com/cs50victor/mainroom/releases/latest), selecting the matching macOS or Linux archive for `amd64` or `arm64`. Verify it against the release's `checksums.txt`, extract `mainroom`, and install it in an appropriate directory on the user's PATH.
3. If building from source is appropriate, follow the [getting started guide](https://mainroom.sh/guides/getting-started.md). The repository uses Bun and is not a published npm package.

## Sign in and connect an account

1. Run `mainroom auth status`. For new users run `mainroom auth signup`; for existing users without a valid local credential run `mainroom auth login`. Let the user complete browser sign-in and any username prompts.
2. Run `mainroom ping` to verify the saved credential and API connection.
3. Run `mainroom codex sync` so the user can select which local Codex authentication files to upload. Use `--yes` only if the user has authorized uploading every eligible account. The files contain account credentials; do not print them or copy their contents into the conversation.
4. Check that sync and configuration reload both succeed. If no eligible files exist, have the user refresh the intended Codex sign-in before retrying. Stop on unresolved authentication or reload errors and report the actual failure.

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
