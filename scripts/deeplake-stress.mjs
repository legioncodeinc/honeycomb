#!/usr/bin/env node
/**
 * The DEEPLAKE-STRESS entry — PRD-034b FR-8 (`npm run deeplake:stress`).
 *
 * A thin operator / CI entry that runs the on-demand DeepLake stress harness against
 * a REAL DeepLake org and emits a METRICS REPORT (human summary to stdout + a
 * machine-readable JSON artifact to the gitignored `./.stress-report/<runId>.json`).
 * It is a thin wrapper around the gated live runner
 * (`tests/integration/deeplake-stress-live.itest.ts`) so there is ONE source of the
 * real load path — the script adds no load or scoring of its own.
 *
 * ── On-demand ONLY, never gates (b-AC-6) ─────────────────────────────────────
 * This is invoked by `npm run deeplake:stress` (locally) or the Wave-2
 * `workflow_dispatch` CI job — NEVER on push/PR, and it NEVER fails a merge. A
 * saturated backend is DATA (it lands in the report), not a broken build.
 *
 * ── Gated (FR-8): skip-safe, never a silent failure ──────────────────────────
 * The stress harness only means anything against live DeepLake. So with no
 * `HONEYCOMB_DEEPLAKE_TOKEN` set, it prints a clear message + how to run it and
 * exits 0 (a credential-less machine / fork never fails on it).
 *
 * ── Secrets (b-AC-7) ─────────────────────────────────────────────────────────
 * The DeepLake token is consumed ONLY by the storage layer (read from the env);
 * this script never reads, prints, or forwards its value — it only checks PRESENCE.
 * The emitted report carries no token / endpoint-with-creds / full org GUID (the
 * org is redacted in the report shape; the runner asserts no-secret before writing).
 *
 * ── Dials (FR-6) — env, coerce-and-clamped, reproducible via the fixed seed ──
 *   HONEYCOMB_STRESS_CONCURRENCY   CSV concurrency sweep, e.g. "1,4,8"  (default 1,4,8)
 *   HONEYCOMB_STRESS_OPS           append operations per level          (default 20)
 *   HONEYCOMB_STRESS_VERSIONS      versions seeded per key for FR-4     (default 3)
 *   HONEYCOMB_STRESS_SEED          fixed RNG seed                       (default 1234)
 *
 * Usage:  npm run deeplake:stress
 *         (load the gitignored live creds first:
 *          `set -a; . ./.env.local; set +a; npm run deeplake:stress`)
 *         Tune:  HONEYCOMB_STRESS_CONCURRENCY=1,8,16 HONEYCOMB_STRESS_OPS=50 npm run deeplake:stress
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/deeplake-stress-live.itest.ts";

/** Print a banner line so the operator sees the verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate (FR-8): no creds → clear message, exit 0. Never fail credential-less. ──
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("DEEPLAKE STRESS: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the stress harness cannot drive live\n" +
			"DeepLake. This is expected on a credential-less machine. To run it:\n" +
			"\n" +
			"    set HONEYCOMB_DEEPLAKE_* to run\n" +
			"    # load the gitignored live creds and run:\n" +
			"    set -a; . ./.env.local; set +a\n" +
			"    npm run deeplake:stress\n" +
			"\n" +
			"    # tune the dials (FR-6), e.g.:\n" +
			"    HONEYCOMB_STRESS_CONCURRENCY=1,8,16 HONEYCOMB_STRESS_OPS=50 npm run deeplake:stress\n",
	);
	process.exit(0);
}

banner("DEEPLAKE STRESS: running the on-demand load generator + metrics report");
console.log("Driving sequential append bursts, immediate read-backs, version-seeding, and");
console.log("concurrent writers through the REAL storage client against a throwaway");
console.log("ci_stress_<runId> table (DROPped on teardown), recording raw per-attempt and");
console.log("post-retry outcomes, then emitting a human summary + JSON report...\n");

// Run the gated live runner through the integration config (the same pattern as
// eval-recall.mjs). `shell:true` keeps `npx` cross-platform; the command line is a
// fixed literal (no user input interpolated — the dials travel via env, untouched here).
const result = spawnSync(
	"npx",
	["vitest", "run", "--config", "vitest.integration.config.ts", ITEST],
	{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: true },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
if (stderr.trim().length > 0) process.stderr.write(stderr);

// Surface where the JSON landed (the runner logs the path).
const reportLine = `${stdout}\n${stderr}`
	.split(/\r?\n/)
	.find((l) => l.includes("[stress] JSON report written to"));

const passed = result.status === 0;
if (passed) {
	banner("DEEPLAKE STRESS: report emitted");
	console.log("The stress harness ran live and produced a metrics report.");
	if (reportLine) console.log(`  ${reportLine.trim()}`);
	console.log("\nThis is a DIAGNOSTIC, not a gate — a saturated backend is captured AS DATA in");
	console.log("the report (latency percentiles, error-by-status, convergence time, throughput).");
	process.exit(0);
}

// A non-zero exit here means the RUNNER itself failed (e.g. a config/connection
// error), not "the backend was slow" — the harness records slowness as data. Surface
// it but keep the message honest: this is still on-demand only and never a merge gate.
banner("DEEPLAKE STRESS: runner error");
console.log("The stress runner did not complete. See the vitest output above. Note: a slow or");
console.log("erroring backend is recorded IN the report, not a runner failure — a non-zero exit");
console.log("here is a harness/connection problem, not a merge-blocking signal (this never gates).");
process.exit(result.status === null ? 1 : result.status);
