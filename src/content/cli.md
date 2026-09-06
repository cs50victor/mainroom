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

Invite prompts for models from ready Codex accounts, a daily request limit, and
confirmation. It permits Responses requests with the `auto` service tier by
default. For scripts, supply the scope and confirmation explicitly:

```sh
mainroom friends invite bob --models <model-id> --requests-per-day 100 --yes
```

`--models <models...>` and `--service-tiers <tiers...>` accept multiple values.
`--requests-per-day <count>` must be a positive whole number. Enable, disable,
and revoke accept `--yes`; without a terminal, all grant changes require it.
For additional routes, token limits, or concurrency limits, use the
[sharing API](https://mainroom.sh/guides/api).

Invites grant access without email or acceptance. Sharing is directional;
your friend creates a separate grant to share back. Only shares involving you
are visible, including disabled and revoked history. Daily counters record
admitted requests and reserved output maxima, not actual token consumption or
remaining subscription balances. Each direction has separate counters.

Grant changes may interrupt requests while the friend's node updates. If a
change is saved but the node update fails, the CLI exits with an error and the
friend can retry `mainroom friends connect`. That command updates configuration;
follow the [inference guide](https://mainroom.sh/guides/inference) to verify a request.
