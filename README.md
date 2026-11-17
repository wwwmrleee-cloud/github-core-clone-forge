# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wwwmrleee-cloud/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wwwmrleee-cloud/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single TypeScript file (Node 22 standard library only): git smart HTTP (protocol v0 and v2, pack generation and parsing, shallow fetch, receive-pack with fast-forward enforcement), REST v3, GraphQL and MCP over one fast in-memory store. No dependencies, no disk writes, no network. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The trial environment sets `MAKEFUN_ENV_URL` (the env registers the port there) and `MAKEFUN_SHOP_TOKEN` (the bearer token for every API call). Locally, start it with any token:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

The viewer identity is the scenario user from the published kit seed (`adaiversen`); repositories created through the API belong to that login, and the same name under any other owner answers 404.

## Layout

- `main.ts` — entrypoint and env lifecycle (unchanged from the kit starter)
- `app.ts` — the whole forge: object store, pack codec, git smart HTTP, REST v3, GraphQL executor, MCP tools

---

<sub>Entered on [make.fun](https://make.fun/?ref=wp8y7q6s&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
