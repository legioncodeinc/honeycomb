/**
 * PRD-015a a-AC-1 / a-AC-2 / a-AC-6 — read resolution precedence + the graph bridge +
 * dispatch-only storage.
 *
 * Drives `resolveRead` (via `DeepLakeFs.readFile`) against a FAKE `DaemonDispatch` + a
 * fixture snapshot. Each tier is proved to WIN in order (graph > index > cache > pending >
 * sessions > SQL) and to SHORT-CIRCUIT (an earlier tier serving the read dispatches NO SQL
 * — `dispatch.calls` is empty). The graph tier renders the LOCAL snapshot with ZERO network.
 * Every storage-reaching tier reaches storage ONLY through the dispatch seam (a-AC-6).
 */

import { describe, expect, it } from "vitest";

import {
	createFakeDaemonDispatch,
	createFakeSnapshotLoader,
	DeepLakeFs,
	type PendingBuffer,
	type Row,
	type VfsScope,
} from "../../../src/daemon-client/vfs/index.js";
import { FIXTURE_SNAPSHOT, memoryRow, respondSession, SCOPE, sessionRow } from "./fixtures.js";

/** Build a `DeepLakeFs` with the given dispatch responder + optional seeded maps. */
function makeFs(opts: {
	respond?: (sql: string, scope: VfsScope) => readonly Row[];
	snapshot?: typeof FIXTURE_SNAPSHOT | null;
	cache?: Map<string, string>;
	sessionCache?: Map<string, { token: string; body: string }>;
	pending?: PendingBuffer;
}) {
	const dispatch = createFakeDaemonDispatch({ respond: opts.respond });
	const fs = new DeepLakeFs({
		dispatch,
		scope: SCOPE,
		snapshots: createFakeSnapshotLoader(opts.snapshot === undefined ? FIXTURE_SNAPSHOT : opts.snapshot),
		cache: opts.cache,
		sessionCache: opts.sessionCache,
		pending: opts.pending,
	});
	return { fs, dispatch };
}

describe("a-AC-1 read precedence: graph > index > cache > pending > sessions > SQL", () => {
	it("a-AC-2 tier 1 — a graph path renders the LOCAL snapshot with ZERO network (no dispatch)", async () => {
		const { fs, dispatch } = makeFs({});
		const body = await fs.readFile("graph/index.md");
		// The graph renderer produced a body grounded in the fixture snapshot…
		expect(body).toContain("Codebase graph");
		expect(body).toContain("honeycomb");
		// …and reached storage ZERO times (zero-network — the snapshot is local).
		expect(dispatch.calls).toEqual([]);
	});

	it("a-AC-2 a graph path with NO local snapshot → `no-graph` as a BODY, not a throw", async () => {
		const { fs, dispatch } = makeFs({ snapshot: null });
		const body = await fs.readFile("graph/index.md");
		expect(body).toContain("no-graph");
		expect(dispatch.calls).toEqual([]); // still zero network
	});

	it("a-AC-1 tier 3 — a cache hit wins over SQL and dispatches NOTHING", async () => {
		const cache = new Map<string, string>([["notes/x.md", "CACHED BODY"]]);
		const { fs, dispatch } = makeFs({ cache });
		const body = await fs.readFile("notes/x.md");
		expect(body).toBe("CACHED BODY");
		expect(dispatch.calls).toEqual([]); // tier 3 short-circuits before any SQL
	});

	it("a-AC-1 tier 4 — a pending write wins over SQL (cat-after-write), no dispatch", async () => {
		const pending = new Map([
			[
				"notes/y.md",
				{ path: "notes/y.md", body: "PENDING BODY", verb: "write" as const, pathClass: "memory" as const },
			],
		]);
		const { fs, dispatch } = makeFs({ pending });
		const body = await fs.readFile("notes/y.md");
		expect(body).toBe("PENDING BODY");
		expect(dispatch.calls).toEqual([]);
	});

	it("a-AC-1 tier 3 beats tier 4 — cache wins over pending when both hold the path", async () => {
		const cache = new Map([["dup.md", "FROM CACHE"]]);
		const pending = new Map([
			["dup.md", { path: "dup.md", body: "FROM PENDING", verb: "write" as const, pathClass: "memory" as const }],
		]);
		const { fs } = makeFs({ cache, pending });
		expect(await fs.readFile("dup.md")).toBe("FROM CACHE");
	});

	it("a-AC-1 tier 5 — a sessions path concatenates message rows in chronological order", async () => {
		// The bounded reader selects newest-first (`ORDER BY creation_date DESC LIMIT N`);
		// concatSessions reverses the rows so the turn stream still reads oldest→newest.
		const { fs, dispatch } = makeFs({
			respond: respondSession(2, "2026-01-02T00:00:00Z", [sessionRow("turn 2"), sessionRow("turn 1")]),
		});
		const body = await fs.readFile("sessions/2026/abc.md");
		expect(body).toBe("turn 1\nturn 2");
		// A session read dispatches the cheap staleness PROBE first, then the bounded concat.
		expect(dispatch.calls).toHaveLength(2);
		expect(dispatch.calls[0].sql).toContain("count(*)");
		expect(dispatch.calls[0].sql).toContain('FROM "sessions"');
		expect(dispatch.calls[1].sql).toContain("ORDER BY creation_date DESC");
		expect(dispatch.calls[1].sql).toContain("LIMIT 2000");
	});

	it("a-AC-1 tier 6 — a memory path falls through to a direct summary SELECT", async () => {
		const { fs, dispatch } = makeFs({
			respond: (sql) => (sql.includes('FROM "memory"') ? [memoryRow("notes/z.md", "THE SUMMARY")] : []),
		});
		const body = await fs.readFile("notes/z.md");
		expect(body).toBe("THE SUMMARY");
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0].sql).toContain('SELECT summary FROM "memory"');
		expect(dispatch.calls[0].sql).toContain("WHERE path = 'notes/z.md'");
	});

	it("a-AC-1 a memory path with no row → empty body (an empty file), not a throw", async () => {
		const { fs } = makeFs({ respond: () => [] });
		expect(await fs.readFile("notes/missing.md")).toBe("");
	});
});

describe("a-AC-6 every storage-reaching read dispatches through the daemon under scope", () => {
	it("a-AC-6 the sessions read carries the full VfsScope (org/workspace/agent_id)", async () => {
		const { fs, dispatch } = makeFs({ respond: () => [sessionRow("x")] });
		await fs.readFile("sessions/s.md");
		expect(dispatch.calls[0].scope).toEqual(SCOPE);
	});

	it("a-AC-6 the memory read carries the full VfsScope", async () => {
		const { fs, dispatch } = makeFs({ respond: () => [memoryRow("p.md", "s")] });
		await fs.readFile("p.md");
		expect(dispatch.calls[0].scope).toEqual(SCOPE);
	});
});

describe("session-recall cache (Option 1): modification-time-gated re-fetch", () => {
	it("serves an UNCHANGED session from cache after the cheap probe — no payload re-fetch", async () => {
		// Same staleness token on every probe → the fat concat runs ONCE, then is cached.
		const sessionCache = new Map<string, { token: string; body: string }>();
		const { fs, dispatch } = makeFs({
			sessionCache,
			respond: respondSession(2, "2026-01-02T00:00:00Z", [sessionRow("turn 2"), sessionRow("turn 1")]),
		});

		const first = await fs.readFile("sessions/2026/abc.md");
		expect(first).toBe("turn 1\nturn 2");
		expect(dispatch.calls).toHaveLength(2); // probe + concat

		const second = await fs.readFile("sessions/2026/abc.md");
		expect(second).toBe("turn 1\nturn 2");
		// Only ONE additional dispatch — the probe. The concat did NOT run again.
		expect(dispatch.calls).toHaveLength(3);
		expect(dispatch.calls[2].sql).toContain("count(*)");
		expect(dispatch.calls.filter((c) => c.sql.includes("ORDER BY creation_date DESC"))).toHaveLength(1);
	});

	it("re-fetches when the token changes (a new turn was appended)", async () => {
		const sessionCache = new Map<string, { token: string; body: string }>();
		let turns = [sessionRow("turn 1")];
		let n = 1;
		let hwm = "2026-01-01T00:00:00Z";
		const { fs, dispatch } = makeFs({
			sessionCache,
			respond: (sql) => {
				if (sql.includes("count(*)")) return [{ n, hwm }];
				if (sql.includes('FROM "sessions"')) return turns;
				return [];
			},
		});

		expect(await fs.readFile("sessions/s.md")).toBe("turn 1");
		// A new turn lands: the token moves forward.
		turns = [sessionRow("turn 2"), sessionRow("turn 1")];
		n = 2;
		hwm = "2026-01-02T00:00:00Z";
		expect(await fs.readFile("sessions/s.md")).toBe("turn 1\nturn 2");
		// Two concat fetches total — one per distinct token.
		expect(dispatch.calls.filter((c) => c.sql.includes("ORDER BY creation_date DESC"))).toHaveLength(2);
	});

	it("an empty session (count 0) resolves to '' with NO concat fetch", async () => {
		const { fs, dispatch } = makeFs({
			sessionCache: new Map(),
			respond: respondSession(0, "", []),
		});
		expect(await fs.readFile("sessions/empty.md")).toBe("");
		// Only the probe ran; the fat concat was skipped entirely.
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0].sql).toContain("count(*)");
	});

	it("the probe never reads the fat `message` column", async () => {
		const { fs, dispatch } = makeFs({
			sessionCache: new Map(),
			respond: respondSession(1, "2026-01-01T00:00:00Z", [sessionRow("x")]),
		});
		await fs.readFile("sessions/s.md");
		const probe = dispatch.calls[0].sql;
		expect(probe).toContain("count(*)");
		expect(probe).toContain("max(creation_date)");
		expect(probe).not.toContain("message");
	});
});
