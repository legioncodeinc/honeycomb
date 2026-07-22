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

import { normalizeHermesHome } from "../../src/cli/connector-runner.js";

describe("normalizeHermesHome", () => {
	it("treats blank environment values as unset and trims explicit homes", () => {
		expect(normalizeHermesHome(undefined)).toBeUndefined();
		expect(normalizeHermesHome("")).toBeUndefined();
		expect(normalizeHermesHome("  \t ")).toBeUndefined();
		expect(normalizeHermesHome("  /profiles/work  ")).toBe("/profiles/work");
	});
});
