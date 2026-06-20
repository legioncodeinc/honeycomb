#!/usr/bin/env node
/**
 * The DATA-ACCESS DOGFOOD SMOKE — PRD-022e e-AC-6 / FR-6.
 *
 * A thin operator / CI entry that drives the SAME real capture→recall-THROUGH-HTTP
 * proof — the index AC-1 trifecta (CLI + SDK + MCP all recall a captured turn through
 * `/api/memories/recall`), the remember→recall-over-HTTP loop (e-AC-4), and the rest of
 * the wired surface answering (e-AC-5) — against a live assembled daemon, and prints a
 * human-readable PASS/FAIL summary plus the receipts. It is intentionally a thin wrapper
 * around the proven dogfood live itest (`tests/integration/dogfood-acceptance-live.itest.ts`)
 * so there is ONE source of the real code path — the smoke adds no business logic of its
 * own, it just runs the proof and reports.
 *
 * ── Token-gated (e-AC-6) ─────────────────────────────────────────────────────
 * With no `HONEYCOMB_DEEPLAKE_TOKEN`, the smoke prints a clear message and EXITS 0
 * (a credential-less machine or a fork never fails on it) — the underlying itest
 * `describe.skipIf`s for the same reason. With a token, it runs the live itest and
 * exits non-zero iff the proof failed.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The token is consumed ONLY by the storage layer (read from the environment); this
 * script never reads, prints, or forwards its value. It only checks for PRESENCE.
 *
 * Usage:  npm run smoke:data-api
 *         (export the live creds first, e.g. `set -a; . ./.env.local; set +a`)
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/dogfood-acceptance-live.itest.ts";
const RECEIPT_PREFIX = "[022e receipt]";

/** Print a banner line so the operator sees the smoke's verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate (e-AC-6): no creds → clear message, exit 0. Never fail credential-less.
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("DATA-ACCESS DOGFOOD SMOKE: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the dogfood cannot run against live\n" +
			"DeepLake. This is expected on a credential-less machine. To run the proof:\n" +
			"\n" +
			"    set -a; . ./.env.local; set +a   # load the gitignored live creds\n" +
			"    npm run smoke:data-api\n",
	);
	process.exit(0);
}

banner("DATA-ACCESS DOGFOOD SMOKE: recall THROUGH /api/memories/recall by the CLI, SDK, and MCP");
console.log("Booting a real assembled daemon against live DeepLake and driving capture→recall-over-HTTP");
console.log("by all three clients, the remember→recall loop, and the rest of the wired surface...\n");

// Run the proven live itest. The integration config globs `tests/integration/**/*.itest.ts`;
// we point it at the single dogfood file so the smoke runs JUST the acceptance proof.
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

// Surface the receipts the itest logs (the real proof lines, not fabricated).
const receiptLines = `${stdout}\n${stderr}`
	.split(/\r?\n/)
	.filter((l) => l.includes(RECEIPT_PREFIX));

const passed = result.status === 0;

if (passed) {
	banner("DATA-ACCESS DOGFOOD SMOKE: PASS");
	console.log("Recall THROUGH /api/memories/recall by the CLI, SDK, AND MCP — plus remember→recall");
	console.log("over HTTP and the wired VFS + product-data surface — all proven live.");
	if (receiptLines.length > 0) {
		console.log("");
		console.log("Receipts:");
		for (const line of receiptLines) {
			console.log("  " + line.slice(line.indexOf(RECEIPT_PREFIX)));
		}
	} else {
		console.log("(receipt lines not found in output — see the test log above.)");
	}
	process.exit(0);
}

banner("DATA-ACCESS DOGFOOD SMOKE: FAIL");
console.log("The end-to-end proof did not complete. See the vitest output above for the");
console.log("failing assertion (it is NOT weakened — a failure here is a real integration bug).");
process.exit(result.status === null ? 1 : result.status);
