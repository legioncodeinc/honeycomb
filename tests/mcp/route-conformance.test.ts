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
 * C-2 route-conformance suite — every registered MCP tool must dial a route that
 * actually exists on the daemon.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────
 * Every OTHER `tests/mcp/*` test drives a handler against `createFakeDaemonApiSeam`,
 * which answers ANY `{method, path}` with a scripted 200 — it cannot notice that the
 * dialed path does not exist on the real daemon. That is exactly how 8 of the 21
 * registered tools (the browse trio, the sessions/agent clusters, `memory_feedback`,
 * and `memory_modify`/`memory_forget`'s `PATCH`/`DELETE /api/memories`) shipped
 * dialing routes the daemon never mounts (C-2, 2026-07-03 pre-release QA sweep) while
 * every seam test stayed green.
 *
 * This suite closes that gap: it assembles a REAL daemon (`assembleTestDaemonApp` —
 * the same `assembleDaemon` → `assembleSeams` path production uses, every route group
 * mounted, every handler wired, backed by a fake in-memory `StorageQuery` so no
 * DeepLake/network is touched), drives EVERY registered tool's REAL handler through a
 * `DaemonApiSeam` whose `fetch` forwards to the assembled app's `app.request(...)`
 * in-process (no socket), and asserts the daemon never answers with its root
 * "no such route" scaffold or a 405.
 *
 * ── WHY NOT A BARE "STATUS !== 404" CHECK ────────────────────────────────────
 * HTTP 404 is overloaded: a route that EXISTS can legitimately return a DOMAIN 404
 * (e.g. `memory_get` on an unknown id, or an unknown secret name). Only the daemon's
 * ROOT scaffold (`src/daemon/runtime/server.ts`'s `app.notFound`) means "no such route
 * at all", and it has an exact, distinct shape: `{ error: "not_found", path }`. Every
 * domain 404 in this codebase uses a DIFFERENT body shape (`{error, id}`, `{error,
 * reason}`, ...), so checking for that exact shape is what actually proves "this path
 * does not exist" rather than "this path exists but found nothing".
 */

import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../mcp/src/contracts.js";
import { createHttpDaemonApiSeam, type FetchLike } from "../../mcp/src/daemon-seam.js";
import { createMcpToolRegistry, registerHoneycombSurface } from "../../mcp/src/registry.js";
import { assembleTestDaemonApp } from "../integration/_daemon-harness.js";

const ACTOR: Actor = { actor: "conformance-actor", actorType: "agent" };

/** One HTTP call the forwarding fetch observed. */
interface RecordedForward {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly body: unknown;
}

/**
 * Build a {@link FetchLike} that forwards every call to the assembled daemon's
 * in-process Hono `app.request(...)` — no socket, no real network — while recording
 * each call's method/path/status/body for the assertions below.
 */
function forwardingFetch(app: Hono): { fetch: FetchLike; calls: RecordedForward[] } {
	const calls: RecordedForward[] = [];
	const fetch: FetchLike = async (url, init) => {
		const target = new URL(url);
		const res = await app.request(target.pathname + target.search, init);
		let body: unknown;
		try {
			// `.clone()` BEFORE either body is read — the seam (the caller of this `fetch`)
			// still needs to read the original response's body once this function returns.
			body = await res.clone().json();
		} catch {
			body = undefined;
		}
		calls.push({ method: init.method, path: target.pathname + target.search, status: res.status, body });
		return res;
	};
	return { fetch, calls };
}

/**
 * True when `status`/`body` is the daemon's ROOT-scaffold "no such route at all" shape
 * — `src/daemon/runtime/server.ts`'s `app.notFound`: `c.json({error:"not_found", path}, 404)`.
 * A handler-level domain 404 (e.g. `memory_get`'s `{error,id}`, or the secrets store's
 * `{error,reason}`) reached a REAL handler and is not a route-shape bug — see the file
 * doc comment for why the exact shape (not the bare status) is the signal.
 */
function isTrulyMissingRoute(status: number, body: unknown): boolean {
	if (status !== 404) return false;
	if (body === null || typeof body !== "object") return false;
	const b = body as { error?: unknown; path?: unknown };
	return b.error === "not_found" && typeof b.path === "string";
}

/** Minimal valid args per tool, satisfying each tool's strict `zod/v3` schema. */
function minimalArgsFor(name: string): Record<string, unknown> {
	switch (name) {
		case "memory_search":
		case "hivemind_search":
		case "honeycomb_search":
			return { query: "conformance query" };
		case "memory_store":
			return { text: "conformance note" };
		case "memory_get":
			return { path: "conformance-id" };
		case "memory_list":
			return {};
		case "memory_modify":
			return { path: "conformance-id", content: "updated content", reason: "conformance check" };
		case "memory_forget":
			return { path: "conformance-id", reason: "conformance check" };
		case "honeycomb_read":
			return { path: "conformance-path" };
		case "honeycomb_index":
			return {};
		case "hivemind_read":
			return { ref: "conformance-ref" };
		case "honeycomb_goal_add":
			return { goal: "conformance goal" };
		case "honeycomb_kpi_add":
			return { kpi: "conformance kpi" };
		case "secret_list":
			return {};
		case "secret_exec":
			return { command: "true" };
		default:
			return {};
	}
}

describe("C-2 conformance: every registered MCP tool dials a route that exists", () => {
	beforeEach(() => {
		// Force embeddings OFF (mirrors tests/daemon/runtime/assembled-net.test.ts) so recall
		// stays deterministically lexical-only — no fetch to a non-existent embed daemon.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("no registered tool's dialed route 404s (root scaffold) or 405s against a REAL assembled daemon", async () => {
		const { app } = assembleTestDaemonApp({ mode: "local" });
		const { fetch, calls } = forwardingFetch(app);
		const daemon = createHttpDaemonApiSeam({ fetch });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });

		// The default (unconditional) surface — 15 tools. The `codebase` cluster stays
		// gated behind `honeycomb graph build` and has NO backing daemon route at all
		// today (`/api/graph` only serves `build` + a whole-graph `GET`, not per-symbol
		// search/context/blast/impact); it is a pre-existing, separately-scoped gap this
		// suite does not claim to close (see the final report's blockers section).
		registerHoneycombSurface(registry);

		expect(registry.registered.length).toBeGreaterThan(0);
		for (const name of registry.registered) {
			await registry.invoke(name, minimalArgsFor(name));
		}

		expect(calls.length, "every registered tool must have dialed the daemon exactly once").toBe(
			registry.registered.length,
		);

		for (const call of calls) {
			expect(call.status, `${call.method} ${call.path} must not 405 (method not allowed)`).not.toBe(405);
			expect(
				isTrulyMissingRoute(call.status, call.body),
				`${call.method} ${call.path} hit the daemon's root "no such route" scaffold ` +
					`(404 {error:"not_found",path}) — this is exactly the C-2 bug class. Body: ` +
					`${JSON.stringify(call.body)}`,
			).toBe(false);
		}
	});

	it("honeycomb_goal_add / honeycomb_kpi_add happy path: the daemon's strict keyed body gate accepts the mapped body (non-4xx)", async () => {
		// C-2 follow-up: route reachability alone did not catch the BODY-shape mismatch —
		// the old `{ goal }` / `{ kpi }` bodies reached the real `/api/goals` / `/api/kpis`
		// route and then failed the keyed engine's `.strict()` `{ key, value }` zod gate
		// with a 400 on every call. This asserts the full happy path (201 from
		// `product/keyed-engine.ts`'s POST handler), so a body-shape regression fails here.
		const { app } = assembleTestDaemonApp({ mode: "local" });
		const { fetch, calls } = forwardingFetch(app);
		const daemon = createHttpDaemonApiSeam({ fetch });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);

		const goalOut = await registry.invoke("honeycomb_goal_add", { goal: "ship the conformance suite" });
		const kpiOut = await registry.invoke("honeycomb_kpi_add", { kpi: "zero route-shape regressions" });

		expect(goalOut.isError, "honeycomb_goal_add must not surface a daemon error").toBeFalsy();
		expect(kpiOut.isError, "honeycomb_kpi_add must not surface a daemon error").toBeFalsy();

		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(
				call.status,
				`${call.method} ${call.path} must be a 2xx success, not a 4xx — body: ${JSON.stringify(call.body)}`,
			).toBeGreaterThanOrEqual(200);
			expect(call.status, `${call.method} ${call.path} must be a 2xx success, not a 4xx`).toBeLessThan(300);
		}
	});

	it("meta-test: a tool dialing a genuinely nonexistent route IS caught by isTrulyMissingRoute", async () => {
		// Proves the detector itself is not a tautology: `/api/sessions/search` is the
		// exact route the (now-removed) `session_search` tool used to dial, and it is
		// still not mounted anywhere in `ROUTE_GROUPS` — this is the negative control.
		const { app } = assembleTestDaemonApp({ mode: "local" });
		const { fetch } = forwardingFetch(app);
		const daemon = createHttpDaemonApiSeam({ fetch });

		const res = await daemon.call({ method: "POST", path: "/api/sessions/search", body: {}, actor: ACTOR });
		expect(isTrulyMissingRoute(res.status, res.body)).toBe(true);
	});
});
