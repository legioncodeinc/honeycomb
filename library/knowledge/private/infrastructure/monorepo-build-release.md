# Monorepo Build and Release Pipeline

> Category: Infrastructure | Version: 1.0 | Date: June 2026 | Status: Active

How Honeycomb compiles, bundles, and packages its monorepo core, the daemon, and per-agent integrations.

**Related:**
- [`../overview.md`](../overview.md)
- [`../architecture/system-overview.md`](../architecture/system-overview.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../integrations/hook-lifecycle.md`](../integrations/hook-lifecycle.md)
- [`../operations/cli-command-architecture.md`](../operations/cli-command-architecture.md)
- [`../integrations/mcp-and-sdk.md`](../integrations/mcp-and-sdk.md)

---

## Why this pipeline exists

Honeycomb is built as a single TypeScript monorepo that supports six different coding assistants plus a long-lived daemon. Each assistant requires its own specific plugin structure, files layout, and distribution format, and the daemon ships as its own self-contained artifact. To deliver optimal performance, reduce memory overhead, and ensure near-instant startup times inside resource-constrained IDE environments, Honeycomb implements a two-stage compilation and bundling process:

1. **Type Checking and Compilation (`tsc`):** The TypeScript compiler compiles the entire shared core, the daemon, and agent shims, verifying type safety and emitting modular JavaScript to the `dist/` directory.
2. **Bundling (`esbuild`):** An esbuild script gathers the compiled outputs and bundles them into self-contained, optimized, and executable modules. This step drops unused code, resolves imports, and generates independent plugin bundles for each platform plus the daemon binary.

This approach keeps the source code maintainable in a unified monorepo while delivering custom-tailored, self-contained, and highly optimized artifacts to the respective host assistants. The hooks and CLI bundles stay thin because they are daemon clients; only the daemon bundle carries the DeepLake access path.

---

## Pipeline Execution

The entry point of the build process is defined in the workspace `package.json` scripts:

```33:50:package.json
  "scripts": {
    "prebuild": "node scripts/sync-versions.mjs",
    "build": "tsc && node esbuild.config.mjs",
    "bundle": "node esbuild.config.mjs",
    "dev": "tsc --watch",
    "shell": "tsx src/shell/deeplake-shell.ts",
    "cli": "tsx src/cli/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dup": "jscpd src",
    "audit:openclaw": "node scripts/audit-openclaw-bundle.mjs",
    "pack:check": "node scripts/pack-check.mjs",
    "rebuild:native": "node scripts/ensure-tree-sitter.mjs",
    "ci": "npm run typecheck && npm run dup && npm test",
    "postinstall": "node scripts/ensure-tree-sitter.mjs",
    "prepare": "husky && npm run build",
    "prepack": "npm run build"
  },
```

---

## Version Synchronization

To keep the release version in sync across the entire ecosystem, the `prebuild` hook runs a dedicated version sync script. This script reads the version number from the main `package.json` file and propagates it to all plugin manifest files:

```13:25:scripts/sync-versions.mjs
const SOURCE = "package.json";

// Scalar targets: each has a single top-level `version` field tracking package.json.
export const SCALAR_TARGETS = [
  ".claude-plugin/plugin.json",
  "harnesses/claude-code/.claude-plugin/plugin.json",
  "harnesses/openclaw/openclaw.plugin.json",
  "harnesses/openclaw/package.json",
  "harnesses/codex/package.json",
];
```

The script is idempotent. It parses the JSON manifests, verifies whether the target version matches, and performs the file write only if there is a discrepancy. It also updates the marketplace definition file:

```63:88:scripts/sync-versions.mjs
  const marketplace = readJsonAt(root, MARKETPLACE_PATH);
  let mpChanged = false;
  if (marketplace.metadata?.version !== version) {
    const old = marketplace.metadata?.version;
    marketplace.metadata = marketplace.metadata || {};
    marketplace.metadata.version = version;
    log(`sync-versions: ${MARKETPLACE_PATH} metadata.version: ${old} -> ${version}`);
    mpChanged = true;
  }
  if (Array.isArray(marketplace.plugins)) {
    for (const plugin of marketplace.plugins) {
      if (plugin.version !== version) {
        const old = plugin.version;
        plugin.version = version;
        log(`sync-versions: ${MARKETPLACE_PATH} plugins[${plugin.name}].version: ${old} -> ${version}`);
        mpChanged = true;
      }
    }
  }
  if (mpChanged) {
    writeJsonAt(root, MARKETPLACE_PATH, marketplace);
    writes++;
  } else {
    log(`sync-versions: ${MARKETPLACE_PATH} already at ${version}`);
    skips++;
  }
```

---

## Bundling with Esbuild

The core bundling engine is `esbuild.config.mjs`. It orchestrates compilation configs for the different targets, matching their runtime requirements and dependencies.

### Output Bundles and Targets

Esbuild generates separate distribution bundles under the following directories:

* **Daemon:** Generated under `daemon/`. It compiles the long-lived Honeycomb daemon that listens on port 3850 and is the only artifact that opens the DeepLake backend. Every other bundle below is a thin client of this daemon.
* **Claude Code:** Generated under `harnesses/claude-code/bundle/`. It packs hooks like `session-start`, `session-end`, `pre-tool-use`, `capture`, and several specialized background workers.
* **Codex:** Generated under `harnesses/codex/bundle/`. It includes the Codex-specific lifecycle shims and background tasks.
* **Cursor:** Generated under `harnesses/cursor/bundle/`. It packages the `session-start`, `capture`, `pre-tool-use`, `session-end`, and `graph-on-stop` hooks.
* **Hermes Agent:** Generated under `harnesses/hermes/bundle/`. It bundles hooks following the NousResearch/hermes-agent shell hook protocol.
* **pi:** Generated under `harnesses/pi/bundle/`. It bundles background workers like the `wiki-worker` and `skillify-worker`. (The main pi extension runs raw TypeScript compiled by pi's runtime.)
* **OpenClaw:** Generated under `harnesses/openclaw/dist/`. It outputs the compiled HTTP/WebSocket plugin gateway, along with its async `skillify-worker`.
* **MCP Server:** Generated under `mcp/bundle/`. It builds the standalone Model Context Protocol server that can be hooked into Cline, Roo, or Kilo.
* **Unified CLI:** Generated under `bundle/`. It produces the primary `honeycomb` executable binary.
* **Embed Daemon:** Generated under `embeddings/`. It compiles the standalone semantic search background daemon.

### Handling Native Dependencies

A major challenge in bundling Honeycomb is its dependency on native Node modules. Specifically, the codebase graph extractor uses `tree-sitter` and various language grammars, which compile down to native binary files (`.node` assets).

Because esbuild cannot bundle native binaries into a pure JavaScript module, these dependencies are declared as `external` in the esbuild configurations. At runtime, the bundles resolve these dependencies from `node_modules` on the host machine.

```52:82:esbuild.config.mjs
await build({
  entryPoints: Object.fromEntries(ccAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "harnesses/claude-code/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
    // tree-sitter and language grammars ship native .node prebuilds that
    // esbuild cannot bundle. Resolved from node_modules at runtime.
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-rust",
    "tree-sitter-java",
    "tree-sitter-ruby",
    "tree-sitter-c",
    "tree-sitter-cpp",
  ],
  define: {
    __HONEYCOMB_VERSION__: JSON.stringify(honeycombVersion),
  },
});
```

---

## OpenClaw Specialized Bundling and Security

The OpenClaw gateway operates under a strict sandbox model. This requires advanced optimizations and security overrides during compilation.

### Stubbing Node Processes

The shared core contains utilities that invoke sub-processes, such as opening browser tabs during login or launching background workers. In OpenClaw, these actions are disallowed or unneeded because it is a remote gateway.

To eliminate unreachable code that would trigger security warnings on the ClawHub registry, esbuild uses a custom plugin to stub the native `node:child_process` module:

```404:426:esbuild.config.mjs
  plugins: [{
    // Dead-code elimination for transitively bundled CC/Codex-only features.
    // harnesses/openclaw/src/index.ts imports shared modules from ../../src/ (daemon
    // client, grep-core, virtual-table-query, auth device-flow). Several of those
    // modules also host CC-specific helpers that shell out with execSync —
    // opening the browser for SSO, nudging plugin-update, spawning the
    // wiki-worker daemon. Those helpers are never called through the openclaw
    // entry point (openclaw is a pure HTTP/WebSocket gateway; it has no local
    // browser, uses its own plugin installer, and does not run the wiki-worker
    // daemon). Replacing node:child_process with a no-op export drops that
    // dead code from the bundle instead of shipping unreachable exec calls.
    name: "stub-unused-child-process",
    setup(build) {
      build.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: "node:child_process",
        namespace: "stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const execSync = () => {}; export const execFileSync = () => {}; export const spawn = () => {};",
        loader: "js",
      }));
    },
  }],
```

### Global Environment Dispatch

The ClawHub scanner blocks uploads containing raw `process.env` lookups alongside network queries to prevent credential harvesting. To bypass this, the esbuild configuration rewrites all environment variable lookups into properties on a global tuning object:

```371:403:esbuild.config.mjs
    // ----- User-tunable knobs: routed through a globalThis dispatch -----
    // Every read of `process.env.HONEYCOMB_X` in transitively-bundled code is
    // rewritten by esbuild to `globalThis.__honeycomb_tuning__.HONEYCOMB_X`.
    // The openclaw plugin's `register()` populates that object from
    // `pluginApi.pluginConfig.tuning` (i.e. what the user wrote under
    // `plugins.entries.honeycomb.config.tuning` in `openclaw.json`). So the
    // bundle has zero `process.env.X` substrings (ClawHub scan passes), AND
    // the user can still tune at runtime by editing openclaw.json + restart.
    // CodeRabbit + @efenocchi on #170 pushed back on the previous
    // inline-to-undefined approach because it removed the env-override
    // surface entirely. This restores it via a different mechanism.
    "process.env.HONEYCOMB_DEBUG": "globalThis.__honeycomb_tuning__.HONEYCOMB_DEBUG",
    "process.env.HONEYCOMB_TRACE_SQL": "globalThis.__honeycomb_tuning__.HONEYCOMB_TRACE_SQL",
    "process.env.HONEYCOMB_QUERY_TIMEOUT_MS": "globalThis.__honeycomb_tuning__.HONEYCOMB_QUERY_TIMEOUT_MS",
    "process.env.HONEYCOMB_INDEX_MARKER_TTL_MS": "globalThis.__honeycomb_tuning__.HONEYCOMB_INDEX_MARKER_TTL_MS",
    "process.env.HONEYCOMB_INDEX_MARKER_DIR": "globalThis.__honeycomb_tuning__.HONEYCOMB_INDEX_MARKER_DIR",
    "process.env.HONEYCOMB_SEMANTIC_LIMIT": "globalThis.__honeycomb_tuning__.HONEYCOMB_SEMANTIC_LIMIT",
    "process.env.HONEYCOMB_HYBRID_LEXICAL_LIMIT": "globalThis.__honeycomb_tuning__.HONEYCOMB_HYBRID_LEXICAL_LIMIT",
    "process.env.HONEYCOMB_GREP_LIKE": "globalThis.__honeycomb_tuning__.HONEYCOMB_GREP_LIKE",
    "process.env.HONEYCOMB_SEMANTIC_SEARCH": "globalThis.__honeycomb_tuning__.HONEYCOMB_SEMANTIC_SEARCH",
    "process.env.HONEYCOMB_SEMANTIC_EMBED_TIMEOUT_MS": "globalThis.__honeycomb_tuning__.HONEYCOMB_SEMANTIC_EMBED_TIMEOUT_MS",
    "process.env.HONEYCOMB_SEMANTIC_EMIT_ALL": "globalThis.__honeycomb_tuning__.HONEYCOMB_SEMANTIC_EMIT_ALL",
    // `HONEYCOMB_STATE_DIR` is the test-isolation override that points
    // `~/.honeycomb/state/skillify` at a `mkdtempSync()` dir. OpenClaw has
    // no testing surface and no reason to redirect state, so it always
    // resolves to `undefined` at runtime — the call-site `??
    // homedir()/...` fallback produces the production path. The rewrite
    // matters mainly to keep the ClawHub `env-harvesting` scanner happy:
    // a literal `process.env.HONEYCOMB_STATE_DIR` substring in the same
    // file as a network send trips the critical rule even though the
    // value is just a directory path.
    "process.env.HONEYCOMB_STATE_DIR": "globalThis.__honeycomb_tuning__.HONEYCOMB_STATE_DIR",
```

---

## Distribution and Post-Install Processes

When the user runs `npm install -g @honeycomb/cli`, the global package is laid down on their machine.

A `postinstall` script immediately invokes `node scripts/ensure-tree-sitter.mjs`. This script checks the host OS, ensures that correct binary prebuilds for `tree-sitter` and the language grammars are download-resolved, and handles potential compilation fallback steps.

The CLI binary is exposed via the `bin` field in `package.json`, which points to `bundle/cli.js`. This file is generated with an executable permission stamp `0755` and a standard hash-bang line pointing to the Node.js interpreter, ensuring a seamless terminal execution experience. The first CLI invocation that needs storage will start the daemon if it is not already running, so users never have to launch it by hand.
