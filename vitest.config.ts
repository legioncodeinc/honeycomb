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
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts", "**/index.ts"],
			reporter: ["text", "html"],
		},
	},
});
