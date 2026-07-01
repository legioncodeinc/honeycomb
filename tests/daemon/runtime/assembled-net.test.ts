/**
 * PRD-031 Wave A — the ASSEMBLED-daemon "test net" that runs in PLAIN CI.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WHOLE POINT (ledger D-1 / D-2). Green UNIT tests mount ONE handler in
 * ISOLATION with a fake `StorageQuery`. They STRUCTURALLY cannot see a route
 * COLLISION (no real router assembly) or a header GAP (no real middleware chain)
 * — exactly the two bug CLASSES the dogfood caught this session. This suite boots
 * the REAL daemon through `assembleDaemon` → `assembleSeams` (every seam in real
 * ORDER, behind the REAL middleware) backed by a FAKE storage client, and drives
 * it via `app.request(...)`. No token, no network, no port-bind — so the
 * collision (AC-1) + header-gap (AC-2) classes are caught on EVERY PR.
 *
 * It lives under `tests/daemon/` (NOT the integration tree) so `npm run test`
 * picks it up: the default Vitest run includes the `tests` `.test.ts` glob and
 * excludes the `tests/integration` subtree. The live-storage classes (heal,
 * consistency) stay GATED itests under `tests/integration/` (Wave B), built on the
 * SAME `bootTestDaemon`.
 *
 * The assembled-app harness (`assembleTestDaemonApp`) is the additive sibling of
 * the live `bootTestDaemon` (D-5 — reuse, don't fork): same `assembleDaemon`
 * assembly, but hermetic + in-process.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type AssembledTestDaemonApp,
	type FakeStorageResponder,
	assembleTestDaemonApp,
} from "../../integration/_daemon-harness.js";
import { ok, queryError, type QueryResult } from "../../../src/daemon/storage/result.js";

/**
 * A fake-storage responder that makes the `memories` LEXICAL recall arm surface ONE
 * deterministic row and degrades the sibling arms (so the handler-reached case is
 * unambiguous AND the per-arm tolerance is honored). The recall adapter
 * (`memories/recall.ts`) issues a guarded `... FROM "memories" ... ILIKE ...` for the
 * `memories` arm and `... FROM "memory" ...` / `... FROM "sessions" ...` for the
 * siblings; the semantic `<#>` arms are not exercised (embeddings forced off below),
 * so recall runs lexical-only and reports `degraded: true`.
 */
const RECALL_HIT_TEXT = "the assembled-net recall handler was reached" as const;
const recallResponder: FakeStorageResponder = (sql: string): QueryResult => {
	// The `memories` lexical arm: surface one row shaped `{ source, id, text }`.
	if (/FROM\s+"memories"/i.test(sql)) {
		return ok([{ source: "memories", id: "mem-1", text: RECALL_HIT_TEXT }], 1);
	}
	// The sibling arms degrade to "table missing" on this fresh partition — the per-arm
	// tolerance means recall still answers 200 with the `memories` hit (not a 500).
	if (/FROM\s+"memory"/i.test(sql)) return queryError('relation "memory" does not exist', 404);
	if (/FROM\s+"sessions"/i.test(sql)) return queryError('relation "sessions" does not exist', 404);
	// Everything else (e.g. the health probe `SELECT 1`) succeeds empty.
	return ok([], 1);
};

/** The session-group headers a `/api/memories/*` request must carry to clear the edge. */
const SESSION_HEADERS = {
	"x-honeycomb-runtime-path": "legacy",
	"x-honeycomb-session": "assembled-net-session",
	"content-type": "application/json",
} as const;

describe("PRD-031 Wave A — assembled-daemon test net (plain CI, fake storage)", () => {
	let net: AssembledTestDaemonApp;

	beforeEach(() => {
		// Force embeddings OFF so recall is deterministically LEXICAL-only (no fetch to a
		// non-existent embed daemon, no flake). `assembleDaemon` reads this at assembly,
		// so stub BEFORE assembling. Restored in afterEach.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
		net = assembleTestDaemonApp({ mode: "local", responder: recallResponder });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// ── AC-1: ROUTE COLLISION — data routes reachable, NOT shadowed by the dashboard host ──
	//
	// This is the test that WOULD HAVE FAILED under the
	// 020b-dashboard-host-shadows-022-data-routes collision: the dashboard host mounts
	// `GET /dashboard*` on the UNPROTECTED root group `/`, while the PRD-022 data routes
	// mount on their OWN protected groups. If the host's mount had shadowed the data
	// subtree, `POST /api/memories/recall` would return the dashboard HTML shell (or fall
	// through to the root scaffold) instead of the recall JSON. We assert on the response
	// SHAPE + content-type, not just status, so a shadow can't pass as a 200.
	describe("AC-1 — the PRD-022 data routes are reachable and not shadowed by the dashboard host", () => {
		it("POST /api/memories/recall resolves to the DATA handler (recall JSON), not the dashboard HTML", async () => {
			const res = await net.app.request("/api/memories/recall", {
				method: "POST",
				headers: { ...SESSION_HEADERS },
				body: JSON.stringify({ query: "assembled-net" }),
			});

			// Reached the handler — not 501 (scaffold), not 400 (edge), not the host.
			expect(res.status, "recall reaches its handler on the assembled app").toBe(200);
			// It is the DATA response (JSON), NOT the dashboard host's HTML shell — the
			// load-bearing no-shadow assertion (a collision would serve text/html here).
			const contentType = res.headers.get("content-type") ?? "";
			expect(contentType, "the data route serves JSON, not the dashboard HTML shell").toContain(
				"application/json",
			);
			expect(contentType, "explicitly NOT the dashboard host content-type").not.toContain("text/html");

			// The body is the recall result shape (`hits`/`sources`/`degraded`) with the
			// fake-storage-backed `memories` hit surfaced — proof the DATA handler ran.
			const body = (await res.json()) as { hits: { source: string; text: string }[]; sources: string[]; degraded: boolean };
			expect(Array.isArray(body.hits), "recall returns a hits array (the data shape)").toBe(true);
			expect(body.hits.some((h) => h.source === "memories" && h.text === RECALL_HIT_TEXT)).toBe(true);
			// Per-arm tolerance: the missing `memory`/`sessions` siblings did NOT 500 the recall.
			expect(body.sources, "only the present arm surfaced; missing siblings degraded to empty").toContain(
				"memories",
			);
			expect(body.degraded, "lexical-only (embeddings forced off) → honest degraded").toBe(true);
		});

		it("GET /api/diagnostics/health resolves to its DATA handler (health JSON), not the host or the 501 scaffold", async () => {
			// `/api/diagnostics` is a protected, NON-session group; in local mode the
			// permission middleware is open, so no headers are needed. The dashboard host's
			// `/dashboard*` mount must NOT shadow this `/api/diagnostics/*` data route.
			const res = await net.app.request("/api/diagnostics/health", { method: "GET" });

			expect(res.status, "the diagnostics-health data route reaches its handler").toBe(200);
			const contentType = res.headers.get("content-type") ?? "";
			expect(contentType).toContain("application/json");
			expect(contentType).not.toContain("text/html");

			const body = (await res.json()) as { status?: string; error?: string };
			// The diagnostics-health handler returns a `HealthDetail` (`status` literal) — NOT
			// the `{ error: "not_implemented" }` 501 scaffold a shadow/unmounted route would hit.
			expect(body.status, "served the health detail, not the 501 scaffold").toBeTypeOf("string");
			expect(body.error, "did NOT fall through to the not_implemented scaffold").toBeUndefined();
		});
	});

	// ── AC-2: HEADER GAP — missing x-honeycomb-* rejected at the REAL middleware edge ──
	//
	// `/api/memories/recall` is a SESSION group: the runtime-path middleware
	// (`runtime-path.ts`, mounted by `assembleSeams` via `server.ts`) REQUIRES the
	// `x-honeycomb-session` header (and a valid `x-honeycomb-runtime-path`) BEFORE any
	// recall handler runs. A request missing it must be rejected at the edge (400) — and
	// the SAME request WITH the headers must reach the handler (200). This exercises the
	// REAL assembled middleware chain (assembleSeams), NOT an isolated mount (D-1) — the
	// whole reason a unit test could not catch the dogfood scope/header gap.
	describe("AC-2 — a request missing the required x-honeycomb-* header is rejected at the real middleware edge", () => {
		it("WITHOUT x-honeycomb-session → 400 at the runtime-path edge (the handler never runs)", async () => {
			const res = await net.app.request("/api/memories/recall", {
				method: "POST",
				headers: {
					// A valid runtime-path but NO session header — the gap the dogfood hit.
					"x-honeycomb-runtime-path": "legacy",
					"content-type": "application/json",
				},
				body: JSON.stringify({ query: "assembled-net" }),
			});

			expect(res.status, "missing session header → rejected at the edge").toBe(400);
			const body = (await res.json()) as { error?: string; reason?: string };
			expect(body.error, "the edge 400, not a handler response").toBe("bad_request");
			expect(body.reason ?? "", "the rejection names the missing session header").toMatch(/session/i);
			// PROOF the handler never ran: the fake storage saw NO recall arm query for this request.
			expect(
				net.storage.requests.some((r) => /FROM\s+"memories"/i.test(r.sql)),
				"the recall handler was never reached (no storage query issued)",
			).toBe(false);
		});

		it("WITHOUT x-honeycomb-runtime-path → 400 at the runtime-path edge", async () => {
			// The sibling header gap on the SAME session group — also rejected at the edge.
			const res = await net.app.request("/api/memories/recall", {
				method: "POST",
				headers: {
					"x-honeycomb-session": "assembled-net-session",
					"content-type": "application/json",
				},
				body: JSON.stringify({ query: "assembled-net" }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { reason?: string };
			expect(body.reason ?? "", "the rejection names the missing runtime-path header").toMatch(/runtime-path/i);
		});

		it("WITH the x-honeycomb-* headers → the SAME request reaches the handler (200)", async () => {
			const res = await net.app.request("/api/memories/recall", {
				method: "POST",
				headers: { ...SESSION_HEADERS },
				body: JSON.stringify({ query: "assembled-net" }),
			});

			expect(res.status, "with the headers, the request clears the edge and reaches the handler").toBe(200);
			const body = (await res.json()) as { hits: unknown[] };
			expect(Array.isArray(body.hits), "the recall handler answered (the data shape)").toBe(true);
			// PROOF the handler ran: the fake storage saw the `memories` recall arm query.
			expect(
				net.storage.requests.some((r) => /FROM\s+"memories"/i.test(r.sql)),
				"the recall handler was reached (storage query issued)",
			).toBe(true);
		});
	});
});
