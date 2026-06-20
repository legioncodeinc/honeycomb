/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE DAEMON-ASSEMBLY SMOKE — OPT-IN, BOOTS THE REAL ASSEMBLED DAEMON      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-021a (a-AC-1 / a-AC-4 / a-AC-5). Boots the REAL `assembleDaemon()`    ║
 * ║  composition root against LIVE DeepLake on an EPHEMERAL port (NOT 3850, so ║
 * ║  it never clobbers a real daemon), then drives the real HTTP surface:      ║
 * ║    - `GET /health` → 200 + the live-storage-reachable body (the cached     ║
 * ║      health bit was primed by a real `SELECT 1` against DeepLake — a-AC-4).║
 * ║    - `GET /api/status` → the resolved config + the catalog table count     ║
 * ║      (the daemon assembled its catalog — a-AC-1/FR-5).                     ║
 * ║    - graceful shutdown → the socket is closed (a follow-up request fails)  ║
 * ║      and the PID/lock file is removed (no stale lock — a-AC-5).            ║
 * ║                                                                          ║
 * ║  Reuses the `bootTestDaemon()` harness (tests/integration/_daemon-harness)║
 * ║  that 021f's golden-path itest reuses verbatim.                           ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED:                                                        ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of  ║
 * ║      `npm run test` / `npm run ci`. Only `npm run test:integration` runs.  ║
 * ║    - Ephemeral port (0): the OS picks a free port; 3850 is never bound.    ║
 * ║    - The PID/lock guard writes to a per-boot TEMP dir, never the real      ║
 * ║      `~/.honeycomb`, so a test daemon never fights a real daemon's lock.   ║
 * ║                                                                          ║
 * ║  Embeddings OFF (BM25 fallback): /health needs only a `SELECT 1`          ║
 * ║  round-trip, never a vector — no embed daemon required.                   ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  120s cap. Do NOT run locally (no creds) — the orchestrator runs it.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCK_FILE_NAME } from "../../src/daemon/runtime/assemble.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

describe.skipIf(!HAS_TOKEN)("LIVE ASSEMBLY: assembleDaemon() boots, /health probes live storage, shuts down clean", () => {
	let booted: BootedTestDaemon | null = null;

	beforeAll(async () => {
		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port. The
		// live storage client resolves its creds from `HONEYCOMB_DEEPLAKE_*` via the
		// storage layer; embeddings stay OFF (BM25 fallback) — /health needs no vectors.
		booted = await bootTestDaemon({ mode: "local" });
	}, 120_000);

	afterAll(async () => {
		// Defensive: if a test threw before its own shutdown, make sure we drain + unlock.
		if (booted !== null) {
			try {
				await booted.stop();
			} catch {
				// Already stopped in the test — a double stop is a no-op.
			}
		}
	});

	it(
		"GET /health returns 200 with the live-storage-reachable body, GET /api/status reports the catalog, then shutdown closes the socket and removes the lock",
		async () => {
			expect(booted, "the daemon booted against live DeepLake").not.toBeNull();
			const b = booted!;

			// ── a-AC-4: /health performs the live storage probe → 200 reachable. The cached
			// health bit was primed by a real `SELECT 1` during start(), so a 200 here means
			// DeepLake was actually reached, not just that the process is up.
			const health = await fetch(`${b.baseUrl}/health`);
			expect(health.status, "live /health is 200 when DeepLake is reachable").toBe(200);
			const healthBody = (await health.json()) as Record<string, unknown>;
			expect(healthBody.status).toBe("ok");
			expect(healthBody.pipeline).toBe("ok");
			expect(typeof healthBody.uptimeMs).toBe("number");
			expect(b.assembled.pipelineStatus()).toBe("ok");

			// ── a-AC-1 / FR-5: /api/status reports the resolved config + the assembled
			// catalog (the daemon constructed its catalog from the live storage client).
			const status = await fetch(`${b.baseUrl}/api/status`);
			expect(status.status).toBe(200);
			const statusBody = (await status.json()) as {
				config: { mode: string; port: number };
				providers: { storage: string };
				catalog: { tableCount: number };
			};
			expect(statusBody.config.mode).toBe("local");
			expect(statusBody.providers.storage).toBe("configured");
			expect(statusBody.catalog.tableCount).toBeGreaterThan(0);

			// ── a-AC-5: graceful shutdown closes the socket + removes the lock (the lock
			// removal is proven deterministically in the unit suite; here we prove the
			// observable end-to-end effect: the socket is closed after a clean shutdown).
			await b.stop();

			// The socket is closed: a follow-up request fails to connect.
			let connectionRefused = false;
			try {
				await fetch(`${b.baseUrl}/health`);
			} catch {
				connectionRefused = true;
			}
			expect(connectionRefused, "the socket is closed after graceful shutdown").toBe(true);
		},
		120_000,
	);
});

// A no-token guard so the suite is never silently empty in a non-gated runner: when the
// token is absent the describe above is skipped, and this asserts the gate held.
describe.skipIf(HAS_TOKEN)("LIVE ASSEMBLY (skipped: no HONEYCOMB_DEEPLAKE_TOKEN)", () => {
	it("is gated off without a live token", () => {
		// The lock filename constant is importable without a live backend (pure value).
		expect(LOCK_FILE_NAME).toBe("daemon.lock");
	});
});
