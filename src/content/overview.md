# Mainroom

Mainroom lets friends and research groups pool inference capacity from their subscriptions. Share the cost of access across your group, even when some members use more inference than others.

Each member has a node and one endpoint at `https://<username>.mainroom.sh/v1`. That node can route requests through their own connected accounts and the nodes shared with them. Providers choose who gets access, which models they can use, and any usage limits. Contributions and usage do not need to be equal; the group agrees how to split subscription costs.

For example, Alice and Bob connect their Codex accounts and grant each other access. Each keeps using their own endpoint, now backed by both local accounts and the friend's node. They can also share with a researcher who only consumes capacity. Subscription credentials stay with the provider's Mainroom setup.

## Set up with an agent

Give your coding agent this prompt:

```text
Set up Mainroom for me: https://mainroom.sh/SKILL.md
```

The [Mainroom setup skill](https://mainroom.sh/SKILL.md) walks an agent through installation, sign-in, contributing accounts, sharing with friends, and verifying the combined endpoint.

## Guides

- [Getting started](https://mainroom.sh/guides/getting-started): Set up a node and join your group's pool.
- [Authentication](https://mainroom.sh/guides/authentication): Understand Mainroom credentials and sign-in.
- [Inference](https://mainroom.sh/guides/inference): Use your own and shared capacity through one endpoint.
- [API and sharing](https://mainroom.sh/guides/api): Find control-plane routes and manage sharing grants.
- [Interactive API reference](https://mainroom.sh/docs): Explore the generated container API reference.

## Read with an agent

- [Documentation index](https://mainroom.sh/llms.txt)
- [Complete guides and setup skill](https://mainroom.sh/llms-full.txt)
- [OpenAPI document](https://mainroom.sh/openapi.json)
- [API catalog](https://mainroom.sh/.well-known/api-catalog)
- [Source repository](https://github.com/cs50victor/mainroom)

Guides are available as HTML and at the same URL with `.md` appended. Request `Accept: text/markdown` to read the Markdown version directly. Public documentation never requires an API key; using an inference endpoint does.
