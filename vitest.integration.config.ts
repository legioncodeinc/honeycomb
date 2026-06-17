import { defineConfig } from "vitest/config";

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
		// A live round-trip against a real backend is slower than a fake-transport
		// unit test and may create/drop tables. Give each hook/test room and run
		// the files serially so two runs never collide on a shared table prefix.
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
