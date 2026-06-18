import { defineConfig } from "vitest/config";

/**
 * Mutation-testing vitest config scoped to the SQL-escaping module's paired tests.
 * Used by Stryker (stryker/sql.json) so each mutant runs ONLY tests/daemon/storage/sql.test.ts.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/daemon/storage/sql.test.ts"],
	},
});
