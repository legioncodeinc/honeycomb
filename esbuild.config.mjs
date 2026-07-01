// Honeycomb per-target bundler (PRD-001b).
//
// Consumes the modular ESM that `tsc` emits under dist/ (BUILD.md "dist/
// layout") and produces one self-contained bundle per target to its declared
// outdir (FR-1). Native modules stay `external` and resolve from node_modules
// at runtime (FR-2). The build version is injected via `__HONEYCOMB_VERSION__`
// so every bundle self-reports (FR-5). The CLI gets a Node hash-bang + 0755
// (FR-8). The OpenClaw build stubs node:child_process (FR-6) and rewrites
// process.env.HONEYCOMB_* reads through a globalThis tuning dispatch (FR-7).
//
// Open question (per-target vs one multi-entry build): RESOLVED to a separate
// `build()` invocation per target. Each target needs a different `external`
// list (only daemon/embed/CLI carry the native modules; harness/MCP do not) and
// the OpenClaw target layers on a `define` map, a `banner`, a plugin, and code
// splitting that the others must NOT inherit. One multi-entry build cannot
// express those per-target differences, so per-target invocations are the
// correct shape — and they document, per target, exactly what is externalized.
//
// Open question (embed daemon external list): RESOLVED — the embed daemon gets
// its OWN external list that includes the ONNX/transformers/sharp inference
// stack (onnxruntime-node, onnxruntime-common, @huggingface/transformers,
// sharp) in addition to the shared native compression deps. It does NOT share
// the daemon's tree-sitter externals (the embed daemon does not parse code),
// keeping its externals scoped to what it actually loads at runtime.
//
// Open question (harness vs daemon Node target): RESOLVED — every bundle is
// `platform: "node"` and targets the repo Node engine (>=22). There is no need
// to down-level harness bundles; all hosts run on the same Node 22 floor.

import { build } from "esbuild";
import { chmodSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";

const ESM_PACKAGE_JSON = '{"type":"module"}\n';

// Single source of truth for the injected version: the root package.json
// version (PRD-001c keeps every manifest in sync with this same value, so the
// OpenClaw bundle's __HONEYCOMB_VERSION__ matches the root version too).
const HONEYCOMB_VERSION = JSON.parse(readFileSync("package.json", "utf-8")).version;

// PRD-050 substrate build-time defines. Each is sourced from a CI env var with a
// safe default and JSON.stringify'd into the define map EXACTLY as the version
// define above — esbuild then substitutes the string literal into every bundle.
//   - HONEYCOMB_REF_DEFAULT  → the default referral code (default "mario").
//   - HONEYCOMB_POSTHOG_KEY  → the PostHog project key. Default "" (empty =
//     telemetry disabled; PRD-050e treats an empty key as a no-op). NO real key
//     is ever committed to source — the key arrives ONLY via CI env at build time.
//   - HONEYCOMB_POSTHOG_HOST → the PostHog ingest host (default us cloud).
const HONEYCOMB_REF_DEFAULT = process.env.HONEYCOMB_REF_DEFAULT ?? "mario";
const HONEYCOMB_POSTHOG_KEY = process.env.HONEYCOMB_POSTHOG_KEY ?? "";
const HONEYCOMB_POSTHOG_HOST = process.env.HONEYCOMB_POSTHOG_HOST ?? "https://us.i.posthog.com";

const VERSION_DEFINE = {
  __HONEYCOMB_VERSION__: JSON.stringify(HONEYCOMB_VERSION),
  __HONEYCOMB_REF_DEFAULT__: JSON.stringify(HONEYCOMB_REF_DEFAULT),
  __HONEYCOMB_POSTHOG_KEY__: JSON.stringify(HONEYCOMB_POSTHOG_KEY),
  __HONEYCOMB_POSTHOG_HOST__: JSON.stringify(HONEYCOMB_POSTHOG_HOST),
};

// The tree-sitter parser stack (PRD-014 codebase graph, D-1). RESOLVED to
// `web-tree-sitter` (WASM) over native `tree-sitter` + `tree-sitter-<lang>`
// modules: WASM is deterministic, needs NO native compile/postinstall, and keeps
// the cross-platform CI matrix (ubuntu Node 22/24 + windows-smoke) green. The
// per-language grammars ship as prebuilt `.wasm` in `tree-sitter-wasms` and are
// loaded at runtime via `Language.load(<path>.wasm)` from the resolved
// node_modules path — they are DATA, not importable modules, so esbuild never
// tries to bundle them. `web-tree-sitter` itself loads its own `tree-sitter.wasm`
// emscripten runtime relative to its package dir at runtime, so it must stay
// external (esbuild cannot inline the sibling `.wasm` it `fs.readFileSync`s).
// `tree-sitter-wasms` is external too: it is consumed only as a require.resolve()
// anchor to locate the `out/*.wasm` grammar directory, never imported for code.
const TREE_SITTER_EXTERNAL = [
  "web-tree-sitter",
  "tree-sitter-wasms",
];

const NATIVE_COMPRESSION_EXTERNAL = ["node-liblzma", "@mongodb-js/zstd"];

const INFERENCE_EXTERNAL = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
];

// Daemon: the ONLY bundle that links the DeepLake access path (FR-3). It parses
// code (tree-sitter) and owns the inference-adjacent native deps, so it carries
// the full external surface.
const DAEMON_EXTERNAL = [
  "node:*",
  ...NATIVE_COMPRESSION_EXTERNAL,
  ...INFERENCE_EXTERNAL,
  ...TREE_SITTER_EXTERNAL,
];

// Harness / MCP thin clients: no native parsing or inference deps reachable —
// only node builtins are externalized. Anything else they touch is bundled in.
const THIN_CLIENT_EXTERNAL = ["node:*"];

// Embed daemon: its OWN external list (resolved open question). It loads the
// inference stack + compression natives, but not tree-sitter.
const EMBED_EXTERNAL = [
  "node:*",
  ...NATIVE_COMPRESSION_EXTERNAL,
  ...INFERENCE_EXTERNAL,
];

/** Write the ESM marker package.json beside a bundle so Node treats it as ESM. */
function stampEsm(outdir) {
  writeFileSync(`${outdir}/package.json`, ESM_PACKAGE_JSON);
}

/**
 * Stamp 0755 on an emitted file. POSIX-only effect; on win32 the mode bit is a
 * no-op (EXECUTION_LEDGER platform note) but we still call chmodSync so the
 * intent is recorded and the bit is correct when the tarball is unpacked on a
 * POSIX host.
 */
function stampExecutable(file) {
  chmodSync(file, 0o755);
}

// ---------------------------------------------------------------------------
// 1. Daemon (DeepLake-linking core; the only bundle that may carry DeepLake).
// ---------------------------------------------------------------------------
await build({
  entryPoints: { index: "dist/src/daemon/index.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "daemon",
  external: DAEMON_EXTERNAL,
  define: VERSION_DEFINE,
  // ESM-bundle require shim. A transitively-bundled CJS dependency (`yaml`, pulled
  // in by the inference-config loader `loadInferenceConfigFromYaml` that the daemon
  // assembly calls to read `agent.yaml`) performs a dynamic `require("process")`.
  // In an `format: "esm"` bundle esbuild replaces an unresolved `require` with a
  // shim that THROWS ("Dynamic require of X is not supported") — UNLESS a real
  // `require` is in scope, which the shim then uses. Define one via createRequire so
  // the bundled CJS dep loads node builtins at runtime instead of crashing the
  // daemon at startup. (In-process itests assemble the daemon directly and never hit
  // the bundle, so only the real `daemon start` path exercised this — caught by dogfood.)
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
stampEsm("daemon");

// ---------------------------------------------------------------------------
// 1a. Daemon RESTART helper -> daemon/restart-helper.js (beside the daemon entry).
//     A tiny standalone process the `POST /api/actions/restart` handler spawns: it
//     waits for the old daemon's /health to go down, then starts a fresh daemon
//     detached. Dependency-free (node builtins + global fetch), so only node:*
//     is external. Output lands in the SAME `daemon/` dir as index.js so the
//     handler resolves it via `dirname(process.argv[1])` at runtime.
// ---------------------------------------------------------------------------
await build({
  entryPoints: { "restart-helper": "dist/src/daemon/restart-helper.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "daemon",
  external: ["node:*"],
  define: VERSION_DEFINE,
});
stampExecutable("daemon/restart-helper.js");

// ---------------------------------------------------------------------------
// 1b. The viewable dashboard WEB APP (PRD-024 Wave 2, AC-1 production-clean).
//
//     The brand UI kit, recreated as a real React app, bundled for the BROWSER:
//     React + ReactDOM are bundled IN (NO unpkg/CDN React), JSX is compiled at
//     build time (NO @babel/standalone / type="text/babel") — exactly the three
//     things the kit's index.html did that D-1 forbids. The daemon host
//     (`dashboard/host.ts`) serves the produced `daemon/dashboard-app.js` as a
//     single static <script> beside the index shell.
//
//     It is compiled DIRECTLY from the .tsx source (esbuild does the TS/JSX
//     transform), not from dist/ — the web tree is browser code, not part of the
//     node dist graph. `platform: "browser"` + `format: "esm"` (the shell loads
//     it via <script type="module">). Nothing is external: a browser bundle must
//     be fully self-contained. `jsx: automatic` matches the source (no explicit
//     React import needed at every call site, though we import React anyway).
// ---------------------------------------------------------------------------
await build({
  entryPoints: { "dashboard-app": "src/dashboard/web/main.tsx" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outdir: "daemon",
  jsx: "automatic",
  define: {
    ...VERSION_DEFINE,
    "process.env.NODE_ENV": '"production"',
  },
  minify: true,
});

// ---------------------------------------------------------------------------
// 2. The five hook-protocol harnesses (claude-code, codex, cursor, hermes, pi).
//    Each is an independent thin-client bundle (FR-1). No DeepLake (FR-3).
// ---------------------------------------------------------------------------
const HOOK_HARNESSES = [
  { name: "claude-code", entry: "dist/harnesses/claude-code/src/index.js", outdir: "harnesses/claude-code/bundle", aliases: ["session-start.js", "capture.js", "pre-tool-use.js", "session-end.js"] },
  { name: "codex", entry: "dist/harnesses/codex/src/index.js", outdir: "harnesses/codex/bundle", aliases: ["session-start.js", "capture.js", "pre-tool-use.js"] },
  { name: "cursor", entry: "dist/harnesses/cursor/src/index.js", outdir: "harnesses/cursor/bundle", aliases: ["session-start.js", "capture.js", "pre-tool-use.js", "session-end.js"] },
  { name: "grok", entry: "dist/harnesses/grok/src/index.js", outdir: "harnesses/grok/bundle", aliases: ["session-start.js", "capture.js", "pre-tool-use.js"] },
  { name: "hermes", entry: "dist/harnesses/hermes/src/index.js", outdir: "harnesses/hermes/bundle" },
  { name: "pi", entry: "dist/harnesses/pi/src/index.js", outdir: "harnesses/pi/bundle" },
];

for (const h of HOOK_HARNESSES) {
  await build({
    entryPoints: { index: h.entry },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: h.outdir,
    external: THIN_CLIENT_EXTERNAL,
    define: VERSION_DEFINE,
  });
  stampExecutable(`${h.outdir}/index.js`);
  for (const alias of h.aliases ?? []) {
    copyFileSync(`${h.outdir}/index.js`, `${h.outdir}/${alias}`);
    stampExecutable(`${h.outdir}/${alias}`);
  }
  stampEsm(h.outdir);
}

// ---------------------------------------------------------------------------
// 3. OpenClaw plugin bundle (FR-6 + FR-7). Stubs node:child_process to drop
//    dead exec code (the ClawHub `dangerous-exec` rule), and rewrites every
//    process.env.HONEYCOMB_* read to globalThis.__honeycomb_tuning__.HONEYCOMB_*
//    so the bundle contains zero `process.env` substrings (the ClawHub
//    `env-harvesting` rule) while runtime tuning from openclaw.json still works.
//
//    The HONEYCOMB_* knobs below mirror what shared code may transitively read.
//    The list is the single place new tunable knobs are wired; keep it in sync
//    with `grep -rn "process.env.HONEYCOMB_" src harnesses/openclaw/src`.
// ---------------------------------------------------------------------------
const OPENCLAW_TUNING_KNOBS = [
  "HONEYCOMB_DEBUG",
  "HONEYCOMB_TRACE",
  "HONEYCOMB_QUERY_TIMEOUT_MS",
  "HONEYCOMB_STATE_DIR",
];

const openclawEnvDefine = Object.fromEntries(
  OPENCLAW_TUNING_KNOBS.map((k) => [`process.env.${k}`, `globalThis.__honeycomb_tuning__.${k}`]),
);

await build({
  entryPoints: { index: "harnesses/openclaw/src/index.ts" },
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "node",
  format: "esm",
  outdir: "harnesses/openclaw/dist",
  external: ["node:*"],
  // Guarantee globalThis.__honeycomb_tuning__ exists (as {}) before any
  // rewritten lazy env read fires. register() overlays the user's
  // openclaw.json tuning onto this object; until then reads resolve to
  // undefined and the call-site `?? fallback` applies. No optional chaining —
  // esbuild rejects it as a `define` value, matching the reference rationale.
  banner: { js: "globalThis.__honeycomb_tuning__ ??= {};" },
  define: {
    ...VERSION_DEFINE,
    ...openclawEnvDefine,
  },
  plugins: [
    {
      // Dead-code elimination for transitively bundled exec-shelling helpers.
      // OpenClaw is a pure gateway and never calls them through its entry, so
      // resolving node:child_process to a no-op namespace drops the dead exec
      // code instead of shipping unreachable exec calls that trip the ClawHub
      // `dangerous-exec` scanner rule.
      name: "stub-unused-child-process",
      setup(b) {
        b.onResolve({ filter: /^node:child_process$/ }, () => ({
          path: "node:child_process",
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents:
            "export const execSync = () => {}; export const execFileSync = () => {}; export const spawn = () => {};",
          loader: "js",
        }));
      },
    },
  ],
});
stampEsm("harnesses/openclaw/dist");
stampExecutable("harnesses/openclaw/dist/index.js");

// ---------------------------------------------------------------------------
// 4. MCP server (stdio). Thin client; Node hash-bang so it runs directly.
// ---------------------------------------------------------------------------
await build({
  entryPoints: { server: "dist/mcp/src/index.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "mcp/bundle",
  external: THIN_CLIENT_EXTERNAL,
  banner: { js: "#!/usr/bin/env node" },
  define: VERSION_DEFINE,
});
stampExecutable("mcp/bundle/server.js");
stampEsm("mcp/bundle");

// ---------------------------------------------------------------------------
// 4b. @legioncodeinc/honeycomb SDK (PRD-019e) — the fetch-only typed client + 3 framework
//     helper entry points, each a SEPARATE bundle so the core (.) stays
//     dependency-free for browser use. The core + openai entries are pure
//     fetch-only TS (no peer dep). The react + vercel entries reference their
//     peer deps (`react`, `ai`) as EXTERNAL — they are peerDependencies, never
//     bundled into the SDK, so an app's own react/ai is used at runtime and a
//     consumer that never imports those entry points pulls in neither.
//
//     The package.json#exports map points `.`/`./react`/`./vercel`/`./openai`
//     at these `sdk/*.js` outputs. Honest deferral: the SDK is constructed,
//     bundled, and tested here; publishing the SDK as its own package
//     (vs. these subpath exports of the repo) is out of scope for 019e.
// ---------------------------------------------------------------------------
const SDK_ENTRIES = [
  { entry: "dist/src/sdk/index.js", external: THIN_CLIENT_EXTERNAL },
  { entry: "dist/src/sdk/react.js", external: [...THIN_CLIENT_EXTERNAL, "react"] },
  { entry: "dist/src/sdk/vercel.js", external: [...THIN_CLIENT_EXTERNAL, "ai"] },
  { entry: "dist/src/sdk/openai.js", external: THIN_CLIENT_EXTERNAL },
];

for (const s of SDK_ENTRIES) {
  await build({
    entryPoints: [s.entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: "sdk",
    external: s.external,
    define: VERSION_DEFINE,
  });
}
stampEsm("sdk");

// ---------------------------------------------------------------------------
// 5. Unified CLI -> bundle/cli.js with a Node hash-bang + 0755 (FR-8).
// ---------------------------------------------------------------------------
await build({
  entryPoints: { cli: "dist/src/cli/index.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: [
    "node:*",
    ...NATIVE_COMPRESSION_EXTERNAL,
    ...TREE_SITTER_EXTERNAL,
  ],
  banner: { js: "#!/usr/bin/env node" },
  define: VERSION_DEFINE,
});
stampExecutable("bundle/cli.js");

// ---------------------------------------------------------------------------
// 6. Standalone embed daemon -> embeddings/ (its own external list).
// ---------------------------------------------------------------------------
await build({
  entryPoints: { "embed-daemon": "dist/embeddings/src/index.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "embeddings",
  external: EMBED_EXTERNAL,
  define: VERSION_DEFINE,
});
stampExecutable("embeddings/embed-daemon.js");

// Status to stderr (not stdout) so callers parsing `npm pack --json` (e.g.
// scripts/pack-check.mjs runs build via prepack) don't get log noise mixed
// into their JSON data pipe.
console.error(
  `Built: 1 daemon + 1 dashboard-web + ${HOOK_HARNESSES.length} hook-harness + 1 OpenClaw + 1 MCP + ${SDK_ENTRIES.length} SDK + 1 CLI + 1 embed-daemon bundle @ ${HONEYCOMB_VERSION}`,
);
