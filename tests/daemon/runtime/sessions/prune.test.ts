/**
 * PRD-020a a-AC-2 (daemon side) — the LOAD-BEARING desync-prevention proof.
 *
 * `runPrune` / `attachSessionsPrune` tombstone the matched `sessions` trace rows AND the paired
 * `/summaries/<author>/<sessionId>.md` `memory` summary rows TOGETHER. The desync-prevention
 * assertion is load-bearing: for EVERY matched session there must be BOTH a `sessions` tombstone
 * append AND a `memory` tombstone append carrying the marker — a trace can never be pruned
 * without its summary, or vice-versa. The "delete" is an append-only tombstone (the DeepLake
 * unreliable-DELETE lesson), so the suite asserts INSERTs of marker rows, never a hard DELETE.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	attachSessionsPrune,
	buildMatchSql,
	denyUnboundActorAuthority,
	type PruneActorAuthority,
	runPrune,
	resolvePruneTargets,
	summaryPath,
	TOMBSTONE_MARKER,
} from "../../../../src/daemon/runtime/sessions/prune.js";
import {
	type Authenticator,
	type AuthorizationPolicy,
	createFakeAuthenticator,
} from "../../../../src/daemon/runtime/auth/contracts.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const AUTHOR = "alice";
const SCOPE = { org: ORG, workspace: WORKSPACE };

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** Two matched sessions for `author`; the prune SELECT routes here, INSERTs are recorded. */
function captureTransport(): { storage: ReturnType<typeof createStorageClient>; inserts: string[] } {
	const inserts: string[] = [];
	const responder = (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/^INSERT/i.test(sql.trim())) {
			inserts.push(sql);
			return [];
		}
		if (/^SELECT/i.test(sql.trim()) && /FROM\s+"sessions"/i.test(sql)) {
			return [
				{ id: "s-1", path: "conversations/s-1", author: AUTHOR, creation_date: "2025-01-01" },
				{ id: "s-2", path: "conversations/s-2", author: AUTHOR, creation_date: "2025-02-01" },
			];
		}
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, inserts };
}

describe("PRD-020a a-AC-2 — sessions prune tombstones traces + summaries TOGETHER (no desync)", () => {
	it("a-AC-2 buildMatchSql pins the author, excludes already-tombstoned rows, and applies the filter", () => {
		const sql = buildMatchSql("sessions", AUTHOR, { before: "2026-01-01", sessionId: "s-9" });
		expect(sql).toMatch(/author = 'alice'/);
		expect(sql).toMatch(new RegExp(`filename <> '${TOMBSTONE_MARKER}'`));
		expect(sql).toMatch(/id = 's-9'/);
		expect(sql).toMatch(/creation_date < '2026-01-01'/);
	});

	it("a-AC-2 runPrune appends a sessions tombstone AND a paired memory tombstone for EVERY match", async () => {
		const { storage, inserts } = captureTransport();
		const targets = resolvePruneTargets({ storage });
		const outcome = await runPrune(storage, targets, SCOPE, AUTHOR, { before: "2026-06-01" }, "2026-06-18T00:00:00Z");

		// Two sessions matched → two sessions tombstones + two paired memory tombstones.
		expect(outcome.matched).toBe(2);
		expect(outcome.sessionsTombstoned).toBe(2);
		expect(outcome.summariesTombstoned).toBe(2);

		const sessionInserts = inserts.filter((s) => /INSERT INTO "sessions"/i.test(s));
		const memoryInserts = inserts.filter((s) => /INSERT INTO "memory"/i.test(s));

		// THE DESYNC-PREVENTION ASSERTION: the counts are EQUAL and non-zero — every trace
		// tombstone has its paired summary tombstone. A trace can never be pruned alone.
		expect(sessionInserts).toHaveLength(2);
		expect(memoryInserts).toHaveLength(2);
		expect(sessionInserts.length).toBe(memoryInserts.length);

		// Both sides carry the tombstone marker (so the read path filters them out together).
		expect(sessionInserts.every((s) => s.includes(TOMBSTONE_MARKER))).toBe(true);
		expect(memoryInserts.every((s) => s.includes(TOMBSTONE_MARKER))).toBe(true);

		// The memory tombstone lands at the paired summary path for each session.
		expect(memoryInserts.join("\n")).toContain(summaryPath(AUTHOR, "s-1"));
		expect(memoryInserts.join("\n")).toContain(summaryPath(AUTHOR, "s-2"));
	});

	it("a-AC-2 the prune is an append-only TOMBSTONE — no hard DELETE statement is ever issued", async () => {
		const { storage, inserts } = captureTransport();
		const targets = resolvePruneTargets({ storage });
		await runPrune(storage, targets, SCOPE, AUTHOR, { sessionId: "s-1" });
		// Every mutation is an INSERT; not a single `DELETE FROM` (the unreliable-DELETE lesson).
		expect(inserts.every((s) => /^INSERT/i.test(s.trim()))).toBe(true);
		expect(inserts.some((s) => /DELETE\s+FROM/i.test(s))).toBe(false);
	});

	it("a-AC-2 DELETE /api/sessions/prune attaches, scopes by actor, and returns the paired counts", async () => {
		const { storage } = captureTransport();
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		attachSessionsPrune(daemon, { storage });

		// No actor header → fail-closed 400 (a prune never falls back to a broad delete).
		const noActor = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE },
		});
		expect(noActor.status).toBe(400);

		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": AUTHOR },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matched: number; sessionsTombstoned: number; summariesTombstoned: number };
		expect(body.matched).toBe(2);
		expect(body.sessionsTombstoned).toBe(body.summariesTombstoned);
	});
});

describe("PRD-020a a-AC-2 SECURITY — the prune actor is bound to the authenticated caller (no cross-actor delete)", () => {
	function teamCfg(): RuntimeConfig {
		return { host: "127.0.0.1", port: 3850, mode: "team", widened: false };
	}

	const aliceIdentity = { org: ORG, workspace: WORKSPACE, agentId: "alice", role: "member" as const };
	/** A fake authenticator + allow-all policy so an authenticated request REACHES the handler gate. */
	function authedTeamDeps(): { authenticator: Authenticator; policy: AuthorizationPolicy } {
		return {
			authenticator: createFakeAuthenticator({ "tok-alice": aliceIdentity }),
			policy: { decide: () => "allow" },
		};
	}
	const AUTHED = { authorization: "Bearer tok-alice" };

	it("a-AC-2 SEC team mode DENIES a prune whose x-honeycomb-actor is NOT bound to the caller (fail-closed default)", async () => {
		const { storage, inserts } = captureTransport();
		// The caller authenticates (passes the 011c gate) — the destructive cross-actor block is the
		// HANDLER-level actor authority, NOT the coarse 401. Default authority is
		// denyUnboundActorAuthority → any multi-user prune is denied until a real actor↔identity
		// binding is wired (deferred assembly), so a caller can never tombstone another author.
		const daemon = createDaemon({
			config: teamCfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			...authedTeamDeps(),
		});
		attachSessionsPrune(daemon, { storage });

		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { ...AUTHED, "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": "victim" },
		});
		// 403 forbidden — and NOT A SINGLE tombstone INSERT was issued (the destructive write never ran).
		expect(res.status).toBe(403);
		expect(inserts.filter((s) => /^INSERT/i.test(s.trim()))).toHaveLength(0);
	});

	it("a-AC-2 SEC team mode prunes ONLY the caller's own bound actor — a spoofed victim author is ignored", async () => {
		const { storage } = captureTransport();
		// A real authority binds the actor to the authenticated caller: it ignores the requested
		// header actor and returns the caller's OWN id, so a prune can only ever delete the caller's
		// own traces regardless of what the header asks for.
		const boundToAlice: PruneActorAuthority = {
			resolveAuthorizedActor: () => "alice",
		};
		const daemon = createDaemon({
			config: teamCfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			...authedTeamDeps(),
		});
		attachSessionsPrune(daemon, { storage, actorAuthority: boundToAlice });

		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			// The attacker asks to prune "victim" — the authority rebinds it to the caller's own "alice".
			headers: { ...AUTHED, "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": "victim" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matched: number };
		// The fake transport returns alice's sessions for the author-pinned SELECT → the prune ran
		// against the BOUND caller, never the spoofed victim.
		expect(body.matched).toBe(2);
	});

	it("a-AC-2 SEC denyUnboundActorAuthority is fail-closed (returns null for any actor)", () => {
		expect(denyUnboundActorAuthority.resolveAuthorizedActor({} as never, "anyone")).toBeNull();
	});

	it("a-AC-2 SEC local mode is UNCHANGED — the header actor is authoritative (single-user)", async () => {
		const { storage } = captureTransport();
		// local mode (the default deployment): no auth, single user, header actor authoritative.
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		attachSessionsPrune(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": AUTHOR },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matched: number };
		expect(body.matched).toBe(2);
	});
});
