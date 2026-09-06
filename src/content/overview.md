# Mainroom

## Your AI subscriptions. Better together.

Bring your subscriptions together with friends. Share the cost, and access your own accounts and theirs through one endpoint.

## Different workloads. Shared capacity.

Some days you need more. Other days, your friends do. Mainroom connects your subscriptions so your group can make more of the capacity you already pay for.

Each member has a node and one endpoint at `https://<username>.mainroom.sh/v1`. That node can route requests through their own connected accounts and the nodes shared with them. Friends and research groups can contribute and use different amounts of capacity, and agree how to split subscription costs.

For example, Alice and Bob connect their Codex accounts and grant each other access. Each keeps using their own endpoint, now backed by both local accounts and the friend's node. They can also share with a researcher who only consumes capacity. Subscription credentials stay with the provider's Mainroom setup.

## You choose what to share.

Choose who can use your node, which models they can access, and the limits that work for you.

## Set up with your agent

Paste this into your coding agent to get started:

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
