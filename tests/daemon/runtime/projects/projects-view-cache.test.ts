/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-062 FIX 3 — the projects view cache (TTL memo + explicit invalidation).
 *
 *   cache-AC-1: a fresh-enough key is served from cache (`hit:true`, compute skipped).
 *   cache-AC-2: invalidate() drops every entry so the next resolve recomputes.
 */

import { describe, expect, it } from "vitest";

import { ProjectsViewCache } from "../../../../src/daemon/runtime/projects/projects-view-cache.js";

describe("PRD-062 FIX 3: ProjectsViewCache", () => {
	it("cache-AC-1: a fresh-enough key is served from cache (compute runs once)", async () => {
		const cache = new ProjectsViewCache<number>(10_000);
		let computes = 0;
		const compute = async (): Promise<number> => {
			computes += 1;
			return computes;
		};
		const first = await cache.resolve("k", compute);
		const second = await cache.resolve("k", compute);
		expect(first).toEqual({ value: 1, hit: false }); // miss → computed.
		expect(second).toEqual({ value: 1, hit: true }); // hit → same value, compute skipped.
		expect(computes).toBe(1);
	});

	it("cache-AC-2: invalidate() forces the next resolve to recompute", async () => {
		const cache = new ProjectsViewCache<number>(10_000);
		let computes = 0;
		const compute = async (): Promise<number> => {
			computes += 1;
			return computes;
		};
		await cache.resolve("k", compute); // value 1
		cache.invalidate();
		const after = await cache.resolve("k", compute); // recompute → value 2
		expect(after).toEqual({ value: 2, hit: false });
		expect(computes).toBe(2);
	});

	it("keeps distinct keys independent", async () => {
		const cache = new ProjectsViewCache<string>(10_000);
		const a = await cache.resolve("a", async () => "A");
		const b = await cache.resolve("b", async () => "B");
		expect(a.value).toBe("A");
		expect(b.value).toBe("B");
		expect((await cache.resolve("a", async () => "changed")).value).toBe("A"); // still cached.
	});
});
