import { defineConfig } from "vitest/config";

/**
 * Mutation-testing vitest config scoped to the notifications-state module's paired tests.
 * Used by Stryker (stryker/state.json) so each mutant runs ONLY the state suite.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/notifications/state.test.ts"],
	},
});
