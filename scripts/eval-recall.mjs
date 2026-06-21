#!/usr/bin/env node
/**
 * The RECALL-EVAL entry — PRD-027 AC-5 (`npm run eval:recall`).
 *
 * A thin operator / CI entry that runs the recall-eval harness on the committed
 * golden set (`eval/recall-golden.json`) against a real assembled daemon + the real
 * embed daemon, and prints the per-query hit/miss table + aggregate recall@k / MRR /
 * nDCG plus the semantic-vs-lexical lift and the baseline-gate verdict. It is a thin
 * wrapper around the gated live itest (`tests/integration/recall-eval-live.itest.ts`)
 * so there is ONE source of the real code path — the script adds no scoring of its own.
 *
 * ── Gated (AC-5): REQUIRE/SKIP-with-a-message, never a silent pass ────────────
 * The eval is only meaningful against live DeepLake with embeddings ON. So:
 *   - No `HONEYCOMB_DEEPLAKE_TOKEN` → print a clear SKIP message + how to run it,
 *     exit 0 (a credential-less machine / fork never fails on it).
 *   - Embeddings explicitly OFF (`HONEYCOMB_EMBEDDINGS=false`/`0`) OR the embed daemon
 *     unreachable → print a clear SKIP message (the semantic lift can't be measured),
 *     exit 0. This is a deliberate SKIP-WITH-A-REASON, never a silent green.
 *   - Token present + embed daemon answering → run the live eval itest and exit
 *     non-zero iff the harness failed an assertion (AC-6 bar / baseline gate).
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The DeepLake token is consumed ONLY by the storage layer (read from the env); this
 * script never reads, prints, or forwards its value — it only checks for PRESENCE.
 * The golden set is purely synthetic (no secrets/PII; grep-clean — AC-7).
 *
 * Usage:  npm run eval:recall
 *         (start the embed daemon first, then load the gitignored live creds:
 *          `set -a; . ./.env.local; set +a; HONEYCOMB_EMBEDDINGS=true npm run eval:recall`)
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/recall-eval-live.itest.ts";
const RECEIPT_PREFIX = "[027 receipt]";
const DEFAULT_EMBED_URL = "http://127.0.0.1:3851";
const EMBEDDING_DIMS = 768;

/** Print a banner line so the operator sees the verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate (AC-5): no creds → clear message, exit 0. Never fail credential-less. ──
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("RECALL EVAL: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the recall eval cannot seed + query live\n" +
			"DeepLake. This is expected on a credential-less machine. To run the eval:\n" +
			"\n" +
			"    # 1. start the embed daemon (the nomic model runs on this host, PRD-025)\n" +
			"    # 2. load the gitignored live creds and run with embeddings ON\n" +
			"    set -a; . ./.env.local; set +a\n" +
			"    HONEYCOMB_EMBEDDINGS=true npm run eval:recall\n",
	);
	process.exit(0);
}

// ── Embeddings gate (AC-5): the eval measures the SEMANTIC lift, so it requires the embed
// daemon. An explicit opt-out or an unreachable daemon → SKIP-with-a-reason, exit 0. ──
const embeddingsRaw = (process.env.HONEYCOMB_EMBEDDINGS ?? "").trim().toLowerCase();
const embeddingsOff = embeddingsRaw === "false" || embeddingsRaw === "0";
if (embeddingsOff) {
	banner("RECALL EVAL: SKIPPED (embeddings explicitly disabled)");
	console.log(
		"HONEYCOMB_EMBEDDINGS is set to a disabling value, so the semantic lift the eval\n" +
			"measures cannot be exercised. Re-run with `HONEYCOMB_EMBEDDINGS=true` and the embed\n" +
			"daemon up to run the real proof.\n",
	);
	process.exit(0);
}

/** Probe the embed daemon: a real 768-dim vector back ⇒ embeddings are genuinely available. */
async function embedDaemonReachable() {
	const url = process.env.HONEYCOMB_EMBED_URL ?? DEFAULT_EMBED_URL;
	try {
		const res = await fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "probe" }),
			signal: AbortSignal.timeout(4_000),
		});
		if (!res.ok) return false;
		const body = await res.json();
		return Array.isArray(body.vector) && body.vector.length === EMBEDDING_DIMS;
	} catch {
		return false;
	}
}

const reachable = await embedDaemonReachable();
if (!reachable) {
	banner("RECALL EVAL: SKIPPED (embed daemon unreachable)");
	console.log(
		`The embed daemon did not answer at ${process.env.HONEYCOMB_EMBED_URL ?? DEFAULT_EMBED_URL}/embed\n` +
			"with a 768-dim vector, so the semantic recall path cannot run and the eval would\n" +
			"under-report. Start the embed daemon (PRD-025) and re-run. This is a SKIP, not a\n" +
			"pass — the eval was not measured.\n",
	);
	process.exit(0);
}

banner("RECALL EVAL: running the live golden-set eval (semantic vs lexical + metrics)");
console.log("Seeding the committed golden set into a per-run honeycomb_ci workspace, polling to");
console.log("embedding convergence, running recall for every query through the real engine, and");
console.log("scoring recall@k / MRR / nDCG + the semantic-beats-lexical bar...\n");

// Run the gated live eval itest. The integration config globs the integration tree; we
// point it at the single eval file. `shell:true` keeps `npx` cross-platform; the command
// line is a fixed literal (no user input interpolated).
const result = spawnSync(
	"npx",
	["vitest", "run", "--config", "vitest.integration.config.ts", ITEST],
	{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: true },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
if (stderr.trim().length > 0) process.stderr.write(stderr);

// Surface the computed metric receipts the itest logs (the real metrics, not fabricated).
const receipts = `${stdout}\n${stderr}`
	.split(/\r?\n/)
	.filter((l) => l.includes(RECEIPT_PREFIX));

const passed = result.status === 0;

if (passed) {
	banner("RECALL EVAL: PASS");
	console.log("The golden-set eval ran live: metrics emitted + semantic-ON beat lexical-only.");
	if (receipts.length > 0) {
		console.log("");
		console.log("Receipts:");
		for (const line of receipts) console.log("  " + line.slice(line.indexOf(RECEIPT_PREFIX)));
	} else {
		console.log("(metric receipt lines not found in output — see the test log above.)");
	}
	process.exit(0);
}

banner("RECALL EVAL: FAIL");
console.log("The eval did not pass. See the vitest output above for the failing assertion — a");
console.log("failure here is a real recall-quality regression (the AC-6 bar or the baseline gate),");
console.log("NOT a weakened test.");
process.exit(result.status === null ? 1 : result.status);
