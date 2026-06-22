/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ON-DEMAND DEEPLAKE STRESS RUN — OPT-IN, MUTATES A REAL BACKEND.          ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-034b. This is NOT a pass/fail gate — it is the DIAGNOSTIC RUNNER that ║
 * ║  drives the stress harness against a real DeepLake org and EMITS A METRICS ║
 * ║  REPORT (human summary to stdout + machine-readable JSON to the gitignored ║
 * ║  ./.stress-report/<runId>.json). It is invoked by `npm run deeplake:stress`║
 * ║  (scripts/deeplake-stress.mjs) and the Wave-2 `workflow_dispatch` job — it  ║
 * ║  is NEVER part of `npm run test` / `npm run ci` (it lives under            ║
 * ║  tests/integration with the `.itest.ts` suffix, run ONLY by the            ║
 * ║  integration config) and it NEVER runs on push/PR (b-AC-6).               ║
 * ║                                                                          ║
 * ║  GATED: the single describe block is `describe.skipIf(!TOKEN)` so with no  ║
 * ║  HONEYCOMB_DEEPLAKE_TOKEN the run SKIPS and exits 0 (skip-safe).          ║
 * ║                                                                          ║
 * ║  ISOLATION (b-AC-1, do not weaken): every table is the throwaway          ║
 * ║  `ci_stress_<runId>_*` under a namespaced workspace (default              ║
 * ║  `honeycomb_ci`); the harness DROPs every table it created on teardown.   ║
 * ║                                                                          ║
 * ║  SECRETS (b-AC-7, do not weaken): the token is read ONLY by the storage    ║
 * ║  layer from the env. The report carries NO token / endpoint-with-creds /   ║
 * ║  full org GUID — the org is `redactToken`-ed in the report shape.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The METRIC MATH is unit-tested deterministically (tests/eval/deeplake-stress*.test.ts);
 * this file is the LIVE close-out proof (D-5): it drives the real load and writes the
 * artifact a maintainer brings to the vendor. The dials come from env (FR-6):
 *   HONEYCOMB_STRESS_CONCURRENCY (CSV, e.g. "1,4,8"), HONEYCOMB_STRESS_OPS,
 *   HONEYCOMB_STRESS_VERSIONS, HONEYCOMB_STRESS_SEED — all coerce-and-clamped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { healTargetFor } from "../../src/daemon/storage/catalog/index.js";
import {
	createStorageClient,
	envCredentialProvider,
	resolveStorageConfig,
} from "../../src/daemon/storage/index.js";
import { HttpDeepLakeTransport } from "../../src/daemon/storage/transport.js";
import {
	RecordingTransport,
	renderStressSummary,
	resolveStressConfig,
	runStress,
	type StressReport,
} from "../../src/eval/deeplake-stress.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A unique run id — env-derived in CI, hrtime fallback locally (matches deeplake-live). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

/** The gitignored report dir (b-AC-6/FR-7). Overridable so a test/CI can redirect it. */
function reportDir(): string {
	return process.env.HONEYCOMB_STRESS_REPORT_DIR ?? join(process.cwd(), ".stress-report");
}

describe.skipIf(!HAS_TOKEN)("on-demand DeepLake stress run (opt-in, real backend)", () => {
	const created: string[] = [];

	afterAll(() => {
		// The harness DROPs its own tables; nothing extra to clean here. The list is
		// kept only so a leftover (failed DROP) is identifiable by its namespaced prefix.
		if (created.length > 0) {
			process.stdout.write(`[stress] tables this run touched: ${created.join(", ")}\n`);
		}
	});

	it("drives the configured load, DROPs throwaway tables, and emits a metrics report", async () => {
		// Resolve config from the SAME env provider the daemon uses, defaulting the
		// workspace to the namespaced honeycomb_ci so a bare token never targets prod.
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
			}),
		};
		const config = resolveStorageConfig(provider);
		const scope = { org: config.org, workspace: config.workspace };

		// Build the live client with the RECORDING transport injected so every raw
		// per-attempt outcome is captured (the backend's true error rate).
		const recorder = new RecordingTransport(new HttpDeepLakeTransport(config.endpoint, config.token));
		const client = createStorageClient({ provider, transport: recorder });

		// Dials from env (FR-6), coerce-and-clamped + reproducible via the fixed seed.
		const stressConfig = resolveStressConfig({
			concurrency: process.env.HONEYCOMB_STRESS_CONCURRENCY,
			operations: process.env.HONEYCOMB_STRESS_OPS,
			versionsPerKey: process.env.HONEYCOMB_STRESS_VERSIONS,
			seed: process.env.HONEYCOMB_STRESS_SEED,
		});

		// The throwaway table borrows the memories ColumnDefs + a version column for the
		// version-bumped write pattern (mirrors deeplake-live.itest's `versioned` shape).
		const columns = [
			...healTargetFor("memories").columns,
			{ name: "version", sql: "BIGINT NOT NULL DEFAULT 0" },
		];

		const id = runId();
		const report: StressReport = await runStress({
			client,
			recorder,
			scope,
			config: stressConfig,
			runId: id,
			columns,
		});
		created.push(...report.tables);

		// Emit BOTH outputs (FR-7): human summary to stdout + JSON to the gitignored dir.
		const summary = renderStressSummary(report);
		process.stdout.write(`\n${summary}\n`);

		const dir = reportDir();
		mkdirSync(dir, { recursive: true });
		const jsonPath = join(dir, `${id}.json`);
		writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		process.stdout.write(`\n[stress] JSON report written to ${jsonPath}\n`);

		// The run is a DIAGNOSTIC, not a pass/fail gate: a saturated backend is DATA,
		// not a failure. We assert only that the harness COMPLETED and produced a
		// well-formed, secret-free report — never that the backend was healthy.
		expect(report.totalAttempts).toBeGreaterThan(0);
		expect(report.runId).toBe(id);
		// No secret in the report (b-AC-7): the org must be redacted, never the full GUID.
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain(config.token);
		expect(serialized).not.toContain(config.org);
		expect(report.orgRedacted.startsWith("****")).toBe(true);
	});
});
