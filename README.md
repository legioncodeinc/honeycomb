<p align="center">
  <img src="assets/logos/honeycomb-memory-cluster-wordmark.svg" alt="Honeycomb" height="72">
</p>

<p align="center">
  <a href="https://github.com/legioncodeinc"><img src="assets/legion-code.png" alt="Legion Code" height="56"></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://activeloop.ai"><img src="assets/activeloop.png" alt="Activeloop Deep Lake" height="56"></a>
</p>

<p align="center"><strong>A <a href="https://github.com/legioncodeinc">Legion Code</a> &times; <a href="https://activeloop.ai">Activeloop</a> collaboration</strong></p>

> Shared memory for your AI coding agents — what one harness learns, the others recall.

[![CI](https://img.shields.io/github/actions/workflow/status/legioncodeinc/honeycomb/ci.yaml?branch=main&label=CI)](https://github.com/legioncodeinc/honeycomb/actions)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/legioncodeinc/honeycomb)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Powered by Deep Lake](https://img.shields.io/badge/powered%20by-Activeloop%20Deep%20Lake-ff5a1f)](https://activeloop.ai)

AI coding agents forget. They forget across sessions, and they forget across tools — a decision you reached in Claude Code is invisible to Cursor the next morning. Honeycomb gives your agents one shared, persistent memory: a local daemon captures what happens on every turn and serves it back to any harness that asks. Learn something once, recall it everywhere.

> **Status:** v0.1.0, pre-release. Capture-to-recall is proven end-to-end against live Deep Lake. Local single-user mode is first-class; semantic embeddings and team mode are opt-in / in hardening (see [Status & roadmap](#status--roadmap)).

---

## Built together: Legion Code &times; Activeloop

Honeycomb is a collaboration between **[Legion Code Inc](https://github.com/legioncodeinc)** and **[Activeloop](https://activeloop.ai)** — an agent-memory product paired with the data infrastructure built to make it possible.

- **Activeloop** brings **[Deep Lake](https://activeloop.ai)**, the database for AI: a versioned, multi-modal store with native vector + columnar indexing and hybrid lexical + semantic search. It is the substrate Honeycomb's memory lives in — and the reason recall can scale from a single session to an organization's entire history.
- **Legion Code** brings **Honeycomb**: the daemon architecture, the six-harness integrations, and the capture → summarize → recall pipeline that turns Deep Lake into a shared brain your coding agents read and write on every turn.

Neither half stands alone. Deep Lake gives the memories somewhere durable and queryable to live; Honeycomb gives every harness one consistent way to write to and recall from it — so what one agent learns survives a closed session, a switched tool, and a new teammate.

---

## What it is

Honeycomb is a long-lived local **daemon** plus thin clients. The daemon is the *only* process that talks to storage; every harness, the CLI, the MCP server, and the SDK reach it over loopback HTTP. That keeps one shared memory behind one boundary, and keeps your Deep Lake credentials in exactly one place.

```
  ┌─ Claude Code ─┐
  ├─ Cursor ──────┤        loopback HTTP            ┌──────────────┐
  ├─ Codex ───────┤      127.0.0.1:3850             │  Activeloop  │
  ├─ Hermes ──────┼──▶  honeycomb daemon  ──────▶   │  Deep Lake   │
  ├─ pi ──────────┤   (sole storage client)         │  (vector +   │
  └─ OpenClaw ────┘                                  │   columnar)  │
       thin clients                                  └──────────────┘
   (hooks · CLI · MCP · SDK)
```

- **One daemon, one client.** The daemon binds **`127.0.0.1:3850`** (loopback only, single machine) and is the sole Deep Lake client. Nothing else holds a storage handle.
- **Capture on every turn.** Per-harness hooks stream each turn to the daemon, which summarizes and persists it.
- **Recall through the daemon.** Any harness can ask for relevant memories; the daemon runs the query and returns results — already scoped to your org and workspace.
- **Built on Deep Lake.** Memories live in [Activeloop Deep Lake](https://activeloop.ai), the vector + columnar store underneath.

## Quickstart

**Prerequisites:** Node.js **≥ 22**, a git checkout, and Activeloop Deep Lake credentials (the daemon fails closed without them).

```bash
# 1. Clone and build (esbuild produces the bundled `honeycomb` CLI at bundle/cli.js)
git clone https://github.com/legioncodeinc/honeycomb.git
cd honeycomb
npm install
npm run build
```

```bash
# 2. Point the daemon at your Deep Lake dataset (it reads these from the environment)
export HONEYCOMB_DEEPLAKE_ENDPOINT="https://api.activeloop.ai"
export HONEYCOMB_DEEPLAKE_TOKEN="<your-activeloop-token>"
export HONEYCOMB_DEEPLAKE_ORG="<your-org>"
export HONEYCOMB_DEEPLAKE_WORKSPACE="<your-workspace>"
```

```bash
# 3. Detect your assistants, wire their hooks, and bring up the daemon
node bundle/cli.js setup

# 4. Capture a memory, then recall it — through the daemon, shared across harnesses
node bundle/cli.js remember "we deploy from the prd-022 branch, never from main"
node bundle/cli.js recall "how do we deploy"
```

`setup` wires every coding assistant it detects and starts the loopback daemon; any storage command auto-starts the daemon if it is down. Check the daemon and your environment any time with `node bundle/cli.js status`.

> Once the package is published you'll be able to install the `honeycomb` binary globally; until then, run it from the build output as shown above.

## How it works

- **Capture.** As you work, each harness's hooks send the turn to the daemon over loopback. The daemon summarizes and writes it to Deep Lake, scoped to your org and workspace.
- **Recall.** `recall` (and the harness session-start hook) ask the daemon for relevant memories. The daemon runs a multi-channel query and returns the hits — the CLI never sees a storage handle or a line of SQL.
- **Shared across harnesses.** Because every client reaches the same daemon and the same dataset, a memory written from one harness is recallable from all of them.

## Supported harnesses

Honeycomb ships thin clients for six coding harnesses:

| Harness | Harness | Harness |
|---|---|---|
| Claude Code | Cursor | Codex |
| Hermes | pi | OpenClaw |

`honeycomb setup` detects the ones you have installed and wires each idempotently; `honeycomb uninstall` reverses only Honeycomb's changes.

## Interfaces

Four ways to reach the same daemon and the same shared memory:

- **CLI** — the unified `honeycomb` binary. Core verbs: `setup`, `status`, `daemon start|stop|status`, `remember`, `recall`, `sessions`, `skill`, `goal`, `sources`, `graph`, `dashboard`. Run `honeycomb --help` for the full list.
- **Dashboard** — a local web UI the daemon serves at **`http://127.0.0.1:3850/dashboard`**: KPIs (memories, turns, est. savings, team skills), memory recall, the codebase graph, captured turns, skill-sync, and settings, with a live request log. Open it with `honeycomb dashboard` (or browse to the URL while the daemon is up).
- **MCP server** — a [Model Context Protocol](https://modelcontextprotocol.io) server (bundled to `mcp/bundle`) that exposes Honeycomb's memory tools to MCP-capable hosts.
- **TypeScript SDK** — the `@honeycomb/sdk` client with framework subpath entries (`@honeycomb/sdk/react`, `@honeycomb/sdk/vercel`, `@honeycomb/sdk/openai`). The core entry is fetch-only and browser-safe; `react` and `ai` are optional peers.

## Status & roadmap

Honeycomb is **v0.1.0, pre-release**. We document what is real and flag what is coming.

**Working today**
- Capture-to-recall, proven end-to-end against live Deep Lake (`npm run smoke:golden-path` with credentials).
- The loopback daemon, the unified CLI, per-harness hooks, the MCP server, and the SDK.
- Local single-user mode as a first-class path.

**Experimental / coming**
- **Embeddings are off by default.** Recall runs a lexical / BM25 fallback; turning on the local embedding daemon adds 768-dim semantic (cosine) recall. The fallback is silent and intentional — recall never errors when embeddings are unavailable.
- **Team / multi-tenant mode** is behind hardening; local single-user mode is the supported path today.
- The daemon binds **loopback only** (single machine). There is no remote/multi-host transport.

## Development

```bash
npm install
npm run build        # tsc + esbuild → bundle/cli.js, the daemon, harness, MCP, and embed bundles
npm run ci           # the gate: typecheck + duplication (jscpd) + tests (vitest) + SQL-safety audit
```

`npm run ci` is the quality gate every change must pass. See [`docs/ci.md`](docs/ci.md) for the pipeline.

## License

Pre-release and not yet licensed for redistribution. © Legion Code Inc.

---

<sub>**Built by [Legion Code Inc](https://github.com/legioncodeinc)** · **Powered by [Activeloop Deep Lake](https://activeloop.ai)** — the vector and columnar store Honeycomb's shared memory is built on.</sub>
