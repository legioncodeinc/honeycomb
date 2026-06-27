#!/usr/bin/env node
// HiveDoctor's publish gate (PRD-063 INT-2), the package-local analogue of the
// repo-root scripts/pack-check.mjs. Refuse a publish if `npm pack` would include
// filenames that must never ship - credentials, CI workflows, git internals, key
// material - and refuse a publish that DROPS the one required runtime file (the
// `hivedoctor` bin). Catches a future PR widening package.json's `files` array
// (or switching to a permissive .npmignore) BEFORE any token is touched.
//
// This is the same ci-release-stinger hard rule the parent enforces (#4/#5: what
// ships is the files allowlist, and secrets must never reach the tarball), scoped
// to this independent package so the second-global publish surface gets the same
// fail-closed discipline.

import { execFileSync, execSync } from "node:child_process";

// On Windows the npm entry point is npm.cmd, which execFileSync cannot launch
// directly. The command line is a fixed literal (no user input), so a plain
// shell exec is safe and keeps the script cross-platform (the dev host is
// Windows; the CI matrix runs this on windows-latest too).
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
	console.error("Refusing to publish - forbidden filenames in tarball:");
	for (const h of hits) console.error("  " + h);
	process.exit(1);
}

// Belt-and-suspenders against shipping the SOURCE tree: HiveDoctor's runtime is
// the single bundled bin. A `files` allowlist that accidentally globbed in
// `src/` or `tests/` would bloat the tarball and leak un-minified source; the
// package ships ONLY bundle/ + README + LICENSE. Refuse if any src/ or tests/
// path slipped into the tarball.
const SOURCE_LEAK = [/(^|\/)src\//, /(^|\/)tests\//, /(^|\/)dist\//, /(^|\/)node_modules\//];
const leaks = entries.filter((p) => SOURCE_LEAK.some((rx) => rx.test(p)));
if (leaks.length) {
	console.error("Refusing to publish - source/test/dist files leaked into tarball:");
	for (const l of leaks) console.error("  " + l);
	console.error("  (tighten package.json's `files` allowlist - only bundle/ + README + LICENSE should ship)");
	process.exit(1);
}

// Required runtime file: a publish that DROPS the `hivedoctor` bin from the
// `files` allowlist ships a broken package (the `bin` field points at
// `bundle/cli.js`; an install missing it cannot run `hivedoctor`). This positive
// check catches that regression, which the forbidden-only scan above cannot.
const REQUIRED = [
	/(^|\/)bundle\/cli\.js$/, // the `hivedoctor` bin (package.json#bin target)
];
const missing = REQUIRED.filter((rx) => !entries.some((p) => rx.test(p)));
if (missing.length) {
	console.error("Refusing to publish - required runtime files missing from tarball:");
	for (const m of missing) console.error("  " + String(m));
	console.error("  (run `npm run build` and widen package.json's `files` allowlist - the install would be broken)");
	process.exit(1);
}

console.log(
	`pack-check OK - ${entries.length} files, no forbidden patterns, no source leak, bin present`,
);
