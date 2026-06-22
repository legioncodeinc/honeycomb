/**
 * PRD-045e — the Sources + Documents surface, proven LIVE on the FULLY-ASSEMBLED
 * daemon in PLAIN CI (fake storage, no token, no network).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WHOLE POINT (mirrors PRD-031 Wave A). A green UNIT test mounts one handler
 * in isolation and cannot see that the COMPOSITION ROOT failed to wire the deps —
 * which is exactly the PRD-013 daemon-wiring gap: `/api/sources` + `/api/documents`
 * fell through to 501 because `resolveProductDataDeps` omitted `sources`. This suite
 * boots the REAL daemon through `assembleDaemon` → `assembleSeams` → `resolveProductDataDeps`
 * (every seam in real order, behind the real middleware) backed by a FAKE storage
 * client, and drives `/api/sources` + `/api/documents` via `app.request(...)`. If the
 * composition root had NOT constructed the registry + providers resolver + document
 * worker, these routes would 501 — the deterministic proof of e-AC-1/e-AC-2/e-AC-3.
 *
 * Live read-back (dedup, recall) needs a real backend (the fake answers ok([]) for
 * every read), so it lives in the gated `sources-documents-assembled-live.itest.ts`.
 * Here we prove the surface is WIRED, tenancy-scoped, and fail-soft — in plain CI.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AssembledTestDaemonApp, assembleTestDaemonApp } from "../../integration/_daemon-harness.js";

/** local-mode loopback tenancy headers the sources/documents header resolver requires. */
const HEADERS = {
	"x-honeycomb-org": "local",
	"x-honeycomb-workspace": "default",
	"content-type": "application/json",
} as const;

describe("PRD-045e — Sources + Documents surface is LIVE on the assembled daemon (plain CI, fake storage)", () => {
	let net: AssembledTestDaemonApp;

	beforeEach(() => {
		// Embeddings OFF → the document worker writes null-vector (keyword-searchable) chunks,
		// no fetch to a non-existent embed daemon. `assembleDaemon` reads this at assembly.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
		net = assembleTestDaemonApp({ mode: "local" });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// ── e-AC-2: /api/sources GET/POST/DELETE answer REAL data (no 501), tenancy-scoped. ──
	describe("e-AC-2 — /api/sources answers real data (no 501), tenancy-scoped", () => {
		it("GET /api/sources returns a 200 source-list envelope (NOT the 501 scaffold)", async () => {
			const res = await net.app.request("/api/sources", { headers: HEADERS });
			expect(res.status, "the sources list route reaches its handler, not 501").toBe(200);
			const body = (await res.json()) as { sources?: unknown; error?: string };
			expect(Array.isArray(body.sources), "the real handler returns a sources array").toBe(true);
			expect(body.error, "did NOT fall through to the not_implemented scaffold").toBeUndefined();
		});

		it("GET /api/sources WITHOUT x-honeycomb-org is rejected 400 at the edge (fail-closed tenancy)", async () => {
			const res = await net.app.request("/api/sources", { headers: { "content-type": "application/json" } });
			expect(res.status).toBe(400);
		});

		it("e-AC-4 POST /api/sources connects an OBSIDIAN source → 201 (registers + queues an index job)", async () => {
			// A real (empty) temp vault so the Obsidian provider's connect() probe finds a directory.
			const vault = mkdtempSync(join(tmpdir(), "honeycomb-045e-vault-"));
			writeFileSync(join(vault, "note.md"), "# Hello\n\nbody\n");
			try {
				const res = await net.app.request("/api/sources", {
					method: "POST",
					headers: HEADERS,
					body: JSON.stringify({ kind: "obsidian", root: vault, settings: { vaultPath: vault } }),
				});
				expect(res.status, "the obsidian source connects (no 501/400)").toBe(201);
				const body = (await res.json()) as { sourceId?: string; jobId?: string; health?: { state?: string } };
				expect(body.sourceId, "a source id was assigned by the registry").toBeTypeOf("string");
				expect(body.jobId, "an index job was enqueued on the daemon's own queue").toBeTypeOf("string");
				// The provider probed the real temp vault dir → connected health.
				expect(body.health?.state, "the obsidian provider connected to the vault dir").toBe("connected");
			} finally {
				rmSync(vault, { recursive: true, force: true });
			}
		});

		it("DELETE /api/sources/:id for an unknown id → 404 (the handler runs, not 501)", async () => {
			const res = await net.app.request("/api/sources/does-not-exist", { method: "DELETE", headers: HEADERS });
			// 404 (handler resolved the registry + found nothing), NOT 501 (unmounted).
			expect(res.status).toBe(404);
		});
	});

	// ── e-AC-3: POST /api/documents ingests through the wired worker (no 501). ──
	describe("e-AC-3 — POST /api/documents ingests through the wired document worker (no 501)", () => {
		it("POST /api/documents submits a URL → 202 with an id + status (NOT the 501 scaffold)", async () => {
			const res = await net.app.request("/api/documents", {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ url: "https://example.com/045e/doc" }),
			});
			expect(res.status, "the document worker is wired → 202, not 501").toBe(202);
			const body = (await res.json()) as { documentId?: string; status?: string; error?: string };
			expect(body.error, "did NOT fall through to the not_implemented scaffold").toBeUndefined();
			expect(body.documentId, "a deterministic document id was assigned").toBeTypeOf("string");
			// The worker runs its synchronous ingest lifecycle to a terminal state.
			expect(["queued", "done"]).toContain(body.status);
		});

		it("POST /api/documents with no url → 400 (the handler validates, not a 501)", async () => {
			const res = await net.app.request("/api/documents", { method: "POST", headers: HEADERS, body: "{}" });
			expect(res.status).toBe(400);
		});
	});

	// ── e-AC-5: fail-soft — the assembled daemon is up and serving (the sources wiring
	//    can never crash boot). If the deps build had thrown, the routes would 501 and the
	//    above would fail; the daemon answering at all is the proof it booted clean. ──
	it("e-AC-5 — the daemon booted with the sources surface wired (health answers)", async () => {
		const res = await net.app.request("/health", { method: "GET" });
		expect(res.status).toBe(200);
	});
});
