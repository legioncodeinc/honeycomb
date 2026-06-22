import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for Honeycomb (PRD-002 test foundation, Wave 1).
 *
 * Tests live under `tests/` mirroring `src/` (per the typescript-node stinger:
 * tests mirror the source tree). `vitest run` is the CI entry; `vitest` watches
 * locally. The node environment matches the daemon's runtime — there is no DOM.
 *
 * Coverage uses the v8 provider (the stinger-canonical provider) and scopes to
 * `src/` so the bundled output, the reference trees, and the fixtures don't
 * pollute the numbers. Coverage is opt-in (`--coverage`) so the default `test`
 * run stays fast.
 *
 * Note on ESM resolution: source modules import with `.js` extensions (Node16
 * resolution). Vite/Vitest resolves those `.js` specifiers to the `.ts` source
 * during test runs, so the test tree and the production build share one import
 * style with no duplicate extension-less variant.
 *
 * The OPT-IN live-DeepLake integration suite lives under `tests/integration`
 * with an `.itest.ts` suffix and runs under `vitest.integration.config.ts` only
 * (via `npm run test:integration`). It is kept out of this default run two ways:
 * its `.itest.ts` suffix does not match the `*.test.ts` glob below, AND it is
 * excluded explicitly. So `npm run test` / `npm run ci` never touch a live
 * backend and the unit count stays stable.
 */
export default defineConfig({
	test: {
		environment: "node",
		// PRD-043a: the durable log store uses the built-in `node:sqlite` (`DatabaseSync`), which
		// requires `--experimental-sqlite` on Node 22.x (the engines floor; flag-free + a harmless
		// no-op on 24/25). Pass it to the test WORKER processes via the fork pool's `execArgv` — the
		// cross-platform way (an inline `NODE_OPTIONS=` shell prefix would break the Windows CI leg).
		// This makes the AC-1 restart test actually persist under the flag on the 22.x leg.
		poolOptions: {
			forks: { execArgv: ["--experimental-sqlite"] },
		},
		// `.test.ts` is the bulk of the suite; `.test.tsx` is the PRD-024 dashboard web-app
		// DOM suite (it mounts React into jsdom via a per-file `@vitest-environment jsdom`
		// docblock — the default env stays `node` for every other test).
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		exclude: ["tests/integration/**"],
		// GLOBAL HOME ISOLATION (data-loss guard): runs in every worker BEFORE any test,
		// redirecting os.homedir() to a throwaway temp dir so credentialsPath() /
		// legacyCredentialsPath() can never resolve to the REAL ~/.deeplake (or ~/.honeycomb).
		// A test that exercises a destructive auth path (e.g. `logout` → unlinkSync) thus
		// only ever deletes temp space. See tests/setup/isolate-home.ts for the full rationale.
		setupFiles: ["tests/setup/isolate-home.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts", "**/index.ts"],
			reporter: ["text", "html"],
		},
	},
});
