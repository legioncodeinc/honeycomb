<!-- ───────────────────────────────  HERO  ─────────────────────────────── -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logos/honeycomb-memory-cluster-wordmark-on-dark.svg">
    <img src="assets/logos/honeycomb-memory-cluster-wordmark.svg" alt="Honeycomb" height="84">
  </picture>
</p>

<p align="center">
  <strong>Shared, persistent memory for your AI coding agents.</strong><br>
  What one harness learns, every other one recalls, across sessions, tools, devices, and teammates.
</p>

<p align="center">
  <a href="https://github.com/legioncodeinc/honeycomb/actions"><img src="https://img.shields.io/github/actions/workflow/status/legioncodeinc/honeycomb/ci.yaml?branch=main&label=CI&style=flat-square" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.0-F7A823?style=flat-square" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node ≥ 22">
  <a href="https://deeplake.ai"><img src="https://img.shields.io/badge/powered%20by-Deep%20Lake-ff5a1f?style=flat-square" alt="Powered by Deep Lake"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/harnesses-6-F7A823?style=flat-square" alt="6 harnesses">
</p>

<!-- ──────────────────────────────  PARTNERS  ────────────────────────────── -->

<p align="center">
  <a href="https://github.com/legioncodeinc">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/legion-logo-dark.svg">
      <img src="assets/logos/legion-logo-light.svg" alt="Legion Code" height="34">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://activeloop.ai"><img src="assets/logos/activeloop-full-mark-logo.svg" alt="Activeloop" height="26"></a>
</p>

<p align="center"><sub>A <a href="https://github.com/legioncodeinc"><strong>Legion Code</strong></a> &times; <a href="https://activeloop.ai"><strong>Activeloop</strong></a> collaboration · built on <a href="https://github.com/activeloopai/hivemind">Hivemind</a> &amp; <a href="https://deeplake.ai">Deep Lake</a></sub></p>

---

AI coding agents forget. They forget across sessions, and they forget across tools. A decision you reached in Claude Code at midnight is invisible to Cursor the next morning. **Honeycomb fixes that.** A local daemon captures what happens on every turn, distills it, and serves it back to any harness that asks. Learn something once; recall it everywhere, on any machine, in any tool, for anyone on your team.

> **New here?** One command and you're on a dashboard. [Jump to Install](#-install-one-command). · **Want the docs?** Everything lives at **[theapiary.sh](https://theapiary.sh)**.

<table>
<tr>
<td width="50%" valign="top">

#### 🛹 For vibe coders
Stop re-explaining your project to a fresh agent every morning. Honeycomb remembers your decisions, your conventions, and the fixes that worked, then primes your next session with them automatically. One install command, a friendly dashboard, no SQL, no config gauntlet.

</td>
<td width="50%" valign="top">

#### 🏢 For enterprise teams
One shared brain across every developer, device, and coding tool. A skill discovered by one engineer propagates to the whole team on their next session. Tenancy is enforced at the storage layer; credentials live behind a single loopback boundary; everything is versioned and auditable.

</td>
</tr>
</table>

---

## ✨ What makes Honeycomb different

A vector database can store text and hand it back by similarity. Honeycomb does that, and then keeps going. On top of [Activeloop Deep Lake](https://deeplake.ai), **[Legion Code](https://github.com/legioncodeinc)** builds the memory system that turns raw recall into a brain your agents actually trust:

- **🧠 Three-tier memory.** Every memory exists at three resolutions at once (one-line **key** → **summary** → full **raw** session). Agents skim the keys, then zoom into detail only when they need it. *(Legion Code)*
- **🎯 Session priming.** At session start a tiny, bounded index (~300-800 tokens) of your most relevant keys is pushed once; the agent pulls deeper on demand. No per-turn injection, no "lost in the middle." *(Legion Code)*
- **🍯 Skillify & propagation.** The daemon mines reusable skills out of real sessions, gates them for quality, and auto-pulls the team's latest skills into every agent at session start. Author a skill once; everyone gets it. *(Legion Code)*
- **🌼 The pollinating loop.** A periodic maintenance pass reasons over accumulated memory and the entity graph to merge duplicates, prune junk, and supersede stale facts, so memory gets *sharper* over time, not noisier. *(Legion Code)*
- **🕸️ Knowledge graph.** An entity-centric, versioned, provenance-tracked index over your memories. Newer facts supersede stale ones; every claim traces back to the session that produced it. *(Legion Code)*
- **🔀 Hybrid recall.** Lexical (BM25) and semantic (768-dim vectors) search fused by Reciprocal Rank Fusion, with a measured **recall@5 ≈ 0.72-0.78**. *(built on Deep Lake)*
- **🗺️ Codebase graph.** A multi-language AST graph (TypeScript, JS, Python, Go, Rust, Java, Ruby, C/C++) of files, functions, and their call/import/extends edges, queryable for impact and neighborhood. *(Legion Code)*

---

## 🚀 Install (one command)

No Node? No npm? No problem. The installer detects and sets up everything, then **opens a dashboard in your browser**. The terminal is just a progress log; the product is the first thing you touch.

```bash
# macOS / Linux
curl -fsSL https://get.theapiary.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://get.theapiary.sh/install.ps1 | iex
```

That single line installs a current Node/npm if missing, installs **`@legioncodeinc/honeycomb`** globally, brings up the daemon on `127.0.0.1:3850`, and opens the dashboard. Then:

1. The dashboard loads in a **pre-auth setup state**. No token ever touches your shell.
2. Click **"First time setup."** Honeycomb runs the Deep Lake device-flow login *for* you, shows the code right on the page, and opens the verification tab.
3. Done. The same running daemon lights up its Deep Lake-backed surfaces, and capture and recall go live.

> Already running **Hivemind**? The dashboard detects it, explains that running both is unsupported, and **"Proceed with Honeycomb"** migrates you cleanly. Prefer to inspect before you pipe? The script and a published `SHA256SUMS` are served from [get.theapiary.sh](https://get.theapiary.sh).

<details>
<summary><strong>Prefer to build from source?</strong></summary>

```bash
git clone https://github.com/legioncodeinc/honeycomb.git
cd honeycomb
npm install
npm run build          # tsc + esbuild → bundle/cli.js, daemon, harness, MCP, embed bundles

node bundle/cli.js setup     # detect your assistants, wire hooks, start the daemon
node bundle/cli.js status    # check the daemon and your environment
```

`setup` wires every coding assistant it detects and starts the loopback daemon; any storage command auto-starts the daemon if it is down. You'll need Activeloop Deep Lake credentials; the device flow above writes them to the shared `~/.deeplake/credentials.json`.

</details>

---

## 🐝 First memory, shared across tools

```bash
# Capture a decision once…
honeycomb remember "we deploy from the prd-022 branch, never from main"

# …recall it anywhere: same daemon, same Deep Lake, any harness
honeycomb recall "how do we deploy"
```

Write it from Claude Code; recall it from Cursor tomorrow on a different laptop. That's the whole point.

---

## 🏗️ How it works

Honeycomb is a long-lived local **daemon** plus thin clients. The daemon is the *only* process that talks to storage. Every harness, the CLI, the MCP server, and the SDK reach it over loopback HTTP. One shared memory behind one boundary; your Deep Lake credentials in exactly one place.

```
     Claude Code    Cursor    Codex    Hermes    pi    OpenClaw
          │           │         │        │       │        │
          └───────────┴────┬────┴────────┴───────┴────────┘
                 hooks · CLI · MCP · SDK   (thin clients)
                           │
                  loopback HTTP · 127.0.0.1:3850
                           │
            ┌──────────────────────────────┐
            │       honeycomb daemon        │   sole storage client
            │  capture · recall · skillify  │   owns your credentials
            │  pollinate · session priming  │
            └───────────────┬──────────────┘
                            │
            ┌──────────────────────────────┐
            │     Activeloop Deep Lake      │   versioned · columnar + vector
            │   Tier 1 · Tier 2 · Tier 3    │   BM25 + semantic hybrid
            └──────────────────────────────┘
```

- **Capture on every turn.** Per-harness hooks stream each turn to the daemon, which distills and persists it: always-on, cheap, and soft-failing so a capture error never breaks your agent's turn.
- **Recall through the daemon.** Any harness asks for relevant memories; the daemon runs the query and returns results already scoped to your org and workspace. The client never sees a storage handle or a line of SQL.
- **Shared by construction.** Every client reaches the same daemon and the same dataset, so a memory written from one harness is recallable from all of them.

---

## 🧠 The three-tier memory system

This is the heart of what **Legion Code** adds on top of Deep Lake. The same memory lives at three levels of detail at once, and the agent chooses how far to zoom:

| Tier | What it is | When it's used |
|---|---|---|
| **Tier 1 · Key** | One keyword-dense sentence per session or fact. The index. | Skimmed at session start during priming. |
| **Tier 2 · Summary** | A distilled recap: goals, decisions, blockers, outcomes. Carries the semantic embedding. | Pulled when a key looks relevant. |
| **Tier 3 · Raw** | The full session dialogue: exact turns and tool calls, never rewritten. | Resolved when the agent needs ground truth. |

Resolution is a **deterministic SQL join, not a fuzzy search**. `key → summary → raw` is a pointer walk down three Deep Lake tables. Mining ("find the thing I didn't know to name") is where the hybrid vector + lexical search kicks in. Cheap when you're skimming, precise when you're zooming.

---

## 💎 Why Deep Lake makes the difference

Most agent-memory tools bolt onto a vector-only store, which forces *every* access pattern through a similarity engine. Honeycomb's zoom model needs both exact joins **and** semantic search, and [**Deep Lake**](https://deeplake.ai), the database for AI, gives it both natively:

- **SQL + vector in one engine.** The cheap skim and the deterministic zoom run as SQL; semantic mining runs as vector search; a single store serves both. No second database, no sync problem.
- **Versioned & append-only.** Writes bump a version instead of mutating in place, so memory's full history stays on disk. Supersession marks old facts stale without losing them, which is what makes the pollinating loop safe and auditable.
- **Hybrid lexical + semantic search.** BM25 and 768-dim `nomic-embed-text-v1.5` cosine arms, fused by Reciprocal Rank Fusion. Turn embeddings off and recall silently falls back to lexical, never an error, no quality cliff.
- **Built to scale & BYOC.** The same substrate that serves one developer's laptop serves an organization's entire history, in your own cloud bucket if you want it.

> Honeycomb stands on two shoulders: **[Deep Lake](https://deeplake.ai)** gives the memories somewhere durable and queryable to live, and **[Hivemind](https://github.com/activeloopai/hivemind)**, Activeloop's open-source agent-memory project, is the foundation Legion Code extended into Honeycomb's multi-tier system.

---

## 🔌 Supported harnesses

Honeycomb ships thin clients for six coding harnesses, all wired simultaneously, all reading and writing the same shared memory:

| | | |
|---|---|---|
| **Claude Code** | **Cursor** | **Codex** |
| **Hermes** | **pi** | **OpenClaw** |

`honeycomb setup` detects the ones you have installed and wires each idempotently; `honeycomb uninstall` reverses only Honeycomb's changes. A skill mined while you were in Cursor is auto-pulled and ready in Claude Code on your next session.

---

## 🎛️ Interfaces

Four ways to reach the same daemon and the same shared memory:

- **CLI.** The unified `honeycomb` binary. Core verbs: `install`, `setup`, `status`, `daemon start|stop|status`, `remember`, `recall`, `sessions`, `skill`, `goal`, `sources`, `graph`, `dashboard`. Run `honeycomb --help` for the full list.
- **Dashboard.** A local web UI the daemon serves at **`http://127.0.0.1:3850/dashboard`**: KPIs (memories, turns, est. savings, team skills), memory recall, the codebase graph, captured turns, skill-sync, and settings, with a live request log. It's also the guided-setup surface for first-time login.
- **MCP server.** A [Model Context Protocol](https://modelcontextprotocol.io) server (bundled to `mcp/bundle`) exposing Honeycomb's read/resolve and search/mine tools to any MCP-capable host.
- **TypeScript SDK.** The `@legioncodeinc/honeycomb` client with framework subpath entries (`/react`, `/vercel`, `/openai`). The core entry is fetch-only and browser-safe; `react` and `ai` are optional peers.

---

## 📍 Status & roadmap

Honeycomb is **v0.1.0, pre-release**. We document what's real and flag what's opt-in.

**Working today**
- Capture-to-recall, proven end-to-end against live Deep Lake (`npm run smoke:golden-path` with credentials).
- One-command install → guided dashboard setup, the loopback daemon, the unified CLI, per-harness hooks, the MCP server, and the SDK.
- Three-tier memory, session priming, skillify + propagation, the pollinating loop, the knowledge graph, and the codebase graph.

**Opt-in / by design**
- **Embeddings are opt-in.** Recall runs the lexical BM25 path by default; turning on the local embedding runtime (≈600 MB, model fetched on first warmup) adds 768-dim semantic recall. The fallback is silent and intentional; recall never errors when embeddings are unavailable.
- **The distillation pipeline is off by default** to avoid surprise model spend; enable it when you want background summarization and graph extraction.
- The daemon binds **loopback only** (single machine). Cross-device and cross-user sharing happen through Deep Lake's org/workspace scope, not a remote daemon bind.

Full documentation, guides, and the roadmap live at **[theapiary.sh](https://theapiary.sh)**.

---

## 🛠️ Development

```bash
npm install
npm run build        # tsc + esbuild → bundle/cli.js, the daemon, harness, MCP, and embed bundles
npm run ci           # the gate: typecheck + duplication (jscpd) + tests (vitest) + SQL-safety audit
```

`npm run ci` is the quality gate every change must pass.

---

## 🙏 Credits

Honeycomb exists because two halves fit together:

- **[Activeloop](https://activeloop.ai)** brings **[Deep Lake](https://deeplake.ai)** (the versioned, multi-modal database for AI with native vector + columnar indexing and hybrid search) and **[Hivemind](https://github.com/activeloopai/hivemind)**, the open-source agent-memory project Honeycomb is built upon.
- **[Legion Code Inc](https://github.com/legioncodeinc)** brings the **multi-tier memory system** (Tier 1 / 2 / 3 keys, summaries, raw), **session priming**, **skillify & propagation**, the **pollinating loop**, the **knowledge graph**, and the daemon architecture that turns Deep Lake into a shared brain your coding agents read and write on every turn.

Neither half stands alone. Deep Lake and Hivemind give the memories somewhere durable to live; Legion Code gives every harness one consistent way to write to and recall from it, so what one agent learns survives a closed session, a switched tool, a new machine, and a new teammate.

---

## License

Honeycomb is licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](LICENSE)).

Use it commercially or privately, free of charge. In return: keep the copyright and license notices intact, and if you modify it, your changes ship under the same AGPL license with source available. The "Affero" part is the point: run a modified version as a network service and you owe its source to the users who interact with it. No locking a fork behind a SaaS wall.

© 2026 Legion Code Inc.

---

<p align="center">
  <sub><strong>Built by <a href="https://github.com/legioncodeinc">Legion Code Inc</a></strong> · <strong>Powered by <a href="https://deeplake.ai">Activeloop Deep Lake</a></strong> · <strong>Built on <a href="https://github.com/activeloopai/hivemind">Hivemind</a></strong></sub><br>
  <sub><a href="https://theapiary.sh">theapiary.sh</a></sub>
</p>
