#!/usr/bin/env node
// Sync the `version` field across all Honeycomb manifests from the single
// source-of-truth in the root package.json. Runs as a `prebuild` hook so
// esbuild's version-define (PRD-001b) inlines the same value into bundles.
//
// Idempotent: skips writes when a target already matches (PRD-001c FR-4).
// Logs each `old -> new` transition plus a final write/skip count (FR-5).
// Exits non-zero if any target file is missing, malformed, or if the root
// package.json has no string `version` (FR-6 / c-AC-6).
//
// Single list (FR-8 / c-AC-6): SCALAR_TARGETS + MARKETPLACE_PATH are the only
// place the synced manifests are enumerated. Adding a harness is a one-line
// change here and cannot drift from a duplicate copy.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "package.json";

// Scalar targets: each carries a single top-level `version` field tracking
// the root package.json version (PRD-001c FR-2).
export const SCALAR_TARGETS = [
  ".claude-plugin/plugin.json",
  "harnesses/claude-code/.claude-plugin/plugin.json",
  "harnesses/openclaw/openclaw.plugin.json",
  "harnesses/openclaw/package.json",
  "harnesses/codex/package.json",
];

// Marketplace target: has BOTH metadata.version AND every plugins[].version
// (PRD-001c FR-3).
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

function readJsonAt(root, relPath) {
  const full = resolve(root, relPath);
  if (!existsSync(full)) {
    throw new Error(`sync-versions: missing target ${relPath}`);
  }
  let raw;
  try {
    raw = readFileSync(full, "utf-8");
  } catch (e) {
    throw new Error(`sync-versions: cannot read ${relPath}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // FR-6 / c-AC-6: name the offending file and abort BEFORE any write so a
    // malformed manifest never produces partial output.
    throw new Error(`sync-versions: malformed JSON in ${relPath}: ${e.message}`);
  }
}

function writeJsonAt(root, relPath, obj) {
  writeFileSync(resolve(root, relPath), JSON.stringify(obj, null, 2) + "\n");
}

export function syncVersions({ root = process.cwd(), log = (m) => console.error(m) } = {}) {
  // Read + validate the source FIRST, then parse every target up front so a
  // malformed manifest aborts before any file is written (no partial write).
  const source = readJsonAt(root, SOURCE);
  const version = source.version;
  if (!version || typeof version !== "string") {
    throw new Error(`sync-versions: ${SOURCE} has no string \`version\` field`);
  }

  const scalarData = SCALAR_TARGETS.map((target) => ({ target, data: readJsonAt(root, target) }));
  const marketplace = readJsonAt(root, MARKETPLACE_PATH);

  let writes = 0;
  let skips = 0;

  for (const { target, data } of scalarData) {
    if (data.version === version) {
      log(`sync-versions: ${target} already at ${version}`);
      skips++;
      continue;
    }
    const old = data.version;
    data.version = version;
    writeJsonAt(root, target, data);
    log(`sync-versions: ${target}: ${old} -> ${version}`);
    writes++;
  }

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

  log(`sync-versions: ${writes} written, ${skips} unchanged`);
  return { writes, skips, version };
}

// Script mode — only runs when invoked directly, not when imported by tests.
const __entryUrl = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (__entryUrl) {
  try {
    syncVersions();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
