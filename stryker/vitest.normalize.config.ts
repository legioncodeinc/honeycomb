import { defineConfig } from "vitest/config";

/**
 * Mutation-testing vitest config scoped to the shim normalization engine's paired tests.
 * normalize.ts is exercised by every shim suite + the channel/references gates, so all of
 * tests/hooks/** is in scope (the structural-equivalence guarantee under test).
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/hooks/**/*.test.ts"],
	},
});
