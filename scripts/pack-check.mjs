#!/usr/bin/env node
// Refuse a publish if `npm pack` would include filenames that should never
// ship to npm — credentials, CI workflows, git internals, key material.
// Catches a future PR widening package.json's `files` array (or switching to a
// permissive .npmignore) BEFORE any token is touched. This is the publish gate
// (ci-release-stinger hard rule #4/#5): what ships is the files allowlist, and
// secrets must never reach the tarball.

import { execFileSync, execSync } from "node:child_process";

// On Windows the npm entry point is npm.cmd, which execFileSync cannot launch
// directly. The command line is a fixed literal (no user input), so a plain
// shell exec is safe and keeps the script cross-platform (EXECUTION_LEDGER:
// Windows/PowerShell dev host).
const PACK_ARGS = ["pack", "--dry-run", "--json"];

const FORBIDDEN = [
  /(^|\/)\.npmrc$/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)secrets?(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  // Private-key / credential material: never belongs in a published tarball.
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)credentials\.json$/,
];

const raw =
  process.platform === "win32"
    ? execSync(`npm ${PACK_ARGS.join(" ")}`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    : execFileSync("npm", PACK_ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const entries = JSON.parse(raw)[0].files.map((f) => f.path);
const hits = entries.filter((p) => FORBIDDEN.some((rx) => rx.test(p)));

if (hits.length) {
  console.error("Refusing to publish — forbidden filenames in tarball:");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log(`pack-check OK — ${entries.length} files, no forbidden patterns`);
