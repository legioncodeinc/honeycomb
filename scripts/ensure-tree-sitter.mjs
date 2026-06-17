#!/usr/bin/env node
// Ensures the native tree-sitter bindings are loadable on this platform / Node
// ABI (PRD-001b implementation note; ci-release-stinger hard rule #7: native
// deps self-heal on install).
//
// Why this exists: tree-sitter@0.21.x ships no linux-arm64 prebuild, and
// tree-sitter-typescript@0.23.x ships a mislabeled (x86-64) one. On linux-arm64
// both must compile from source, and under Node >=22 that compile requires
// C++20 (tree-sitter@0.21's binding.gyp does not request it). tree-sitter is
// declared as an optionalDependency so the expected arm64 build failure does
// not abort `npm install`; this script then heals it afterwards.
//
// Greenfield-safe (this skeleton has NO tree-sitter deps yet): if the grammars
// are absent it logs and exits 0 — it never hard-fails the install. On Windows
// it is also non-fatal: no toolchain assumptions, no CXXFLAGS, log-and-continue.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(`${ROOT}/`);
const PKGS = [
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
];

// Greenfield short-circuit: if tree-sitter is not even declared/installed yet
// (the PRD-001 skeleton has no grammar deps), there is nothing to heal. Log and
// exit 0 so `npm install` / `npm run rebuild:native` never breaks.
if (!existsSync(`${ROOT}/node_modules/tree-sitter/package.json`)) {
  console.error(
    "[ensure-tree-sitter] no tree-sitter packages installed — nothing to heal (skeleton). Skipping.",
  );
  process.exit(0);
}

function bindingsLoad() {
  try {
    const Parser = require("tree-sitter");
    const langs = [
      require("tree-sitter-typescript").typescript,
      require("tree-sitter-javascript"),
      require("tree-sitter-python"),
      require("tree-sitter-go"),
      require("tree-sitter-rust"),
      require("tree-sitter-java"),
      require("tree-sitter-ruby"),
      require("tree-sitter-c"),
      require("tree-sitter-cpp"),
    ];
    for (const lang of langs) {
      const p = new Parser();
      p.setLanguage(lang);
      p.parse("x");
    }
    return true;
  } catch {
    return false;
  }
}

if (process.env.ENSURE_TS_RUNNING) process.exit(0); // recursion guard for nested npm calls
if (bindingsLoad()) process.exit(0); // healthy prebuild / prior build -> nothing to do

console.error(
  "[ensure-tree-sitter] native bindings not loadable on this platform — building from source...",
);

const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const declared = { ...pkg.dependencies, ...pkg.optionalDependencies };

const env = { ...process.env, ENSURE_TS_RUNNING: "1" };
if (process.platform !== "win32") {
  // Node >=22 V8 headers require C++20; tree-sitter@0.21's binding.gyp doesn't request it.
  env.CXXFLAGS = `${process.env.CXXFLAGS ?? ""} -std=c++20`.trim();
}
const run = (cmd) => execSync(cmd, { stdio: "inherit", env, cwd: ROOT });

try {
  // 1. Re-fetch any package npm dropped — a failed optional dependency is
  //    removed from node_modules. --ignore-scripts: fetch only.
  const missing = PKGS.filter((n) => !existsSync(`${ROOT}/node_modules/${n}/package.json`));
  if (missing.length) {
    const specs = missing.map((n) => `${n}@${declared[n] ?? "latest"}`);
    run(`npm install ${specs.join(" ")} --no-save --ignore-scripts`);
  }

  // 2. Force a from-source compile. node-gyp-build loads build/Release ahead of
  //    prebuilds, so removing the (absent/wrong-arch) prebuilds + stale build
  //    guarantees the correct local binary wins.
  for (const n of PKGS) {
    rmSync(`${ROOT}/node_modules/${n}/prebuilds`, { recursive: true, force: true });
    rmSync(`${ROOT}/node_modules/${n}/build`, { recursive: true, force: true });
  }
  run(`npm rebuild ${PKGS.join(" ")}`);
} catch (err) {
  console.error("[ensure-tree-sitter] rebuild command failed:", err.message);
}

if (bindingsLoad()) {
  console.error("[ensure-tree-sitter] OK — bindings compiled from source and loadable.");
  process.exit(0);
}

// Strict mode (opt-in via HONEYCOMB_STRICT_POSTINSTALL=1 — set by CI) turns the
// warning into a hard failure so a heal miss surfaces as a red check rather
// than re-emerging as `tsc: Cannot find module 'tree-sitter'`. Default stays
// non-fatal so end-user consumers never get a hard install break.
const strict = process.env.HONEYCOMB_STRICT_POSTINSTALL === "1";
console.error(
  "[ensure-tree-sitter] WARNING: tree-sitter bindings still unavailable. " +
    "Install a C/C++ toolchain and re-run `npm run rebuild:native`." +
    (strict ? " (strict mode — failing this install)" : " (non-fatal)"),
);
process.exit(strict ? 1 : 0);
