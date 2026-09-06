# Inference

Your inference base URL is `https://<username>.mainroom.sh/v1`. Replace `<username>` with your Mainroom username. The root domain `https://mainroom.sh` hosts the control-plane API and documentation; it is not an inference base URL.

This is your single entry point to the pool: your node's configuration combines your own connected accounts with active grants from friends. Your client can keep the same URL as providers join or leave. Each provider controls the access and limits on their node.

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

## Using your group's capacity

When a friend grants you access, Mainroom adds their node as a peer account in your configuration. Your node can select that peer when routing eligible requests. You continue using your own endpoint and API key. See [getting started](https://mainroom.sh/guides/getting-started) if you need to initialize a node without contributing an account.

You can also call a provider's endpoint directly with your own Mainroom API key, for example to verify a new grant. The provider must grant access to your username and permit the requested model, route, service tier, and optional features. See [API and sharing](https://mainroom.sh/guides/api).

## Troubleshooting

- A failed `mainroom ping` indicates an API connection or credential problem.
- If no eligible Codex files are found, refresh the intended local Codex sign-in and run `mainroom codex sync` again.
- If sync reports an upload succeeded but reload failed, setup is incomplete; retain the error and resolve it before claiming the endpoint is ready.
- A denied shared request can reflect an inactive grant, unsupported scope, or exceeded limit.
