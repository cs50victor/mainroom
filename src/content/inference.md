# Inference

Your inference base URL is `https://<username>.mainroom.sh/v1`. Replace `<username>` with your Mainroom username. The root domain `https://mainroom.sh` hosts the control-plane API and documentation; it is not an inference base URL.

## Discover available models

Set `MAINROOM_USERNAME` and `MAINROOM_API_KEY` in your local environment, then request the models available to your account:

```sh
curl --fail-with-body "https://${MAINROOM_USERNAME}.mainroom.sh/v1/models" \
  -H "Authorization: Bearer ${MAINROOM_API_KEY}"
```

Choose an actual model returned by the endpoint. Model availability and supported features depend on the connected account and tokenproxy configuration.

## Send a response request

Set `MAINROOM_MODEL` to a returned model identifier. This example uses `jq` to encode the JSON body safely:

```sh
jq -n --arg model "$MAINROOM_MODEL" \
  '{model: $model, input: "Reply with hello."}' |
  curl --fail-with-body "https://${MAINROOM_USERNAME}.mainroom.sh/v1/responses" \
    -H "Authorization: Bearer ${MAINROOM_API_KEY}" \
    -H 'Content-Type: application/json' \
    --data-binary @-
```

Inference is forwarded to tokenproxy. Configure your client's base URL and authentication according to that client's supported settings; do not assume every client uses the same configuration keys.

## Shared endpoints

To use another user's endpoint, send your own Mainroom API key to that user's subdomain. The provider must grant access to your username and permit the requested model, route, service tier, and optional features. See [API and sharing](https://mainroom.sh/guides/api).

## Troubleshooting

- A failed `mainroom ping` indicates an API connection or credential problem.
- If no eligible Codex files are found, refresh the intended local Codex sign-in and run `mainroom codex sync` again.
- If sync reports an upload succeeded but reload failed, setup is incomplete; retain the error and resolve it before claiming the endpoint is ready.
- A denied shared request can reflect an inactive grant, unsupported scope, or exceeded limit.
