# API and sharing

The Mainroom control-plane origin is `https://mainroom.sh`. Send JSON bodies with `Content-Type: application/json` where applicable.

## API reference coverage

The [OpenAPI document](https://mainroom.sh/openapi.json) and [interactive reference](https://mainroom.sh/docs) are generated from the container API routes: health, ping, API key management, JSON uploads, and tokenproxy auth JSON refresh. The Worker routes below are documented here separately.

## Authentication and configuration routes

| Method | Path                         | Authentication     | Purpose                                                              |
| ------ | ---------------------------- | ------------------ | -------------------------------------------------------------------- |
| GET    | /v0/auth/cli/config          | Public             | Return the configured OAuth authorize URL, client ID, and token URL. |
| POST   | /v0/auth/cli/exchange        | Clerk OAuth bearer | Create a Mainroom CLI key; accepts an optional username.             |
| GET    | /v0/tokenproxy/config/me     | Mainroom API key   | Read your private tokenproxy configuration as TOML.                  |
| POST   | /v0/tokenproxy/config/reload | Mainroom API key   | Reconcile your machine with current account configuration.           |

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

Daily limits use UTC days. The token limit counts the requested maximum tokens, not measured billing usage. Request fields use snake_case; returned grant records use camelCase. Updating a grant also reconciles the affected machines.

A PATCH request uses the body `{"status":"active"}` or `{"status":"disabled"}`. A consumer calls the provider's inference subdomain with the consumer's own key.
