# Mainroom

Mainroom gives you a personal inference endpoint backed by your connected accounts. Sign in with the CLI, sync your Codex authentication files, and connect your client to `https://<username>.mainroom.sh/v1`.

## Set up with an agent

Give your coding agent this prompt:

```text
Set up Mainroom for me: https://mainroom.sh/SKILL.md
```

The [Mainroom setup skill](https://mainroom.sh/SKILL.md) walks an agent through installation, sign-in, account sync, and verification.

## Guides

- [Getting started](https://mainroom.sh/guides/getting-started): Install the CLI and connect an account.
- [Authentication](https://mainroom.sh/guides/authentication): Understand Mainroom credentials and sign-in.
- [Inference](https://mainroom.sh/guides/inference): Connect a client to your personal endpoint.
- [API and sharing](https://mainroom.sh/guides/api): Find control-plane routes and manage sharing grants.
- [Interactive API reference](https://mainroom.sh/docs): Explore the generated container API reference.

## Read with an agent

- [Documentation index](https://mainroom.sh/llms.txt)
- [Complete guides and setup skill](https://mainroom.sh/llms-full.txt)
- [OpenAPI document](https://mainroom.sh/openapi.json)
- [API catalog](https://mainroom.sh/.well-known/api-catalog)
- [Source repository](https://github.com/cs50victor/mainroom)

Guides are available as HTML and at the same URL with `.md` appended. Request `Accept: text/markdown` to read the Markdown version directly. Public documentation never requires an API key; using an inference endpoint does.
