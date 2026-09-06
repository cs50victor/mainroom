# Getting started

Set up Mainroom with friends or a research group to share subscription capacity. Each member signs in separately and uses one endpoint at `https://<username>.mainroom.sh/v1`, backed by their own accounts and nodes shared with them.

You can contribute a Codex account, use capacity shared by a friend, or do both. Contributing requires an eligible, unexpired Codex authentication file. Members decide who shares with whom and how they split costs.

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

## Contribute your Codex account

Follow this step on each contributing member's machine. If you only use capacity shared by friends, continue to the next step.

```sh
mainroom codex sync
```

The CLI finds eligible local Codex authentication files and asks which ones to upload. These files contain account credentials. Choose the accounts you want Mainroom to use. Sync uploads the selected files and requests a tokenproxy configuration reload.

Use `mainroom codex sync --yes` only when you intend to upload every eligible account without the selection prompt.

## Connect your group's nodes

Exchange Mainroom usernames with your group. Run `mainroom friends invite <username>` to choose models and a daily request limit, then `mainroom friends` to see your friends, sharing status, and recorded usage in both directions. Follow the [sharing walkthrough](https://mainroom.sh/guides/api) for all commands and API options.

Grants are directional: Alice granting Bob access lets Bob use Alice's node. Bob grants Alice access separately to share both ways. Repeat for the members each provider wants to include. Each member keeps their own API key; friends do not exchange subscription credentials.

Mainroom includes active incoming grants in your node's configuration. If you skipped account sync, initialize your node after a friend grants access:

```sh
mainroom friends connect
```

Grant changes reconcile an existing consumer node automatically. This reload also lets you retry a failed configuration update.

## Connect your client

Use `https://<username>.mainroom.sh/v1` as your inference base URL and your Mainroom API key as the bearer credential. Keep that URL as your group adds or removes shared nodes. Follow the [inference guide](https://mainroom.sh/guides/inference) to discover models and verify a request.
