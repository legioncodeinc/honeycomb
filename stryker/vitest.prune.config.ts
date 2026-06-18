import { defineConfig } from "vitest/config";

/**
 * Mutation-testing vitest config scoped to the sessions-prune module's paired tests.
 * Used by Stryker (stryker/prune.json) so each mutant runs ONLY the prune suite.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/daemon/runtime/sessions/prune.test.ts"],
	},
});
