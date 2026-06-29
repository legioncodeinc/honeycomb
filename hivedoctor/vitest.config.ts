import { defineConfig } from "vitest/config";

/**
 * HiveDoctor's OWN Vitest config, fully self-contained.
 *
 * It deliberately does NOT participate in the repo-root vitest project: the root
 * config scopes `include` to the root `tests/**` tree and coverage to `src/**`, so
 * a `vitest run` at the repo root never collects anything under `hivedoctor/`. This
 * package's gate runs from inside `hivedoctor/` (`cd hivedoctor && npm run test`),
 * keeping Wave 0 additive and reversible (PRD-063 OD-6: independent package).
 *
 * Tests live under `hivedoctor/tests/` mirroring `hivedoctor/src/` (the
 * typescript-node stinger convention: tests mirror the source tree). `vitest run`
 * is the CI entry. The node environment matches the watchdog runtime: there is no
 * DOM, and the runtime uses Node built-ins only.
 *
 * ESM resolution note: source modules import with `.js` extensions (Node16
 * resolution); Vitest resolves those `.js` specifiers to the `.ts` source during
 * test runs, so the test tree and a future build share one import style.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text"],
		},
	},
});
