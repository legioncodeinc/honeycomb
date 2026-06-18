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
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
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

	it("a-AC-2 buildMatchSql OMITS the id/date clauses when the filter fields are absent or empty", () => {
		// The empty-filter case is the load-bearing guard: an unfiltered prune still pins the author +
		// excludes tombstones, but must NOT emit a bogus `id = ''` / `creation_date < ''` clause that
		// would match nothing (or everything). This pins the `.length > 0` guards (kills `>= 0`).
		// `creation_date` always appears in the SELECT projection + ORDER BY; assert on the WHERE
		// CLAUSE `creation_date <` (the filter), not the bare column name.
		const noFilter = buildMatchSql("sessions", AUTHOR, {});
		expect(noFilter).toMatch(/author = 'alice'/);
		expect(noFilter).toMatch(new RegExp(`filename <> '${TOMBSTONE_MARKER}'`));
		expect(noFilter).not.toMatch(/\bid = /);
		expect(noFilter).not.toMatch(/creation_date </);

		// Explicit empty strings are treated as "no clause" (the `.length > 0` guard, not just !== undefined).
		const emptyStrings = buildMatchSql("sessions", AUTHOR, { before: "", sessionId: "" });
		expect(emptyStrings).not.toMatch(/\bid = /);
		expect(emptyStrings).not.toMatch(/creation_date </);

		// And only-one-side filters emit only that side.
		const onlyId = buildMatchSql("sessions", AUTHOR, { sessionId: "s-7" });
		expect(onlyId).toMatch(/id = 's-7'/);
		expect(onlyId).not.toMatch(/creation_date </);
		const onlyBefore = buildMatchSql("sessions", AUTHOR, { before: "2026-03-03" });
		expect(onlyBefore).toMatch(/creation_date < '2026-03-03'/);
		expect(onlyBefore).not.toMatch(/\bid = /);
	});

	it("a-AC-2 summaryPath builds /summaries/<author>/<id>.md and strips leading/trailing slashes", () => {
		// The pairing depends on the summary path matching the trace; the slash-trim is load-bearing
		// (a `/alice/` author must not yield `/summaries//alice//...`). Pins the two `.replace` regexes.
		expect(summaryPath("alice", "s-1")).toBe("/summaries/alice/s-1.md");
		expect(summaryPath("/alice/", "/s-1/")).toBe("/summaries/alice/s-1.md");
		expect(summaryPath("//bob//", "sess//9")).toBe("/summaries/bob/sess//9.md");
		// A non-slash author/id passes through unchanged (the regex only strips edge slashes).
		expect(summaryPath("team.lead", "abc-123")).toBe("/summaries/team.lead/abc-123.md");
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

		// The tombstone ROW CONTENT (not just the marker) is the read-path contract — pin it so a
		// flipped flag / dropped field / emptied literal in the row builders is caught.
		const sessJoined = sessionInserts.join("\n");
		const memJoined = memoryInserts.join("\n");
		// sessions tombstone carries the structured tombstone marker object in `message`.
		expect(sessJoined).toContain('"_honeycomb_tombstone":true');
		expect(sessJoined).toContain('"prunedAt":"2026-06-18T00:00:00Z"');
		// memory tombstone id is namespaced `tombstone:<sessionId>` and description is "deleted",
		// and the summary body is emptied (the tombstone carries no content).
		expect(memJoined).toContain("tombstone:s-1");
		expect(memJoined).toContain("tombstone:s-2");
		expect(memJoined).toContain("deleted");
		// The memory tombstone's `summary` is written as an EMPTY E'' text body (val.text("")) — assert
		// that empty escape-literal appears as a VALUES entry (kills the emptied-summary-literal mutant).
		expect(memJoined).toMatch(/,\s*E'',/);
	});

	it("a-AC-2 runPrune counts ONLY the appends that actually succeeded (a failed memory insert is not counted)", async () => {
		// Drive the load-bearing pairing under PARTIAL failure: every `sessions` insert succeeds but
		// every `memory` insert is rejected. The counts must DIVERGE (2 vs 0) — proving the
		// `if (isOk(...)) ++` guards genuinely gate on the result, not blindly increment. This is the
		// desync-VISIBILITY contract: a partial failure surfaces in the counts rather than lying.
		const inserts: string[] = [];
		const responder = (req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql.trim();
			if (/^INSERT INTO "memory"/i.test(sql)) {
				throw new TransportError("query", "memory insert rejected", 500);
			}
			if (/^INSERT/i.test(sql)) {
				inserts.push(sql);
				return [];
			}
			if (/^SELECT/i.test(sql) && /FROM\s+"sessions"/i.test(sql)) {
				return [
					{ id: "s-1", path: "conversations/s-1", author: AUTHOR, creation_date: "2025-01-01" },
					{ id: "s-2", path: "conversations/s-2", author: AUTHOR, creation_date: "2025-02-01" },
				];
			}
			return [];
		};
		const fake = new FakeDeepLakeTransport(responder);
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const targets = resolvePruneTargets({ storage });

		const outcome = await runPrune(storage, targets, SCOPE, AUTHOR, { before: "2026-06-01" }, "2026-06-18T00:00:00Z");
		expect(outcome.matched).toBe(2);
		expect(outcome.sessionsTombstoned).toBe(2); // sessions side succeeded → counted.
		expect(outcome.summariesTombstoned).toBe(0); // memory side rejected → NOT counted (the guard gates).
	});

	it("a-AC-2 runPrune does NOT count a failed SESSIONS insert (the other half of the gated-count contract)", async () => {
		// Mirror image: the `sessions` insert is rejected but the `memory` insert succeeds. The
		// sessions count must be 0 while summaries is 2 — pinning the `if (isOk(sessRes)) ++` guard
		// (kills the ConditionalExpression-true mutant that would count unconditionally).
		const responder = (req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql.trim();
			if (/^INSERT INTO "sessions"/i.test(sql)) {
				throw new TransportError("query", "sessions insert rejected", 500);
			}
			if (/^INSERT/i.test(sql)) return [];
			if (/^SELECT/i.test(sql) && /FROM\s+"sessions"/i.test(sql)) {
				return [
					{ id: "s-1", path: "conversations/s-1", author: AUTHOR, creation_date: "2025-01-01" },
					{ id: "s-2", path: "conversations/s-2", author: AUTHOR, creation_date: "2025-02-01" },
				];
			}
			return [];
		};
		const fake = new FakeDeepLakeTransport(responder);
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const targets = resolvePruneTargets({ storage });

		const outcome = await runPrune(storage, targets, SCOPE, AUTHOR, { before: "2026-06-01" }, "2026-06-18T00:00:00Z");
		expect(outcome.matched).toBe(2);
		expect(outcome.sessionsTombstoned).toBe(0); // sessions side rejected → NOT counted.
		expect(outcome.summariesTombstoned).toBe(2); // memory side succeeded → counted.
	});

	it("a-AC-2 buildMatchSql joins its clauses with ' AND ' (the WHERE is a conjunction, not concatenation)", () => {
		// Pins the `.join(" AND ")` separator: a mutation to join("") would silently fuse the clauses
		// into invalid/over-broad SQL. Assert the explicit conjunction between author and id.
		const sql = buildMatchSql("sessions", AUTHOR, { sessionId: "s-3" });
		expect(sql).toMatch(/author = 'alice' AND /);
		expect(sql).toContain(" AND ");
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

		// No actor header → fail-closed 400 (a prune never falls back to a broad delete). Pin the
		// error BODY shape (kills the emptied-reason / emptied-error-code literal mutants).
		const noActor = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE },
		});
		expect(noActor.status).toBe(400);
		const noActorBody = (await noActor.json()) as { error: string; reason: string };
		expect(noActorBody.error).toBe("bad_request");
		expect(noActorBody.reason).toContain("x-honeycomb-actor");

		// An EMPTY actor header is also rejected (the `headerActor.length === 0` arm, not just absence).
		const emptyActor = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": "" },
		});
		expect(emptyActor.status).toBe(400);

		// No org header → fail-closed 400 (the scope-resolution guard; an unscoped prune never runs).
		const noOrg = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-actor": AUTHOR },
		});
		expect(noOrg.status).toBe(400);
		const noOrgBody = (await noOrg.json()) as { error: string; reason: string };
		expect(noOrgBody.error).toBe("bad_request");
		expect(noOrgBody.reason).toContain("x-honeycomb-org");

		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": AUTHOR },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matched: number; sessionsTombstoned: number; summariesTombstoned: number };
		expect(body.matched).toBe(2);
		expect(body.sessionsTombstoned).toBe(body.summariesTombstoned);
	});

	it("a-AC-2 the handler threads the ?before / ?session-id query into the match SELECT (filter passthrough)", async () => {
		// The handler reads `before` + `session-id` off the query string and builds the PruneFilter.
		// Assert both reach the author-pinned SELECT, and that an empty `before=` is dropped (not
		// emitted as a bogus `creation_date < ''`). Pins the query-param → filter construction branches.
		// Own the fake directly so we can read every recorded statement.
		const selectSqls: string[] = [];
		const responder = (req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql.trim();
			if (/^SELECT/i.test(sql) && /FROM\s+"sessions"/i.test(sql)) {
				selectSqls.push(sql);
				return [{ id: "s-1", path: "conversations/s-1", author: AUTHOR, creation_date: "2025-01-01" }];
			}
			return [];
		};
		const fake = new FakeDeepLakeTransport(responder);
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		attachSessionsPrune(daemon, { storage });

		const res = await daemon.app.request("/api/diagnostics/sessions/prune?before=2026-06-01&session-id=s-42", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": AUTHOR },
		});
		expect(res.status).toBe(200);
		const matchSql = selectSqls[selectSqls.length - 1];
		expect(matchSql).toMatch(/author = 'alice'/);
		expect(matchSql).toMatch(/id = 's-42'/);
		expect(matchSql).toMatch(/creation_date < '2026-06-01'/);

		// An empty before= query param is dropped — no bogus empty date clause.
		const res2 = await daemon.app.request("/api/diagnostics/sessions/prune?before=&session-id=s-9", {
			method: "DELETE",
			headers: { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "x-honeycomb-actor": AUTHOR },
		});
		expect(res2.status).toBe(200);
		const matchSql2 = selectSqls[selectSqls.length - 1];
		expect(matchSql2).toMatch(/id = 's-9'/);
		expect(matchSql2).not.toMatch(/creation_date </);
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
		// Pin the forbidden error BODY (kills the emptied error-code / emptied reason literal mutants).
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("forbidden");
		expect(body.reason).toContain("not bound to the authenticated caller");
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
