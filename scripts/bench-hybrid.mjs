#!/usr/bin/env node
/**
 * The NATIVE-HYBRID BENCHMARK entry — PRD-045 W0 (`npm run bench:hybrid`).
 *
 * A thin operator entry that runs the live A/B of DeepLake's native
 * `deeplake_hybrid_record` operator against the post-query RRF the live engine ships,
 * on the committed golden set (`eval/recall-golden.json`) — and prints recall@k / MRR /
 * nDCG for BOTH paths plus the delta. It is a thin wrapper around the gated live itest
 * (`tests/integration/hybrid-benchmark-live.itest.ts`) so there is ONE source of the
 * real code path; the script adds no scoring of its own and asserts no winner.
 *
 * Mirrors `scripts/eval-recall.mjs` exactly on gating (the only honest way to run an
 * A/B is against live DeepLake with the embed daemon up):
 *   - No `HONEYCOMB_DEEPLAKE_TOKEN` → clear SKIP message + how to run it, exit 0.
 *   - Embeddings OFF or the embed daemon unreachable → SKIP-with-a-reason, exit 0.
 *   - Token present + embed daemon answering → run the itest; exit non-zero only if the
 *     harness failed to RUN (a real wiring break), never because one fusion lost the A/B.
 *
 * Sweep the weights without a code change (only the RATIO matters):
 *   HONEYCOMB_HYBRID_VECTOR_WEIGHT=0.7 HONEYCOMB_HYBRID_TEXT_WEIGHT=0.3 npm run bench:hybrid
 *
 * The DeepLake token is consumed ONLY by the storage layer; this script checks PRESENCE
 * and never reads/prints/forwards it. The golden set is purely synthetic.
 */

import { spawnSync } from "node:child_process";

const ITEST = "tests/integration/hybrid-benchmark-live.itest.ts";
const RECEIPT_PREFIX = "[045 receipt]";
const DEFAULT_EMBED_URL = "http://127.0.0.1:3851";
const EMBEDDING_DIMS = 768;

function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Token gate: no creds → clear message, exit 0. Never fail credential-less. ──
if (!process.env.HONEYCOMB_DEEPLAKE_TOKEN) {
	banner("HYBRID BENCHMARK: SKIPPED (no live credentials)");
	console.log(
		"No HONEYCOMB_DEEPLAKE_TOKEN is set, so the A/B cannot seed + query live DeepLake.\n" +
			"This is expected on a credential-less machine. To run the benchmark:\n" +
			"\n" +
			"    # 1. start the embed daemon (the nomic model runs on this host, PRD-025)\n" +
			"    # 2. load the gitignored live creds and run with embeddings ON\n" +
			"    set -a; . ./.env.local; set +a\n" +
			"    HONEYCOMB_EMBEDDINGS=true npm run bench:hybrid\n",
	);
	process.exit(0);
}

// ── Embeddings gate: the native operator needs a vector, so it requires the embed daemon. ──
const embeddingsRaw = (process.env.HONEYCOMB_EMBEDDINGS ?? "").trim().toLowerCase();
if (embeddingsRaw === "false" || embeddingsRaw === "0") {
	banner("HYBRID BENCHMARK: SKIPPED (embeddings explicitly disabled)");
	console.log(
		"HONEYCOMB_EMBEDDINGS is set to a disabling value, so the native hybrid operator (which\n" +
			"needs a query vector) cannot run. Re-run with `HONEYCOMB_EMBEDDINGS=true` and the embed\n" +
			"daemon up.\n",
	);
	process.exit(0);
}

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

if (!(await embedDaemonReachable())) {
	banner("HYBRID BENCHMARK: SKIPPED (embed daemon unreachable)");
	console.log(
		`The embed daemon did not answer at ${process.env.HONEYCOMB_EMBED_URL ?? DEFAULT_EMBED_URL}/embed\n` +
			"with a 768-dim vector, so the native hybrid path cannot run. Start the embed daemon\n" +
			"(PRD-025) and re-run. This is a SKIP, not a pass — nothing was measured.\n",
	);
	process.exit(0);
}

banner("HYBRID BENCHMARK: running the live A/B (native deeplake_hybrid_record vs post-query RRF)");
console.log("Seeding the committed golden set into the honeycomb_ci workspace, polling to embedding");
console.log("convergence, and scoring recall@k / MRR / nDCG for BOTH recall paths on the same warm store...\n");

const result = spawnSync(
	"npx",
	["vitest", "run", "--config", "vitest.integration.config.ts", ITEST],
	{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: true },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
if (stderr.trim().length > 0) process.stderr.write(stderr);

const receipts = `${stdout}\n${stderr}`.split(/\r?\n/).filter((l) => l.includes(RECEIPT_PREFIX));

if (result.status === 0) {
	banner("HYBRID BENCHMARK: COMPLETE");
	console.log("Both recall paths ran on the golden set. Compare the receipts below and decide adoption:");
	if (receipts.length > 0) {
		console.log("");
		for (const line of receipts) console.log("  " + line.slice(line.indexOf(RECEIPT_PREFIX)));
	} else {
		console.log("(metric receipt lines not found in output — see the test log above.)");
	}
	process.exit(0);
}

banner("HYBRID BENCHMARK: FAILED TO RUN");
console.log("The benchmark did not complete — see the vitest output above. A failure here means the A/B");
console.log("HARNESS broke (a wiring/convergence error), NOT that one fusion lost; the benchmark never");
console.log("asserts a winner.");
process.exit(result.status === null ? 1 : result.status);
