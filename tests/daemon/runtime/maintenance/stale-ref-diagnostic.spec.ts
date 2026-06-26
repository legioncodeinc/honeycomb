/**
 * PRD-058c — the stale-reference diagnostic suite (the `σ(m,t)` term).
 *
 * Acceptance criteria → tests:
 *   58c.1.1 absent symbol → resolve=0, σ=1, stale, verified_at=now, stale_refs recorded.
 *   58c.1.2 all resolve → σ≈0, fresh.
 *   58c.1.3 out-of-graph → excluded, unknown never stale.
 *   58c.1.4 no indexed refs → σ=0, never demoted (unknown).
 *   58c.1.5 fuzzy rename → resolve=sim∈(0,1), partial demote (stale, sim recorded).
 *   58c.2.4 detection/heal → memory_history(actor, reason, σ, stale_refs).
 *   58c.3.2 stale memory + new snapshot → re-verification re-checks (fresh→stale→fresh).
 *   58c.3.3 snapshot reads poll to convergence, not a single read; a transient stale segment does
 *           not persist a `stale` verdict.
 *   Plus: fail-soft on a missing graph (everything unknown, nothing stale); v(m,t) half-life math.
 */

import { describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../../src/daemon/storage/result.js";
import type { GraphNode, Snapshot } from "../../../../src/daemon/runtime/codebase/contracts.js";
import {
	bestRenameSim,
	buildResolutionIndex,
	DEFAULT_H_VERIFY_DAYS,
	resolveReference,
	runStaleRefDiagnostic,
	scoreStaleness,
	verificationFreshness,
	type SnapshotProvider,
} from "../../../../src/daemon/runtime/maintenance/stale-ref-diagnostic.js";
import { extractReferences } from "../../../../src/daemon/runtime/maintenance/reference-extract.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };
const NOW = Date.parse("2026-06-26T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Build a minimal symbol node. */
function symbolNode(sourceFile: string, name: string): GraphNode {
	return {
		id: `${sourceFile}#${name}`,
		kind: "symbol",
		name,
		sourceFile,
		language: "typescript",
		symbolKind: "function",
		exported: true,
		observation: { startLine: 1, endLine: 2 },
	};
}

/** Build a minimal file node. */
function fileNode(sourceFile: string): GraphNode {
	return { id: sourceFile, kind: "file", name: sourceFile, sourceFile, language: "typescript", observation: { startLine: 1, endLine: 1 } };
}

/** Assemble a snapshot from nodes (volatile observation is required but arbitrary). */
function snapshotOf(nodes: readonly GraphNode[]): Snapshot {
	return {
		directed: true,
		multigraph: true,
		graph: {},
		nodes,
		links: [],
		observation: {
			generatedAt: new Date(NOW).toISOString(),
			generatorVersion: "test",
			fileCount: 1,
			nodeCount: nodes.length,
			edgeCount: 0,
			parseErrorCount: 0,
		},
	};
}

/** A static snapshot provider (no polling — the converged fake). */
function staticProvider(snapshot: Snapshot | null): SnapshotProvider {
	return { load: async () => snapshot };
}

/** A recording StorageQuery: returns `ok` (one row on SELECT so update-or-insert takes the UPDATE branch). */
function recordingStorage(): { storage: StorageQuery; sql: string[] } {
	const sql: string[] = [];
	const storage = {
		async query(statement: string): Promise<QueryResult> {
			sql.push(statement);
			// A SELECT (the update-or-insert existence probe) returns one row so it UPDATEs in place.
			const rows = /^\s*SELECT/i.test(statement) ? [{ id: "x" }] : [];
			return { kind: "ok", rows, durationMs: 0 } as QueryResult;
		},
	} as unknown as StorageQuery;
	return { storage, sql };
}

// ── resolve(r, G_t) classification (58c.1.x) ──────────────────────────────────

describe("PRD-058c resolveReference — the resolve(r, G_t) classification", () => {
	const index = buildResolutionIndex(snapshotOf([fileNode("src/foo/bar.ts"), symbolNode("src/foo/bar.ts", "doThing")]));

	it("58c.1.2 an exact file#symbol match resolves to 1", () => {
		const [ref] = extractReferences("see src/foo/bar.ts#doThing");
		expect(resolveReference(ref!, index)).toMatchObject({ resolve: 1, excluded: false });
	});

	it("58c.1.2 an exact path match resolves to 1", () => {
		const [ref] = extractReferences("the file src/foo/bar.ts");
		expect(resolveReference(ref!, index)).toMatchObject({ resolve: 1, excluded: false });
	});

	it("58c.1.1 an indexed-shaped but absent symbol resolves to 0 (dangling)", () => {
		const [ref] = extractReferences("see src/foo/bar.ts#gone");
		// gone is not a symbol and is not close to doThing → 0.
		expect(resolveReference(ref!, index).resolve).toBe(0);
	});

	it("58c.1.3 an out-of-graph reference (npm/node_modules path) is EXCLUDED, never stale", () => {
		const [ref] = extractReferences("imported from node_modules/left-pad/index.js here");
		const r = resolveReference(ref!, index);
		expect(r.excluded).toBe(true);
		expect(r.resolve).toBe(1); // excluded contributes nothing (neutral).
	});

	it("58c.1.3 a bare package `module#symbol` (react#createRoot) is EXCLUDED → unknown, NEVER scored stale", () => {
		// The bare `module#symbol` extractor rule emits a `file-symbol` whose `file` is a package
		// specifier (`react`), NOT a repo path. Such an external reference must be EXCLUDED (unknown),
		// never resolved against the graph and scored dangling/stale — the false-stale PRD-058c.1.3 forbids.
		const [ref] = extractReferences("we call react#createRoot to mount");
		expect(ref!.kind).toBe("file-symbol");
		expect(ref!.file).toBe("react"); // bare module, no repo path.
		const r = resolveReference(ref!, index);
		expect(r.excluded).toBe(true); // out-of-graph → neutral.
		expect(r.resolve).toBe(1); // contributes nothing to σ (never a false stale).
	});

	it("58c a REPO-shaped file-symbol (src/foo/bar.ts#sym) is still in-graph — the exclusion only narrows bare modules", () => {
		// Guard against over-narrowing: a real repo path with a #symbol must STILL be treated as indexed
		// (so a genuinely-absent in-repo symbol can be scored dangling). Only the bare-module case is excluded.
		const [ref] = extractReferences("see src/foo/bar.ts#gone");
		const r = resolveReference(ref!, index);
		expect(r.excluded).toBe(false); // repo-shaped → in-graph; absence is meaningful.
		expect(r.resolve).toBe(0); // indexed-but-absent → dangling.
	});

	it("58c.1.5 a close fuzzy rename candidate resolves to sim ∈ (0,1)", () => {
		const [ref] = extractReferences("see src/foo/bar.ts#doThng"); // typo of doThing
		const r = resolveReference(ref!, index);
		expect(r.resolve).toBeGreaterThan(0);
		expect(r.resolve).toBeLessThan(1);
	});

	// ── round-2 #3: a SCOPED package `@scope/pkg#symbol` is external (its `/` must NOT make it repo-shaped) ──
	it("58c.1.3 a scoped-package `@scope/pkg#symbol` is EXCLUDED → unknown, NEVER stale (the `/` does not make it repo-shaped)", () => {
		// A scoped npm specifier contains a `/` but is an EXTERNAL package, never indexed repo code. The
		// extractor's bare-module rule emits a file-symbol whose `file` is the scoped specifier; the diagnostic
		// must EXCLUDE it (neutral/unknown), never resolve it against the graph and score a false `stale`.
		const ref = { raw: "@scope/pkg#symbol", kind: "file-symbol" as const, file: "@scope/pkg", symbol: "symbol" };
		const r = resolveReference(ref, index);
		expect(r.excluded).toBe(true); // out-of-graph → neutral.
		expect(r.resolve).toBe(1); // contributes nothing to σ (never a false stale).
	});

	it("58c.1.3 a scoped-package with a sub-path `@scope/pkg/dist#symbol` is also EXCLUDED → unknown", () => {
		const ref = { raw: "@scope/pkg/dist#symbol", kind: "file-symbol" as const, file: "@scope/pkg/dist", symbol: "symbol" };
		const r = resolveReference(ref, index);
		expect(r.excluded).toBe(true);
		expect(r.resolve).toBe(1);
	});

	it("58c a REAL repo file-symbol (src/daemon/x.ts#sym) is STILL in-graph (the scoped-package guard does not over-exclude)", () => {
		// Guard against over-narrowing: a genuine `/`-separated source path with a #symbol must remain in-graph
		// so a truly-absent in-repo symbol can be scored dangling. Only the scoped-package case is excluded.
		const ref = { raw: "src/daemon/x.ts#sym", kind: "file-symbol" as const, file: "src/daemon/x.ts", symbol: "sym" };
		const r = resolveReference(ref, index);
		expect(r.excluded).toBe(false); // repo-shaped → in-graph; absence is meaningful.
		expect(r.resolve).toBe(0); // indexed-but-absent → dangling.
	});
});

describe("PRD-058c bestRenameSim", () => {
	const index = buildResolutionIndex(snapshotOf([symbolNode("a.ts", "computeSnapshotSha256")]));
	it("a one-char typo clears the floor with a high sim", () => {
		expect(bestRenameSim("computeSnapshotSha25", index)).toBeGreaterThan(0.7);
	});
	it("a wholly different token returns 0", () => {
		expect(bestRenameSim("zzz", index)).toBe(0);
	});
});

// ── σ product + empty-product (58c.1.1/1.2/1.4) ───────────────────────────────

describe("PRD-058c scoreStaleness — the σ product", () => {
	const index = buildResolutionIndex(snapshotOf([fileNode("src/a.ts"), symbolNode("src/a.ts", "keep")]));

	it("58c.1.4 no indexed refs → σ=0, unknown, never demoted", () => {
		const v = scoreStaleness([]);
		expect(v).toMatchObject({ sigma: 0, refStatus: "unknown", indexedCount: 0 });
	});

	it("58c.1.2 every ref resolves → σ≈0, fresh", () => {
		const refs = extractReferences("src/a.ts and src/a.ts#keep").map((r) => resolveReference(r, index));
		const v = scoreStaleness(refs);
		expect(v.sigma).toBeCloseTo(0, 10);
		expect(v.refStatus).toBe("fresh");
	});

	it("58c.1.1 a dangling ref → σ=1, stale, the unresolved token recorded", () => {
		const refs = extractReferences("src/a.ts#missing").map((r) => resolveReference(r, index));
		const v = scoreStaleness(refs);
		expect(v.sigma).toBe(1);
		expect(v.refStatus).toBe("stale");
		expect(v.staleRefs).toContain("src/a.ts#missing");
	});

	it("58c.1.3 an out-of-graph ref alongside no indexed refs → unknown (excluded does not enter product)", () => {
		const refs = extractReferences("node_modules/x/y.js only").map((r) => resolveReference(r, index));
		expect(scoreStaleness(refs)).toMatchObject({ refStatus: "unknown", sigma: 0 });
	});
});

// ── v(m,t) half-life (58c.3.1 inputs) ─────────────────────────────────────────

describe("PRD-058c verificationFreshness — v(m,t) = 2^(−Δt/h_verify)", () => {
	it("v = 1 at Δt = 0", () => {
		expect(verificationFreshness(NOW, NOW)).toBeCloseTo(1, 10);
	});
	it("v = 0.5 at Δt = h_verify (the half-life identity)", () => {
		const verifiedAt = NOW - DEFAULT_H_VERIFY_DAYS * MS_PER_DAY;
		expect(verificationFreshness(verifiedAt, NOW)).toBeCloseTo(0.5, 6);
	});
	it("a never-verified memory (null) → v = 0 (fully decayed, always due)", () => {
		expect(verificationFreshness(null, NOW)).toBe(0);
	});
	it("a future verified_at (clock skew) clamps to v = 1, never > 1", () => {
		expect(verificationFreshness(NOW + MS_PER_DAY, NOW)).toBeLessThanOrEqual(1);
	});
});

// ── the diagnostic: write + audit + fail-soft (58c.1.1/2.4 + missing graph) ───

describe("PRD-058c runStaleRefDiagnostic — write, audit, posture", () => {
	const snapshot = snapshotOf([fileNode("src/a.ts"), symbolNode("src/a.ts", "keep")]);

	it("58c.1.1 a stale memory → ref_status='stale', verified_at written, stale_refs recorded", async () => {
		const { storage, sql } = recordingStorage();
		const report = await runStaleRefDiagnostic(
			[{ id: "m1", content: "the helper src/a.ts#gone is the path" }],
			SCOPE,
			"observe",
			{ storage, snapshots: staticProvider(snapshot), now: () => NOW, newId: () => "h1" },
		);
		expect(report.results[0]).toMatchObject({ id: "m1", refStatus: "stale", written: true });
		expect(report.results[0]!.sigma).toBe(1);
		// The columns were updated and the verified_at stamped.
		const update = sql.find((s) => /UPDATE\s+"memories"/i.test(s));
		expect(update).toBeDefined();
		expect(update).toMatch(/ref_status/i);
		expect(update).toMatch(/verified_at/i);
		expect(update).toMatch(/2026-06-26/);
	});

	it("58c.2.4 a detection appends a memory_history row with the pipeline actor + σ + stale_refs", async () => {
		const { storage, sql } = recordingStorage();
		await runStaleRefDiagnostic([{ id: "m2", content: "src/a.ts#gone" }], SCOPE, "execute", {
			storage,
			snapshots: staticProvider(snapshot),
			now: () => NOW,
			newId: () => "h2",
		});
		const history = sql.find((s) => /INSERT INTO\s+"memory_history"/i.test(s));
		expect(history).toBeDefined();
		expect(history).toMatch(/stale-ref-detect/);
		expect(history).toMatch(/pipeline/);
		expect(history).toMatch(/"posture":"execute"/);
		expect(history).toMatch(/stale-ref-diagnostic/);
	});

	it("58c.1.2 a fresh memory → ref_status='fresh', σ≈0", async () => {
		const { storage } = recordingStorage();
		const report = await runStaleRefDiagnostic([{ id: "m3", content: "src/a.ts#keep stays" }], SCOPE, "observe", {
			storage,
			snapshots: staticProvider(snapshot),
			now: () => NOW,
		});
		expect(report.results[0]).toMatchObject({ refStatus: "fresh" });
		expect(report.results[0]!.sigma).toBeCloseTo(0, 10);
	});

	it("fail-soft: a missing graph oracle marks NOTHING stale (everything unknown), nothing flagged", async () => {
		const { storage, sql } = recordingStorage();
		const logs: string[] = [];
		const report = await runStaleRefDiagnostic(
			[{ id: "m4", content: "src/a.ts#gone would be stale if the graph were present" }],
			SCOPE,
			"execute",
			{ storage, snapshots: staticProvider(null), now: () => NOW, log: (e) => logs.push(e) },
		);
		expect(report.graphUnavailable).toBe(true);
		expect(report.results.every((r) => r.refStatus === "unknown" && r.sigma === 0)).toBe(true);
		expect(logs.some((l) => l.includes("graph-unavailable"))).toBe(true);
		// The write still stamps `unknown` (neutral) but never `stale`.
		expect(sql.some((s) => /'stale'/.test(s))).toBe(false);
	});

	// ── round-2 #4: an UNREADABLE prior verdict ABORTS before any audit/projection write ──
	it("a prior-verdict READ ERROR aborts the memory (written:false, NO history append, NO projection update)", async () => {
		// The prior-verdict read (the `memories` SELECT capturing before_payload) FAILS. Treating that read
		// error as an empty prior would let the audit append a FABRICATED before_payload and then mutate the
		// projection, breaking the reconstructable-audit guarantee. The write must abort BEFORE either write.
		const sql: string[] = [];
		const failingPriorRead = {
			async query(statement: string): Promise<QueryResult> {
				sql.push(statement);
				// The prior-verdict read is the SELECT over "memories" capturing ref_status/verified_at/stale_refs.
				if (/^\s*SELECT[\s\S]*ref_status[\s\S]*FROM\s+"memories"/i.test(statement)) {
					return { kind: "query_error", message: "prior-read-boom" } as QueryResult;
				}
				return { kind: "ok", rows: /^\s*SELECT/i.test(statement) ? [{ id: "x" }] : [], durationMs: 0 } as QueryResult;
			},
		} as unknown as StorageQuery;
		const report = await runStaleRefDiagnostic([{ id: "m6", content: "src/a.ts#gone" }], SCOPE, "execute", {
			storage: failingPriorRead,
			snapshots: staticProvider(snapshot),
			now: () => NOW,
			newId: () => "h6",
		});
		// The memory aborted fail-soft: written:false, and the batch still completed (never threw).
		expect(report.ok).toBe(true);
		expect(report.results[0]).toMatchObject({ id: "m6", written: false });
		// CRITICAL: NO audit history append and NO projection write landed when the prior could not be read.
		// The projection write is an update-or-insert, so assert BOTH branches are absent: a regression where
		// `updateOrInsertByKey(...)` falls back to an INSERT would slip past a UPDATE-only check (round-3 #4).
		expect(sql.some((s) => /INSERT INTO\s+"memory_history"/i.test(s))).toBe(false);
		expect(sql.some((s) => /UPDATE\s+"memories"/i.test(s))).toBe(false);
		expect(sql.some((s) => /INSERT INTO\s+"memories"/i.test(s))).toBe(false);
	});

	it("fail-soft: a snapshot provider THROW degrades to graphUnavailable, never a thrown pass", async () => {
		const { storage } = recordingStorage();
		const throwing: SnapshotProvider = {
			load: async () => {
				throw new Error("boom");
			},
		};
		const report = await runStaleRefDiagnostic([{ id: "m5", content: "src/a.ts#gone" }], SCOPE, "observe", {
			storage,
			snapshots: throwing,
			now: () => NOW,
		});
		expect(report.graphUnavailable).toBe(true);
		expect(report.results[0]).toMatchObject({ refStatus: "unknown", sigma: 0 });
	});
});

// ── fresh → stale → fresh transition (58c.3.2) ────────────────────────────────

describe("PRD-058c re-verification — fresh → stale → fresh against new snapshots (58c.3.2)", () => {
	const present = snapshotOf([fileNode("src/a.ts"), symbolNode("src/a.ts", "doThing")]);
	const deleted = snapshotOf([fileNode("src/a.ts")]); // doThing removed
	const memory = { id: "m", content: "the call src/a.ts#doThing runs it" };

	it("a symbol present → deleted → re-added flips fresh → stale → fresh", async () => {
		const { storage } = recordingStorage();
		const run = (snap: Snapshot) =>
			runStaleRefDiagnostic([memory], SCOPE, "execute", { storage, snapshots: staticProvider(snap), now: () => NOW });

		expect((await run(present)).results[0]!.refStatus).toBe("fresh");
		expect((await run(deleted)).results[0]!.refStatus).toBe("stale"); // re-checked against the NEW snapshot.
		expect((await run(present)).results[0]!.refStatus).toBe("fresh"); // return lifts the demotion.
	});
});

// ── poll-to-convergence (58c.3.3) ─────────────────────────────────────────────

describe("PRD-058c poll-to-convergence — a transient stale segment does not persist a stale verdict (58c.3.3)", () => {
	it("the provider polls past a transient read and the converged snapshot is the one scored", async () => {
		// Simulate a provider that polls: the FIRST read sees a stale segment (symbol absent), but the
		// converged read (what the provider returns) has the symbol. The diagnostic must score the
		// CONVERGED snapshot, so the memory is fresh, not stale.
		const converged = snapshotOf([fileNode("src/a.ts"), symbolNode("src/a.ts", "doThing")]);
		const provider: SnapshotProvider = { load: vi.fn(async () => converged) };
		const { storage } = recordingStorage();
		const report = await runStaleRefDiagnostic(
			[{ id: "m", content: "src/a.ts#doThing" }],
			SCOPE,
			"execute",
			{ storage, snapshots: provider, now: () => NOW },
		);
		expect(provider.load).toHaveBeenCalledTimes(1); // the diagnostic reads the CONVERGED snapshot once.
		expect(report.results[0]!.refStatus).toBe("fresh");
	});
});
