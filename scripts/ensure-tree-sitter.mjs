#!/usr/bin/env node
// Confirms the tree-sitter WASM parser stack is present and loadable after install
// (PRD-014 codebase graph, D-1). This script HEALS NOTHING and COMPILES NOTHING:
// the parser is `web-tree-sitter` (a WASM/emscripten runtime) + `tree-sitter-wasms`
// (prebuilt `.wasm` grammars), so there is no native binding to build, no node-gyp,
// no C/C++ toolchain, and no per-platform/per-ABI compile. That is the whole point
// of choosing WASM over native `tree-sitter` + `tree-sitter-<lang>`: the install is
// deterministic and identical across the CI matrix (ubuntu Node 22/24 + windows-smoke),
// with no postinstall compile that could break Windows or linux-arm64.
//
// Why this file still exists (and stays in the `files` allowlist + `postinstall`):
//   1. Backwards-compatible name — the build script + CI reference `rebuild:native`
//      and `postinstall` by this path; keeping it avoids churn in those surfaces.
//   2. A fast, non-fatal SANITY check: if a consumer's install dropped a grammar
//      `.wasm` (a partial extract, a pruned `node_modules`), we say so clearly
//      rather than letting the daemon fail later with an opaque WASM load error.
//
// It ALWAYS exits 0 (unless explicitly run in strict CI mode and a grammar is
// genuinely missing): an end-user consumer must never get a hard install break from
// this hook.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(`${ROOT}/`);

// Recursion guard for nested npm calls (kept for parity with prior behaviour).
if (process.env.ENSURE_TS_RUNNING) process.exit(0);

// The nine PRD-014 languages map to these grammar `.wasm` files (TS routes both
// `tree-sitter-typescript` and `tree-sitter-tsx`). Located by resolving the
// `tree-sitter-wasms` package and reading its `out/` directory — the SAME anchor
// the runtime extractor uses (`src/daemon/runtime/codebase/extract.ts`).
const GRAMMARS = [
  "tree-sitter-typescript",
  "tree-sitter-tsx",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-rust",
  "tree-sitter-java",
  "tree-sitter-ruby",
  "tree-sitter-c",
  "tree-sitter-cpp",
];

// Greenfield / not-yet-installed short-circuit: if the parser deps are not present
// (a checkout before `npm install`, or a slimmed environment), there is nothing to
// check. Log and exit 0 so `npm install` / `npm run rebuild:native` never breaks.
let wasmDir;
try {
  wasmDir = require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");
} catch {
  console.error(
    "[ensure-tree-sitter] web-tree-sitter / tree-sitter-wasms not installed yet — nothing to check. Skipping.",
  );
  process.exit(0);
}

// Confirm the web-tree-sitter runtime resolves too (it carries its own
// `tree-sitter.wasm` emscripten runtime loaded at parse time).
let runtimeOk = true;
try {
  require.resolve("web-tree-sitter");
} catch {
  runtimeOk = false;
}

const missing = GRAMMARS.filter((g) => !existsSync(`${wasmDir}${g}.wasm`));

if (runtimeOk && missing.length === 0) {
  console.error(
    `[ensure-tree-sitter] OK — web-tree-sitter runtime + ${GRAMMARS.length} WASM grammars present (no native build needed).`,
  );
  process.exit(0);
}

// Something is missing. In strict CI mode (HONEYCOMB_STRICT_POSTINSTALL=1) this is a
// hard failure so a partial install surfaces as a red check; otherwise it is a
// non-fatal warning so an end-user install never breaks.
const strict = process.env.HONEYCOMB_STRICT_POSTINSTALL === "1";
console.error(
  "[ensure-tree-sitter] WARNING: tree-sitter WASM stack incomplete — " +
    (runtimeOk ? "" : "web-tree-sitter runtime not resolvable; ") +
    (missing.length ? `missing grammars: ${missing.join(", ")}. ` : "") +
    "Re-run `npm install` to restore the parser deps." +
    (strict ? " (strict mode — failing this install)" : " (non-fatal)"),
);
process.exit(strict ? 1 : 0);
