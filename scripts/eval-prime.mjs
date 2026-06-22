#!/usr/bin/env node
/**
 * The PRIME-EVAL entry — PRD-046f (`npm run eval:prime`).
 *
 * A thin operator / CI entry that runs the prime-eval harness on the committed
 * scenario set (`eval/prime-golden.json`) against a real assembled daemon + live
 * DeepLake, and prints the per-scenario pull-through / blind-search table + the
 * aggregate signals plus the primed-vs-cold verdict and the baseline-gate result.
 * It is a thin wrapper around the gated live itest
 * (`tests/integration/prime-eval-live.itest.ts`) so there is ONE source of the real
 * code path — the script adds no scoring of its own.
 *
 * ── Gated (f-AC-5): REQUIRE/SKIP-with-a-message, never a silent pass ──────────
 * The eval is only meaningful against live DeepLake (it seeds + assembles a real
 * prime digest). So:
 *   - No `HONEYCOMB_DEEPLAKE_TOKEN` → print a clear SKIP message + how to run it,
 *     exit 0 (a credential-less machine / fork never fails on it).
 *   - Token present → run the live eval itest and exit non-zero iff the harness
 *     failed an assertion (the f-AC-3 primed-beats-cold bar / the baseline gate).
 *
 * The embed daemon is OPTIONAL here: the prime read is a PURE SQL skim (no `<#>`,
 * c-AC-5), so PULL-THROUGH is measured without embeddings. Embeddings only sharpen
 * the COLD blind-search reachability check; with them OFF the cold side uses the
 * BM25/ILIKE lexical floor. Either way the eval runs — so there is no embeddings
 * gate (unlike eval:recall, which measures the semantic lift and requires it).
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The DeepLake token is consumed ONLY by the storage layer (read from the env); this
 * script never reads, prints, or forwards its value — it only checks for PRESENCE.
 * The scenario set is purely synthetic (no secrets/PII; grep-clean — f-AC-5).
 *
 * Usage:  npm run eval:prime
 *         (load the gitignored live creds; the embed daemon is optional but sharpens
 *          the cold side: `set -a; . ./.env.local; set +a; npm run eval:prime`)
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/prime-eval-live.itest.ts";
const RECEIPT_PREFIX = "[046f receipt]";

/** Print a banner line so the operator sees the verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate (f-AC-5): no creds → clear message, exit 0. Never fail credential-less. ──
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("PRIME EVAL: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the prime eval cannot seed + assemble a live\n" +
			"prime digest. This is expected on a credential-less machine. To run the eval:\n" +
			"\n" +
			"    # load the gitignored live creds and run (the embed daemon is OPTIONAL —\n" +
			"    # the prime read is pure SQL; embeddings only sharpen the cold side)\n" +
			"    set -a; . ./.env.local; set +a\n" +
			"    npm run eval:prime\n",
	);
	process.exit(0);
}

banner("PRIME EVAL: running the live scenario-set eval (primed vs cold + signals)");
console.log("Seeding the committed prime scenarios into a per-run honeycomb_ci workspace, polling to");
console.log("convergence, assembling the REAL prime digest, and scoring pull-through + redundant-search");
console.log("reduction primed-vs-cold + the baseline gate...\n");

// Run the gated live eval itest. The integration config globs the integration tree; we point it at
// the single eval file. `shell:true` keeps `npx` cross-platform; the command line is a fixed literal.
const result = spawnSync(
	"npx",
	["vitest", "run", "--config", "vitest.integration.config.ts", ITEST],
	{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: true },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
if (stderr.trim().length > 0) process.stderr.write(stderr);

// Surface the computed signal receipts the itest logs (the real numbers, not fabricated).
const receipts = `${stdout}\n${stderr}`
	.split(/\r?\n/)
	.filter((l) => l.includes(RECEIPT_PREFIX));

const passed = result.status === 0;

if (passed) {
	banner("PRIME EVAL: PASS");
	console.log("The scenario-set eval ran live: signals emitted + priming beat a cold start.");
	if (receipts.length > 0) {
		console.log("");
		console.log("Receipts:");
		for (const line of receipts) console.log("  " + line.slice(line.indexOf(RECEIPT_PREFIX)));
	} else {
		console.log("(signal receipt lines not found in output — see the test log above.)");
	}
	process.exit(0);
}

banner("PRIME EVAL: FAIL");
console.log("The eval did not pass. See the vitest output above for the failing assertion — a failure");
console.log("here is a real priming regression (the f-AC-3 primed-beats-cold bar or the baseline gate),");
console.log("NOT a weakened test.");
process.exit(result.status === null ? 1 : result.status);
