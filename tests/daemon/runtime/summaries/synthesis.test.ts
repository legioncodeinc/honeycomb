/**
 * PRD-017b wiki synthesis — proves b-AC-1..6 (named, unskipped).
 *
 * Verification posture (EXECUTION_LEDGER-prd-017): no live DeepLake. Each b-AC has a
 * named test driving the real `synthesis.ts` against:
 *   - a FAKE recording `SynthesisStore` (NO `update` method) for the link-render +
 *     thread-merge + tenant-disjoint ACs, AND the REAL `createSynthesisStore` over a
 *     `FakeDeepLakeTransport` for the SELECT-before-INSERT-not-UPDATE SQL assertion
 *     (b-AC-4) and the daemon-seam-only dispatch (b-AC-3);
 *   - the PRD-015 VFS `resolveRead` over a fake `DaemonDispatch` for the link-resolves
 *     assertion (b-AC-5) — a MEMORY.md link TARGET is a `/summaries/…` path the VFS read
 *     resolves to the summary body.
 *
 * The synthesis CONSUMES 017a's per-session summary rows (the `/summaries/<userName>/
 * <sessionId>.md` `memory` rows) — the fake store seeds them; the real store reads them
 * through the daemon `StorageQuery`.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import {
	createSynthesisStore,
	MEMORY_INDEX_PATH,
	refreshMemoryIndex,
	renderMemoryIndex,
	type SummaryRecord,
	synthesizeMemoryIndex,
	synthesizeThreadHeads,
	type SynthesisStore,
	type SynthesisWriteOutcome,
	type SynthesizedRow,
	threadHeadPath,
	threadKeyOf,
} from "../../../../src/daemon/runtime/summaries/index.js";
import { resolveRead } from "../../../../src/daemon-client/vfs/read.js";
import {
	createFakeDaemonDispatch,
	createFakeSnapshotLoader,
	type ReadDeps,
	type VfsScope,
} from "../../../../src/daemon-client/vfs/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

/** A per-session summary record at the canonical `/summaries/<userName>/<sessionId>.md` path. */
function summaryRecord(userName: string, sessionId: string, description: string, author = userName): SummaryRecord {
	return { path: `/summaries/${userName}/${sessionId}.md`, description, author };
}

/**
 * A recording FAKE `SynthesisStore` (NO `update` by construction). Seeds the summaries
 * the synthesis reads; records every written index/head row + every SBI probe so a test
 * asserts exactly-once and the no-UPDATE shape.
 */
function recordingStore(summaries: readonly SummaryRecord[]): {
	store: SynthesisStore;
	written: SynthesizedRow[];
	writeCalls: string[];
	versions: { path: string; summary: string; version: number }[];
} {
	const written: SynthesizedRow[] = [];
	const writeCalls: string[] = [];
	const present = new Set<string>();
	// PRD-046b: an append-only version log per path (the version-bump refresh). Each
	// `refreshRow` appends a row at the next version; `readLatestVersionedRow` reads the max.
	const versions: { path: string; summary: string; version: number }[] = [];
	const store: SynthesisStore = {
		async readSummaries(): Promise<readonly SummaryRecord[]> {
			// Mirror the real read's ordering (by path ascending) so the render is deterministic.
			return [...summaries].sort((a, b) => a.path.localeCompare(b.path));
		},
		async writeRow(row: SynthesizedRow): Promise<SynthesisWriteOutcome> {
			writeCalls.push(row.path);
			const already = present.has(row.path);
			if (!already) {
				present.add(row.path);
				written.push(row);
			}
			return { written: !already };
		},
		async refreshRow(row: SynthesizedRow) {
			// Append at version N+1 over the prior highest for this path (NEVER an in-place edit).
			const priorMax = versions
				.filter((v) => v.path === row.path)
				.reduce((m, v) => Math.max(m, v.version), 0);
			const version = priorMax + 1;
			versions.push({ path: row.path, summary: row.summary, version });
			return { version };
		},
		async readLatestVersionedRow(path: string) {
			const forPath = versions.filter((v) => v.path === path);
			if (forPath.length === 0) return null;
			return forPath.reduce((best, v) => (v.version > best.version ? v : best));
		},
	};
	return { store, written, writeCalls, versions };
}

describe("PRD-017b wiki synthesis", () => {
	it("b-AC-1: summaries exist → MEMORY.md is written under the memory path linking the relevant summaries", async () => {
		const summaries = [
			summaryRecord("alice", "sess-1", "refactored the auth module"),
			summaryRecord("bob", "sess-2", "fixed the recall ranking"),
		];
		const { store, written } = recordingStore(summaries);

		const result = await synthesizeMemoryIndex({ store });

		expect(result.path).toBe(MEMORY_INDEX_PATH); // "/MEMORY.md"
		expect(result.written).toBe(true);
		expect(result.linkedSummaries).toBe(2);

		// One MEMORY.md row written, and its body LINKS each per-session summary by its
		// own /summaries/… path (the VFS-resolvable link target, b-AC-5).
		expect(written).toHaveLength(1);
		const body = written[0]?.summary ?? "";
		expect(body).toContain("# MEMORY.md");
		expect(body).toContain("(/summaries/alice/sess-1.md)");
		expect(body).toContain("(/summaries/bob/sess-2.md)");
		expect(body).toContain("refactored the auth module");
	});

	it("b-AC-2: a session resumed across --resume/--continue → the thread head reflects the MERGED session, no dup", async () => {
		// A resumed session keeps the SAME logical sessionId, so 017a wrote ONE summary at
		// /summaries/<userName>/<sessionId>.md across the resume. The lineage key is
		// invariant under the resume → one thread head, never a duplicate entry.
		const sameSession = summaryRecord("alice", "sess-RESUMED", "long session continued via --resume");
		// Distinct sessions for the same user → distinct thread keys (sanity that we group by lineage).
		const other = summaryRecord("alice", "sess-OTHER", "a different session");

		const { store, written, writeCalls } = recordingStore([sameSession, other]);

		const results = await synthesizeThreadHeads({ store });

		// The lineage key is <userName>/<sessionId>, stable across a resume.
		expect(threadKeyOf(sameSession.path)).toBe("alice/sess-RESUMED");
		// One head per DISTINCT session lineage — no duplicate for the resumed session.
		const resumedPath = threadHeadPath("alice/sess-RESUMED");
		const headsForResumed = written.filter((r) => r.path === resumedPath);
		expect(headsForResumed).toHaveLength(1);
		expect(results.filter((r) => r.threadKey === "alice/sess-RESUMED")).toHaveLength(1);
		// Two distinct sessions → two distinct heads, no duplicate write for either.
		expect(new Set(writeCalls).size).toBe(writeCalls.length);
		expect(written).toHaveLength(2);

		// A RE-SYNTHESIS (the resume fires synthesis again over the same merged session) does
		// NOT create a second head — SELECT-before-INSERT sees the existing head (b-AC-4).
		const second = await synthesizeThreadHeads({ store });
		expect(second.find((r) => r.threadKey === "alice/sess-RESUMED")?.written).toBe(false);
		expect(written.filter((r) => r.path === resumedPath)).toHaveLength(1); // still ONE head
	});

	it("b-AC-3: every synthesis read + write is dispatched through the daemon StorageQuery (never a direct DeepLake connection)", async () => {
		// Drive the REAL createSynthesisStore over a FakeDeepLakeTransport: every read + write
		// reaches storage ONLY through the daemon-side StorageQuery (the transport records every
		// statement). There is no other path — the store takes a StorageQuery, never opens DeepLake.
		const seededSummaryPath = "/summaries/alice/sess-1.md";
		const fake = new FakeDeepLakeTransport((req) => {
			const sql = req.sql.toUpperCase();
			// The tenant-scoped summary read (LIKE /summaries/%) → return one seeded summary row.
			if (sql.startsWith("SELECT") && req.sql.includes("/summaries/") && req.sql.includes("LIKE")) {
				return [{ path: seededSummaryPath, description: "seeded summary", author: "alice" }];
			}
			// The SBI existence probe for /MEMORY.md → empty (absent) so the insert runs.
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const store = createSynthesisStore(storage, SCOPE);

		const result = await synthesizeMemoryIndex({ store });
		expect(result.written).toBe(true);
		expect(result.linkedSummaries).toBe(1);

		// Every statement carried the tenant scope to the wire (b-AC-6 partition) and the
		// read + write both went through this single transport (the daemon's StorageQuery).
		expect(fake.requests.length).toBeGreaterThanOrEqual(2); // summary read + (probe + insert)
		for (const req of fake.requests) {
			expect(req.org).toBe(SCOPE.org);
			expect(req.workspace).toBe(SCOPE.workspace);
		}
		// The summary read AND the MEMORY.md insert both appear on the SAME transport.
		expect(fake.requests.some((r) => /LIKE/i.test(r.sql) && r.sql.includes("/summaries/"))).toBe(true);
		expect(fake.requests.some((r) => /INSERT\s+INTO/i.test(r.sql) && r.sql.includes("/MEMORY.md"))).toBe(true);
	});

	it("b-AC-4: re-synthesis over an existing MEMORY.md uses SELECT-before-INSERT — NO in-place UPDATE is emitted", async () => {
		// Drive the REAL createSynthesisStore over a FakeDeepLakeTransport and inspect every
		// statement: the write must be a probe SELECT + an INSERT keyed on `path`, and there
		// must be ZERO `UPDATE "memory" SET …` emitted (the in-place-UPDATE ban).
		const fake = new FakeDeepLakeTransport((req) => {
			const sql = req.sql.toUpperCase();
			// The summary read → one summary so the index links something.
			if (sql.startsWith("SELECT") && req.sql.includes("/summaries/") && req.sql.includes("LIKE")) {
				return [{ path: "/summaries/alice/sess-1.md", description: "x", author: "alice" }];
			}
			// The SBI probe on /MEMORY.md → empty (absent) so the insert runs.
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const store = createSynthesisStore(storage, SCOPE);

		await synthesizeMemoryIndex({ store });

		const statements = fake.requests.map((r) => r.sql);
		// At least one INSERT INTO "memory" keyed on the /MEMORY.md path.
		expect(statements.some((s) => /INSERT\s+INTO\s+"memory"/i.test(s))).toBe(true);
		expect(statements.some((s) => s.includes(MEMORY_INDEX_PATH))).toBe(true);
		// A probe SELECT keyed on the path that EXCLUDES the in-progress placeholder marker.
		expect(statements.some((s) => /SELECT/i.test(s) && s.includes(MEMORY_INDEX_PATH) && /in progress/i.test(s))).toBe(true);
		// THE invariant: no in-place UPDATE of the memory table anywhere.
		expect(statements.some((s) => /UPDATE\s+"memory"\s+SET/i.test(s)), "no in-place UPDATE on memory").toBe(false);
	});

	it("b-AC-4 (exactly-once): a re-synthesis over an already-present index does NOT write a second MEMORY.md row", async () => {
		const summaries = [summaryRecord("alice", "sess-1", "x")];
		const { store, written } = recordingStore(summaries);

		const first = await synthesizeMemoryIndex({ store });
		const second = await synthesizeMemoryIndex({ store });

		expect(first.written).toBe(true);
		expect(second.written).toBe(false); // already present → exactly-once, no UPDATE
		expect(written.filter((r) => r.path === MEMORY_INDEX_PATH)).toHaveLength(1);
	});

	it("b-AC-5: a MEMORY.md link target is a resolvable /summaries/… path — the VFS read precedence resolves it to the summary", async () => {
		// Render a MEMORY.md, extract a link target, and prove that target is a /summaries/…
		// path the PRD-015 VFS read precedence resolves to the per-session summary BODY (its
		// tier-6 direct memory.summary read).
		const summaries = [summaryRecord("alice", "sess-1", "refactored auth")];
		const body = renderMemoryIndex(summaries);

		// The link target the index points at.
		const match = /\]\((\/summaries\/[^)]+)\)/.exec(body);
		expect(match, "MEMORY.md contains a /summaries/ link").not.toBeNull();
		const linkTarget = match?.[1] ?? "";
		expect(linkTarget).toBe("/summaries/alice/sess-1.md");

		// The VFS read precedence: tier 6 reads the `memory.summary` for the path (it normalizes
		// the leading slash via toMountRelative, then SELECTs `FROM "memory" WHERE path = …`).
		// Seed a fake daemon dispatch that returns the summary body for the memory summary read →
		// resolveRead returns the body. This proves the link TARGET RESOLVES to the summary (b-AC-5).
		const SUMMARY_BODY = "## Summary\nRefactored the auth module.";
		const vfsScope: VfsScope = { org: "o1", workspace: "ws1" };
		const dispatch = createFakeDaemonDispatch({
			respond: (sql) => {
				// Tier 6: SELECT summary FROM "memory" WHERE path = '<normalized link target>' …
				if (/SELECT\s+summary\s+FROM\s+"memory"/i.test(sql)) return [{ summary: SUMMARY_BODY }];
				return [];
			},
		});
		const deps: ReadDeps = {
			dispatch,
			scope: vfsScope,
			cache: new Map<string, string>(),
			pending: new Map(),
			snapshots: createFakeSnapshotLoader(null),
		};

		const resolved = await resolveRead(linkTarget, deps);
		expect(resolved).toBe(SUMMARY_BODY);
		// The resolution reached storage through the daemon dispatch seam (the only path out),
		// and the dispatched memory read keys on the link target's mount-relative path.
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0]?.sql).toMatch(/SELECT\s+summary\s+FROM\s+"memory"/i);
		expect(dispatch.calls[0]?.sql).toContain("summaries/alice/sess-1.md"); // the (normalized) link target
	});

	it("b-AC-6: two tenants → each MEMORY.md reflects ONLY its own org/workspace/agent-scoped summaries", async () => {
		// Each tenant's store is constructed with its OWN scope; the real read carries that
		// scope on the dispatch so the daemon partitions by it. Here we model that with two
		// fake stores seeded with disjoint summaries (the daemon would return only the
		// tenant's rows). Each MEMORY.md links ONLY its own tenant's summaries.
		const tenantA = [summaryRecord("alice", "a-1", "tenant A work")];
		const tenantB = [summaryRecord("bob", "b-1", "tenant B work")];
		const a = recordingStore(tenantA);
		const b = recordingStore(tenantB);

		await synthesizeMemoryIndex({ store: a.store });
		await synthesizeMemoryIndex({ store: b.store });

		const bodyA = a.written[0]?.summary ?? "";
		const bodyB = b.written[0]?.summary ?? "";
		// A's index links ONLY A's summary; B's links ONLY B's. No cross-tenant leak.
		expect(bodyA).toContain("/summaries/alice/a-1.md");
		expect(bodyA).not.toContain("/summaries/bob/b-1.md");
		expect(bodyB).toContain("/summaries/bob/b-1.md");
		expect(bodyB).not.toContain("/summaries/alice/a-1.md");

		// And the REAL store carries the per-tenant scope to the wire so the partition is real.
		const fakeA = new FakeDeepLakeTransport(() => []); // no summaries → empty index, scope still asserted
		const storageA = createStorageClient({ transport: fakeA, provider: stubProvider(fakeCredentialRecord()) });
		await synthesizeMemoryIndex({ store: createSynthesisStore(storageA, { org: "orgA", workspace: "wsA" }) });
		for (const req of fakeA.requests) {
			expect(req.org).toBe("orgA");
			expect(req.workspace).toBe("wsA");
		}
	});

	it("threadKeyOf: the lineage key is the per-session identity, invariant under a resume", () => {
		// The same logical session → the same key, regardless of how many times it resumed.
		expect(threadKeyOf("/summaries/alice/sess-42.md")).toBe("alice/sess-42");
		// An off-convention path falls back to its trailing filename (no .md), still a stable key.
		expect(threadKeyOf("/other/weird/path.md")).toBe("path");
		expect(threadHeadPath("alice/sess-42")).toBe("/threads/alice/sess-42.md");
	});

	it("renderMemoryIndex: an empty corpus renders a valid placeholder index (no links)", () => {
		const body = renderMemoryIndex([]);
		expect(body).toContain("# MEMORY.md");
		expect(body).toContain("No session summaries yet");
		expect(body).not.toContain("/summaries/");
	});
});

describe("PRD-046b b-AC-1 — /MEMORY.md REFRESHES (version-bumped) as new summaries land, never a no-op", () => {
	it("a re-synthesis after a new summary lands writes a SECOND index at a HIGHER version (not a no-op)", async () => {
		// Mutable corpus: starts with one summary, then a second lands before the re-synthesis.
		const corpus: SummaryRecord[] = [summaryRecord("alice", "sess-1", "first session")];
		const versions: { path: string; summary: string; version: number }[] = [];
		const store: SynthesisStore = {
			async readSummaries() {
				return [...corpus].sort((a, b) => a.path.localeCompare(b.path));
			},
			async writeRow(): Promise<SynthesisWriteOutcome> {
				return { written: true };
			},
			async refreshRow(row) {
				const priorMax = versions.filter((v) => v.path === row.path).reduce((m, v) => Math.max(m, v.version), 0);
				const version = priorMax + 1;
				versions.push({ path: row.path, summary: row.summary, version });
				return { version };
			},
			async readLatestVersionedRow(path) {
				const forPath = versions.filter((v) => v.path === path);
				if (forPath.length === 0) return null;
				return forPath.reduce((best, v) => (v.version > best.version ? v : best));
			},
		};

		// First refresh: version 1, links the one summary.
		const first = await refreshMemoryIndex({ store });
		expect(first.path).toBe(MEMORY_INDEX_PATH);
		expect(first.version).toBe(1);
		expect(first.linkedSummaries).toBe(1);

		// A NEW summary lands, then a RE-SYNTHESIS runs (the mount fires it as summaries land).
		corpus.push(summaryRecord("bob", "sess-2", "second session"));
		const second = await refreshMemoryIndex({ store });

		// NOT a no-op: the index was REWRITTEN at a HIGHER version, and the current
		// (highest-version) index now links BOTH summaries.
		expect(second.version).toBe(2);
		expect(second.linkedSummaries).toBe(2);
		const current = await store.readLatestVersionedRow(MEMORY_INDEX_PATH);
		expect(current?.version).toBe(2);
		expect(current?.summary).toContain("/summaries/alice/sess-1.md");
		expect(current?.summary).toContain("/summaries/bob/sess-2.md");
		// Both physical versions exist on disk (append-only history), never an in-place edit.
		expect(versions.filter((v) => v.path === MEMORY_INDEX_PATH)).toHaveLength(2);
	});

	it("the REAL createSynthesisStore refresh APPENDS a version-bumped row — ZERO in-place UPDATE on memory", async () => {
		// Drive the REAL store over a FakeDeepLakeTransport and inspect every statement: the
		// refresh must read MAX(version), INSERT a fresh row, and emit NO `UPDATE "memory" SET`.
		const fake = new FakeDeepLakeTransport((req) => {
			const sql = req.sql;
			// The tenant summary read → one summary so the index links something.
			if (/SELECT/i.test(sql) && sql.includes("/summaries/") && /LIKE/i.test(sql)) {
				return [{ path: "/summaries/alice/sess-1.md", description: "x", author: "alice" }];
			}
			// The MAX(version) read for the path → empty (first refresh) → version resolves to 1.
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const store = createSynthesisStore(storage, SCOPE);

		const result = await refreshMemoryIndex({ store });
		expect(result.version).toBe(1);
		expect(result.linkedSummaries).toBe(1);

		const statements = fake.requests.map((r) => r.sql);
		// An INSERT INTO "memory" carrying the bumped version + the /MEMORY.md path.
		expect(statements.some((s) => /INSERT\s+INTO\s+"memory"/i.test(s))).toBe(true);
		expect(statements.some((s) => s.includes(MEMORY_INDEX_PATH))).toBe(true);
		expect(statements.some((s) => /INSERT\s+INTO\s+"memory"/i.test(s) && /\bversion\b/i.test(s))).toBe(true);
		// A MAX(version) read keyed on the path (ORDER BY version DESC) drives the bump.
		expect(statements.some((s) => /SELECT/i.test(s) && /version/i.test(s) && /ORDER BY/i.test(s))).toBe(true);
		// THE invariant: no in-place UPDATE of the memory table anywhere (b-AC-1 / no in-place UPDATE).
		expect(statements.some((s) => /UPDATE\s+"memory"\s+SET/i.test(s)), "no in-place UPDATE on memory").toBe(false);
		// Every statement carried the tenant scope (b-AC-6).
		for (const req of fake.requests) {
			expect(req.org).toBe(SCOPE.org);
			expect(req.workspace).toBe(SCOPE.workspace);
		}
	});
});
