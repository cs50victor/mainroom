# Getting started

Mainroom runs a personal inference endpoint at `https://<username>.mainroom.sh/v1`. You need a Mainroom account and an eligible, unexpired Codex authentication file to follow this setup.

## Install the CLI

Download the archive for your operating system and architecture from the [official Mainroom releases](https://github.com/cs50victor/mainroom/releases/latest). Releases include macOS and Linux builds for Intel/AMD (`amd64`) and ARM (`arm64`), plus `checksums.txt`.

Verify the archive against the published checksum, extract the `mainroom` executable, and put it in a directory on your PATH. The standalone executable does not require Bun.

```sh
mainroom --version
mainroom --help
```

To run from source instead, use a dedicated checkout with Bun installed:

```sh
git clone https://github.com/cs50victor/mainroom.git
cd mainroom
bun install --frozen-lockfile
bun run cli --help
```

When running from source, replace `mainroom` in the following commands with `bun run cli`.

## Sign in

For a new account:

```sh
mainroom auth signup
```

For an existing account:

```sh
mainroom auth login
```

Finish the browser sign-in and username prompts. Then verify the saved credential and API connection:

```sh
mainroom auth status
mainroom ping
```

## Connect your Codex account

```sh
mainroom codex sync
```

The CLI finds eligible local Codex authentication files and asks which ones to upload. These files contain account credentials. Choose the accounts you want Mainroom to use. Sync uploads the selected files and requests a tokenproxy configuration reload.

Use `mainroom codex sync --yes` only when you intend to upload every eligible account without the selection prompt.

## Connect your client

Use `https://<username>.mainroom.sh/v1` as your inference base URL and your Mainroom API key as the bearer credential. Follow the [inference guide](https://mainroom.sh/guides/inference) to discover models and verify a request.
