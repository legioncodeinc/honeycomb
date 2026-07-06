#!/usr/bin/env node
// Consume the PR's changeset and bump the version ON THE PR BRANCH (spec #2:
// the bump lives on the PR, not a separate commit/PR). Steps:
//   1. read the single changeset -> { bump, summary } (refuses `major`);
//   2. `npm version <bump> --no-git-tag-version` — bumps package.json + the
//      lockfile AND runs honeycomb's `version` lifecycle (sync-versions
//      propagates + stages every harness manifest) WITHOUT a commit or tag;
//   3. prepend a CHANGELOG.md entry from the summary;
//   4. delete the changeset and `git add -A`.
// The workflow makes the commit + push (with --no-verify).
//
// OUTPUT ($GITHUB_OUTPUT): new_version=X.Y.Z, bump=<patch|minor>, summary=<...>

import { execSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  appendFileSync,
} from "node:fs";

const CHANGESET_DIR = ".changeset";
const CHANGELOG = "CHANGELOG.md";

function ghOutput(key, val) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${val}\n`);
}

const file = existsSync(CHANGESET_DIR)
  ? readdirSync(CHANGESET_DIR)
      .map((n) => `${CHANGESET_DIR}/${n}`)
      .find((p) => p.endsWith(".md") && !/readme\.md$/i.test(p))
  : null;
if (!file) {
  console.error("apply-bump: no changeset to consume.");
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
const bump = (raw.match(/"[^"]+"\s*:\s*(patch|minor|major)/i) || [])[1]?.toLowerCase();
if (!["patch", "minor"].includes(bump)) {
  console.error(`apply-bump: refusing to apply bump '${bump}' (major is blocked).`);
  process.exit(1);
}
// Body after the closing frontmatter fence is the user-facing summary.
const summary = raw.split(/^---\s*$/m).pop().trim();

// Bump package.json (+ lockfile) and run the `version` lifecycle (manifest sync).
execSync(`npm version ${bump} --no-git-tag-version`, { stdio: "inherit" });
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

// Prepend a CHANGELOG entry (create the file if missing).
const date = new Date().toISOString().slice(0, 10);
const entry = `## v${version} — ${date}\n\n${summary}\n\n`;
let out;
if (existsSync(CHANGELOG)) {
  const prev = readFileSync(CHANGELOG, "utf8");
  const nl = prev.indexOf("\n");
  if (prev.startsWith("# ") && nl !== -1) {
    out = prev.slice(0, nl + 1) + "\n" + entry + prev.slice(nl + 1).replace(/^\n+/, "");
  } else {
    out = `# Changelog\n\n${entry}${prev}`;
  }
} else {
  out = `# Changelog\n\n${entry}`;
}
writeFileSync(CHANGELOG, out);

// Consume the changeset and stage everything (npm version's `version` script
// already `git add`ed the manifests; -A also catches the changeset deletion,
// package.json, the lockfile, and CHANGELOG.md).
rmSync(file);
execSync("git add -A", { stdio: "inherit" });

ghOutput("new_version", version);
ghOutput("bump", bump);
ghOutput("summary", summary);
console.log(`apply-bump: bumped to v${version} (${bump}).`);
