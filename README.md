# Core Forge

[![make.fun competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/competitions/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/hukailiang396-commits/core-forge/rank.svg)](https://make.fun/competitions/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/hukailiang396-commits/core-forge/reward.svg)](https://make.fun/competitions/github-core-clone-01)

A fast, GitHub-compatible git forge written in TypeScript (Node 22 stdlib only, no dependencies), built for the [make.fun](https://make.fun) bounty `github-core-clone-01`.

Local conformance (kit runner, practice trial-0): **120/120 checks — feature 600/600, agent-native 200/200, performance 167/200, total 967/1000.**

## What it serves

One in-memory store, four surfaces, one source of truth:

- **REST v3** (`/api/v3`) — repos, branches, commits, contents, labels, issues, comments, pull requests (squash merge with conflict detection), pagination with absolute `Link` headers.
- **Git smart HTTP** (`/{owner}/{repo}.git`) — upload-pack protocol v2 (ls-refs, fetch with shallow/deepen, multi-round negotiation) and v0, receive-pack v0 with `report-status` / `side-band-64k` / `delete-refs`. Full pack codec: plain objects, OFS/REF delta resolution for thin packs, SHA-1 object model, fast-forward enforcement per ref.
- **GraphQL** (`/api/graphql`) — hand-written parser and executor, introspection for `Issue` / `PullRequest` / `Repository` / `SearchType`, cursor pagination, mutations for issues, pull requests and comments, batched operations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP, protocol revision 2026-07-28 via `server/discover` plus the legacy `initialize` handshake, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Speed

The reference forge is beaten on performance, not on features: the four timed workloads run at roughly 2.5x (push), 2.8x (clone), 4.8x (read) and 1.4x (write) the reference medians. The design is in-memory only (no disk I/O per request), O(1) issue lookups, depth-1 packs that never walk full history, and keep-alive with `setNoDelay`.

## Determinism

No wall clock, no unseeded randomness anywhere that reaches state or a compared response: fixed epoch timestamps, sequential IDs, sequential request IDs. Every contender trial is replayed and the replay must leave the same state export byte for byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0. With no env URL it serves forever (local dev). `GET /healthz` answers `{"ok": true}`. Set `MAKEFUN_SHOP_TOKEN` to require the bearer token on every surface except `/healthz`.

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server, auth, routing.
- `rest.ts` — REST v3 handlers and shared domain operations.
- `git.ts` — git smart HTTP (upload-pack v2/v0, receive-pack v0).
- `graphql.ts` — GraphQL parser, executor, introspection.
- `mcp.ts` — MCP JSON-RPC server.
- `store.ts` — in-memory store, git object model, pack codec, pkt-lines.
