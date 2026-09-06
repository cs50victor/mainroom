# API and sharing

The Mainroom control-plane origin is `https://mainroom.sh`. Send JSON bodies with `Content-Type: application/json` where applicable.

## Share with a friend

Sharing connects your group's nodes. A provider grants access to a friend's Mainroom username; the friend's node then includes the provider as a peer account. Each person can keep using one endpoint for their own and shared capacity.

Suppose Alice wants to share with Bob. Both first create Mainroom accounts, and Alice syncs the Codex accounts she wants to contribute. On Alice's machine, set `MAINROOM_API_KEY` to Alice's key, `MAINROOM_CONSUMER` to Bob's actual username, and `MAINROOM_MODEL` and `MAINROOM_SERVICE_TIER` to a model and tier supported by Alice's node.

Alice can grant access to the Responses route with this request. The example permits 100 requests per UTC day and two concurrent requests; choose limits that fit your group before running it. A PUT replaces any existing grant for this friend, including its scope and limits.

```sh
jq -n --arg model "$MAINROOM_MODEL" --arg tier "$MAINROOM_SERVICE_TIER" \
  '{models: [$model], routes: ["responses"], service_tiers: [$tier],
    limits: {requests_per_day: 100, max_concurrent_requests: 2}}' |
  curl --fail-with-body -X PUT \
    "https://mainroom.sh/v0/shares/providers/${MAINROOM_CONSUMER}" \
    -H "Authorization: Bearer ${MAINROOM_API_KEY}" \
    -H 'Content-Type: application/json' \
    --data-binary @-
```

Bob checks incoming access with his own key:

```sh
curl --fail-with-body https://mainroom.sh/v0/shares/consumers/me \
  -H "Authorization: Bearer ${MAINROOM_API_KEY}"
```

If Bob has not initialized his node, he calls `POST /v0/tokenproxy/config/reload` with his own key, as shown in [getting started](https://mainroom.sh/guides/getting-started). He then verifies a request through his endpoint using the [inference guide](https://mainroom.sh/guides/inference). He can verify Alice's grant specifically by calling Alice's endpoint with his own key and the permitted model, route, and tier.

For mutual sharing, Bob repeats the provider step with his key and Alice's username. For a larger group, each provider grants access to the members they choose. Members may contribute and consume different amounts, including using shared capacity without contributing an account. Subscription credentials stay with each provider's setup; the group agrees how to split subscription costs.

## API reference coverage

The [OpenAPI document](https://mainroom.sh/openapi.json) and [interactive reference](https://mainroom.sh/docs) are generated from the container API routes: health, ping, API key management, JSON uploads, and tokenproxy auth JSON refresh. The Worker routes below are documented here separately.

## Authentication and configuration routes

| Method | Path                                | Authentication     | Purpose                                                                       |
| ------ | ----------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| GET    | /v0/auth/cli/config                 | Public             | Return the configured OAuth authorize URL, client ID, and token URL.          |
| POST   | /v0/auth/cli/exchange               | Clerk OAuth bearer | Create a Mainroom CLI key; accepts an optional username.                      |
| GET    | /v0/tokenproxy/config/me            | Mainroom API key   | Read your private tokenproxy configuration as TOML.                           |
| GET    | /v0/tokenproxy/accounts             | Mainroom API key   | Check stored Codex accounts without requiring a running node.                 |
| PATCH  | /v0/tokenproxy/accounts/:uploadName | Mainroom API key   | Set an account's enabled state with a JSON boolean; disabling stops its node. |
| POST   | /v0/tokenproxy/config/reload        | Mainroom API key   | Reconcile your machine with current account configuration.                    |

Configuration responses may contain credentials. Treat them as private.

## JSON uploads

`POST /v0/uploads/json` accepts a Mainroom API key and either a raw `application/json` body or a multipart upload with a `file` field. The JSON file must be no larger than 1 MiB.

The optional `X-Mainroom-Upload-Name` header chooses the stored filename. Names must end in `.json`, contain only letters, digits, `.`, `_`, `@`, `+`, or `-`, and have at most 160 characters before `.json`. Without the header, a UUID filename is generated.

For Codex accounts, prefer `mainroom codex sync`, which selects eligible files, names the uploads, and requests a configuration reload.

## Sharing routes

All these routes require your Mainroom API key:

| Method | Path                                    | Purpose                                     |
| ------ | --------------------------------------- | ------------------------------------------- |
| GET    | /v0/shares/providers                    | List grants you provide.                    |
| GET    | /v0/shares/consumers/me                 | List access shared with you.                |
| PUT    | /v0/shares/providers/{consumerUsername} | Create or replace a grant for a consumer.   |
| PATCH  | /v0/shares/providers/{consumerUsername} | Set a grant's status to active or disabled. |
| DELETE | /v0/shares/providers/{consumerUsername} | Revoke a grant.                             |

The PUT body requires nonempty `models`, `routes`, and `service_tiers` arrays. Allowed route names are `chat_completions`, `responses`, and `messages`. Choose models and service tiers supported by your connected accounts.

Optional fields are `supports_responses_ws`, `supports_compact`, and `limits`. Limits can contain positive integers for `requests_per_day`, `tokens_per_day`, and `max_concurrent_requests`.

Daily limits use UTC days. The token limit counts the requested maximum tokens, not measured billing usage. Request fields use snake_case; returned grant records use camelCase. Updating a grant also reconciles the consumer's existing node.

A PATCH request uses the body `{"status":"active"}` or `{"status":"disabled"}`. A consumer calls the provider's inference subdomain with the consumer's own key.
