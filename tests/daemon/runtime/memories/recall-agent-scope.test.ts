/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";

import { resolveRecallAgentScope } from "../../../../src/daemon/runtime/memories/api.js";

describe("resolveRecallAgentScope", () => {
	it("uses shared plus the default agent when the caller names nobody", () => {
		const scope = resolveRecallAgentScope(undefined, undefined, "org", "ws");
		expect(scope.isolated).toBe(false);
		expect(scope.sql).toContain("global");
		expect(scope.sql).toContain("default");
		expect(scope.sql).toContain("is_deleted");
	});

	it("fails closed to isolated when the caller names an agent and no policy", () => {
		const scope = resolveRecallAgentScope("other-agent", undefined, "org", "ws");
		expect(scope.isolated).toBe(true);
		expect(scope.sql).toContain("other-agent");
		expect(scope.sql).not.toContain("global");
	});
});
