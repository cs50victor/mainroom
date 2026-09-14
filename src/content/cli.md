# CLI reference

Run `mainroom --help` or append `--help` to any command for its options.
`friends` and `share` are interchangeable. Commands use the API origin and key
saved at sign-in; `MAINROOM_CONFIG_DIR` selects another credentials directory.
See [getting started](https://mainroom.sh/guides/getting-started) to install or
update the standalone CLI.

## Sign-in and connection

| Command                | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `mainroom auth signup` | Open Clerk signup and save a Mainroom API key.               |
| `mainroom auth login`  | Sign in to an existing account on this device.               |
| `mainroom auth status` | Check the saved Mainroom credential.                         |
| `mainroom auth logout` | Remove the local credential without revoking its server key. |
| `mainroom ping`        | Check the authenticated control-plane connection.            |

Signup and login accept `--api-url <url>`; the default is `https://mainroom.sh`.
Login also accepts `--with-token` to read an existing Mainroom API key from
standard input. Clerk collects the username during signup. Mainroom sign-in
and Codex sign-in are separate; see [authentication](https://mainroom.sh/guides/authentication).

## Codex accounts

| Command                             | Purpose                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mainroom codex sync`               | Select unexpired local Codex auth files, upload them, and attempt recovery and inference verification. |
| `mainroom codex status`             | Check stored accounts even when tokenproxy cannot start.                                               |
| `mainroom codex reauth`             | Sign in to Codex, replace the selected remote credential, and verify inference.                        |
| `mainroom codex disable <filename>` | Keep the credential but exclude the account and attempt recovery with remaining accounts.              |

Sync accepts `--yes` to upload every eligible file without selection. Disable
accepts `--yes` to confirm the named account without a prompt. Reauth accepts
`--account <filename>` from the status output and `--device-auth` for device-code
sign-in. It requires the official Codex CLI; Mainroom runs it with a temporary
private login directory, leaving your usual local login intact. No local
tokenproxy CLI is required.

Status succeeds only when at least one enabled Codex account exists and all
enabled accounts are ready. It does not test a peer-only endpoint. Recovery
can save a change and still exit unsuccessfully if another account is unhealthy,
reload fails, or inference fails. After disabling the last Codex account, use
`mainroom friends connect` if you have shared capacity, then verify inference.

## Friends and usage

| Command                               | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `mainroom friends`                    | List friends, sharing status in both directions, and usage for each share.       |
| `mainroom friends list`               | Show the same list; add `--json` for incoming and outgoing arrays.               |
| `mainroom friends invite <username>`  | Grant an existing user access immediately, replacing any previous grant.         |
| `mainroom friends connect`            | Refresh your endpoint's peer configuration, including removal of revoked shares. |
| `mainroom friends enable <username>`  | Resume a disabled outgoing grant.                                                |
| `mainroom friends disable <username>` | Pause an outgoing grant.                                                         |
| `mainroom friends revoke <username>`  | Revoke an active or disabled outgoing grant.                                     |

Invite prompts for models from ready Codex accounts, unlimited access or a daily
request limit, and confirmation. Responses and the `auto` service tier are the
default scope. For scripts, select models, limits, and confirmation explicitly:

```sh
mainroom friends invite bob --models <model-id> --requests-per-day 100 --yes
mainroom friends invite beehuman --full-access --yes
mainroom friends invite bob --models <model-id> --unlimited --yes
```

`--full-access` grants every model currently reported by ready Codex accounts,
all routes and service tiers (`auto`, `default`, `priority`, `flex`, `fast`),
Responses WebSocket and compact access, without Mainroom limits. It cannot be
combined with other scope or limit options. Upstream account limits still apply.

Use `--all-models` to select the same model inventory with custom permissions or
limits. This saves concrete model IDs from ready Codex accounts, not a wildcard;
rerun the invite to include newly available models. `--models <models...>` accepts
explicit supported IDs from any configured provider. Provider availability still
determines which requests succeed.

| Invite option                       | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `--routes <routes...>`              | Allow `responses`, `chat_completions`, or `messages`.     |
| `--service-tiers <tiers...>`        | Select allowed service tiers.                             |
| `--supports-responses-ws`           | Allow Responses WebSocket requests.                       |
| `--supports-compact`                | Allow compact Responses requests.                         |
| `--requests-per-day <count>`        | Cap admitted requests per UTC day.                        |
| `--tokens-per-day <count>`          | Cap reserved output tokens per UTC day.                   |
| `--max-concurrent-requests <count>` | Cap simultaneous requests.                                |
| `--unlimited`                       | Remove all Mainroom request, token, and concurrency caps. |

Limits must be positive whole numbers. Omitted limits are unlimited when another
limit is supplied; `--unlimited` cannot be combined with any cap. Mainroom does
not enforce dollar or credit caps or convert subscriptions into a token allowance.
Enable, disable, and revoke also accept `--yes`; without a terminal, all grant
changes require it.

Invites grant access without email or acceptance. Sharing is directional;
your friend creates a separate grant to share back. Only shares involving you
are visible, including disabled and revoked history. Daily counters record
admitted requests and reserved output maxima, not actual token consumption or
remaining subscription balances. Each direction has separate counters.

Grant changes may interrupt requests while the friend's node updates. If a
change is saved but the node update fails, the CLI exits with an error and the
friend can retry `mainroom friends connect`. That command updates configuration;
follow the [inference guide](https://mainroom.sh/guides/inference) to verify a request.
