import { existsSync, readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/node";

/**
 * Run-level INFRA-DEGRADED reporter (PRD-034a, D-2 / FR-4 / a-AC-3).
 *
 * The live suite self-classifies a sustained backend outage by writing a sentinel
 * marker (see `tests/integration/_infra-skip.ts`). This reporter re-reads that ONE
 * documented marker path at run end and, when present, prints a single final
 * neutral line the Wave-2 `ci.yaml` job maps to a NEUTRAL conclusion — so the
 * workflow has a deterministic place to read the outcome regardless of which test
 * worker wrote it. It NEVER changes a pass/fail verdict here (that stays the suite's
 * job); it only SURFACES the neutral signal. No secret is read — the marker is pure
 * run-metadata.
 */
const INFRA_SKIP_MARKER_PATH =
	(process.env.HONEYCOMB_INFRA_SKIP_DIR ?? `${process.cwd()}/.infra-skip`) + "/infra-degraded.json";
const INFRA_SKIP_CONSOLE_PREFIX = "##honeycomb-infra-degraded##";

class InfraDegradedReporter implements Reporter {
	onFinished(): void {
		if (!existsSync(INFRA_SKIP_MARKER_PATH)) return;
		let body = "";
		try {
			body = readFileSync(INFRA_SKIP_MARKER_PATH, "utf8").trim();
		} catch {
			body = "{}";
		}
		// A final, distinct line on stdout — the workflow greps the prefix and maps
		// the run to NEUTRAL ("infra-unavailable"), not a hard red on our code.
		// eslint-disable-next-line no-console
		console.log(`${INFRA_SKIP_CONSOLE_PREFIX} (run-final) ${body}`);
	}
}

/**
 * Vitest configuration for the OPT-IN live-DeepLake integration suite
 * (chore/github-actions-ci — closes the "no live DeepLake" limitation noted in
 * PRD-002 / PRD-003).
 *
 * This config is SEPARATE from `vitest.config.ts` on purpose. The default suite
 * (`npm run test` → `vitest run`, which uses `vitest.config.ts`) globs
 * `tests/**​/*.test.ts` and would otherwise sweep up `tests/integration`. To keep
 * the unit count stable and the credential-less run fast, the default config is
 * NOT changed; instead the integration files are MOVED out of the default glob's
 * reach by naming convention:
 *
 *   - unit tests:        `tests/**​/*.test.ts`            (default config picks up)
 *   - integration tests: `tests/integration/**​/*.itest.ts` (ONLY this config picks up)
 *
 * The `.itest.ts` suffix means the default `include` (`*.test.ts`) never matches
 * an integration file even though it lives under `tests/`. Belt-and-braces, the
 * default config also `exclude`s `tests/integration/**` — so there are two
 * independent reasons the live suite stays out of `npm run test` / `npm run ci`.
 *
 * Run it explicitly with `npm run test:integration`. With no
 * `HONEYCOMB_DEEPLAKE_TOKEN` set, every describe block in the suite is skipped
 * (via `describe.skipIf`), so this command exits 0 and reports the tests as
 * skipped — it never fails a credential-less machine or a fork.
 *
 * Note on ESM resolution: source modules import with `.js` extensions (Node16
 * resolution). Vite/Vitest resolves those `.js` specifiers to the `.ts` source
 * during the run, identical to `vitest.config.ts`.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/integration/**/*.itest.ts"],
		// The default reporter PLUS the infra-degraded surfacer (D-2): on a sustained
		// backend outage the suite writes a sentinel marker and this reporter prints the
		// run-final neutral line the Wave-2 `ci.yaml` job maps to a NEUTRAL conclusion.
		reporters: ["default", new InfraDegradedReporter()],
		// A live round-trip against a real backend is slower than a fake-transport
		// unit test and may create/drop tables. Give each hook/test room and run
		// the files serially so two runs never collide on a shared table prefix.
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
