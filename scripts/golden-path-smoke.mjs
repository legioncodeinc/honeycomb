#!/usr/bin/env node
/**
 * The GOLDEN-PATH SMOKE — PRD-021f f-AC-5.
 *
 * A thin operator / CI entry that drives the SAME real capture → summary →
 * cross-session-recall → dashboard/logs pass against a live daemon and prints a
 * human-readable PASS/FAIL summary plus the recall hit. It is intentionally a thin
 * wrapper around the proven golden-path live itest (`tests/integration/
 * golden-path-live.itest.ts`) so there is ONE source of the real code path — the
 * smoke adds no business logic of its own, it just runs the proof and reports.
 *
 * ── Token-gated (f-AC-5) ─────────────────────────────────────────────────────
 * With no `HONEYCOMB_DEEPLAKE_TOKEN`, the smoke prints a clear message and EXITS 0
 * (a credential-less machine or a fork never fails on it) — the underlying itest
 * `describe.skipIf`s for the same reason. With a token, it runs the live itest and
 * exits non-zero iff the proof failed.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The token is consumed ONLY by the storage layer (read from the environment); this
 * script never reads, prints, or forwards its value. It only checks for PRESENCE.
 *
 * Usage:  npm run smoke:golden-path
 *         (export the live creds first, e.g. `set -a; . ./.env.local; set +a`)
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/golden-path-live.itest.ts";
const RECEIPT_PREFIX = "[021f receipt]";

/** Print a banner line so the operator sees the smoke's verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate (f-AC-5): no creds → clear message, exit 0. Never fail credential-less.
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("GOLDEN-PATH SMOKE: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the golden path cannot run against live\n" +
			"DeepLake. This is expected on a credential-less machine. To run the proof:\n" +
			"\n" +
			"    set -a; . ./.env.local; set +a   # load the gitignored live creds\n" +
			"    npm run smoke:golden-path\n",
	);
	process.exit(0);
}

banner("GOLDEN-PATH SMOKE: running the live capture → summary → cross-session recall proof");
console.log("Booting a real assembled daemon against live DeepLake and driving the production");
console.log("capture / summary / recall / dashboard / logs code paths in one pass...\n");

// Run the proven live itest. The integration config globs `tests/integration/**/*.itest.ts`;
// we point it at the single golden-path file so the smoke runs JUST the end-to-end proof.
// `npm` on Windows is `npm.cmd`; spawnSync with shell:true keeps it cross-platform (the
// command line is a fixed literal — no user input is interpolated).
const result = spawnSync(
	"npx",
	["vitest", "run", "--config", "vitest.integration.config.ts", ITEST],
	{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: true },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
if (stderr.trim().length > 0) process.stderr.write(stderr);

// Surface the computed recall-hit receipt the itest logs (the real metric, not fabricated).
const receiptLine = `${stdout}\n${stderr}`
	.split(/\r?\n/)
	.find((l) => l.includes(RECEIPT_PREFIX));

const passed = result.status === 0;

if (passed) {
	banner("GOLDEN-PATH SMOKE: PASS");
	console.log("Capture → summary → CROSS-SESSION RECALL → dashboard/logs all proven live.");
	if (receiptLine) {
		console.log("");
		console.log("Receipt:");
		console.log("  " + receiptLine.slice(receiptLine.indexOf(RECEIPT_PREFIX)));
	} else {
		console.log("(recall-hit receipt line not found in output — see the test log above.)");
	}
	process.exit(0);
}

banner("GOLDEN-PATH SMOKE: FAIL");
console.log("The end-to-end proof did not complete. See the vitest output above for the");
console.log("failing assertion (it is NOT weakened — a failure here is a real integration bug).");
process.exit(result.status === null ? 1 : result.status);
