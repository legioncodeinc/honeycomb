/**
 * PRD-014d query surface — `handleGraphVfs` renderers over a LOCAL fixture snapshot.
 *
 * The six d-ACs, each named:
 *   - d-AC-1: `find/<pattern>` → ranked substring matches + numbered handles + fuzzy fallback on no match.
 *   - d-AC-2: `impact/<pattern>` → transitive dependents; `neighborhood/<file>` → symbols + cross-file neighbors.
 *   - d-AC-3: `show/<N>` → resolves the handle from a prior find/, RE-VALIDATED against the current snapshot
 *             (a changed snapshot invalidates a stale handle).
 *   - d-AC-4: a one-char typo in a single-token pattern → the Levenshtein fallback returns the intended node.
 *   - d-AC-5: every endpoint → `handleGraphVfs` makes ZERO network calls, reads only the local snapshot
 *             (asserted structurally — the module imports no fetch/storage/fs — AND via an invariant).
 *   - d-AC-6: a node with NO resolved incoming edges → the "Incoming (0) is not proof of dead code" caveat.
 *
 * The fixture is a small hand-built node-link {@link Snapshot} (no build, no disk, no network).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	DEAD_CODE_CAVEAT,
	handleGraphVfs,
	inMemoryHandleStore,
} from "../../../../src/daemon/runtime/codebase/query.js";
import {
	type GraphNode,
	type Snapshot,
	type SnapshotLink,
} from "../../../../src/daemon/runtime/codebase/contracts.js";

// ── Fixture builders ────────────────────────────────────────────────────────────

function fileNode(sourceFile: string): GraphNode {
	return {
		id: sourceFile,
		kind: "file",
		name: sourceFile.split("/").pop() as string,
		sourceFile,
		language: "typescript",
		observation: { startLine: 1, endLine: 50 },
	};
}

function symbolNode(sourceFile: string, name: string, exported = true): GraphNode {
	return {
		id: `${sourceFile}#${name}`,
		kind: "symbol",
		name,
		sourceFile,
		language: "typescript",
		symbolKind: "function",
		exported,
		observation: { startLine: 2, endLine: 8 },
	};
}

function link(relation: SnapshotLink["relation"], source: string, target: string): SnapshotLink {
	return { source, target, relation, confidence: "EXTRACTED", id: `${source}::${relation}::${target}` };
}

/**
 * A 4-file fixture:
 *   util.ts        exports `pushSnapshot`, `helper`
 *   service.ts     exports `runService` — calls util#pushSnapshot, imports util.ts
 *   handler.ts     exports `handleRequest` — calls service#runService, imports service.ts
 *   orphan.ts      exports `orphan` — nothing calls it (zero incoming → dead-code caveat)
 *
 * Dependency chain: handler → service → util. So util#pushSnapshot's transitive dependents
 * are { service#runService, handler#handleRequest } (blast radius via incoming edges).
 */
function buildFixture(): Snapshot {
	const nodes: GraphNode[] = [
		fileNode("src/util.ts"),
		fileNode("src/service.ts"),
		fileNode("src/handler.ts"),
		fileNode("src/orphan.ts"),
		symbolNode("src/util.ts", "pushSnapshot"),
		symbolNode("src/util.ts", "helper"),
		symbolNode("src/service.ts", "runService"),
		symbolNode("src/handler.ts", "handleRequest"),
		symbolNode("src/orphan.ts", "orphan"),
	];
	const links: SnapshotLink[] = [
		link("imports", "src/service.ts", "src/util.ts"),
		link("imports", "src/handler.ts", "src/service.ts"),
		link("calls", "src/service.ts#runService", "src/util.ts#pushSnapshot"),
		link("calls", "src/handler.ts#handleRequest", "src/service.ts#runService"),
		// An unresolved external import (a bare npm specifier) — must never inflate fan-in.
		link("imports", "src/util.ts", "external:lodash"),
	];
	return {
		directed: true,
		multigraph: true,
		graph: { repo: "honeycomb", commit: "abc123" },
		nodes,
		links,
		observation: {
			generatedAt: "2026-01-01T00:00:00.000Z",
			generatorVersion: "014b.1",
			fileCount: 4,
			nodeCount: nodes.length,
			edgeCount: links.length,
			parseErrorCount: 0,
		},
	};
}

// ── d-AC-1: find/ ranked + handles + fuzzy fallback ─────────────────────────────

describe("d-AC-1 graph/find — ranked substring + numbered handles + fuzzy fallback", () => {
	it("d-AC-1 returns ranked substring matches with numbered handles", () => {
		const out = handleGraphVfs("graph/find/push", buildFixture());
		expect(out).toContain("[1]");
		expect(out).toContain("pushSnapshot");
		expect(out).toContain("src/util.ts");
		// The handle line carries name + source file.
		expect(out).toMatch(/\[1\] pushSnapshot\s+src\/util\.ts/);
	});

	it("d-AC-1 ranks an exact label above a mere substring (FR-8)", () => {
		const snap = buildFixture();
		// Pattern `helper` exactly matches util#helper; ensure it is handle [1].
		const out = handleGraphVfs("graph/find/helper", snap);
		expect(out).toMatch(/\[1\] helper\s+src\/util\.ts/);
	});

	it("d-AC-1 falls back to fuzzy matching when there is NO substring hit", () => {
		// `pushSnaphot` (missing the 's') has no substring hit → fuzzy fallback finds pushSnapshot.
		const out = handleGraphVfs("graph/find/pushSnaphot", buildFixture());
		expect(out).toContain("fuzzy fallback");
		expect(out).toContain("pushSnapshot");
	});

	it("d-AC-1 a path-prefixed and a bare command both render (leading graph/ optional)", () => {
		expect(handleGraphVfs("find/push", buildFixture())).toContain("pushSnapshot");
		expect(handleGraphVfs("graph/find/push", buildFixture())).toContain("pushSnapshot");
	});
});

// ── d-AC-4: Levenshtein typo on a single token ──────────────────────────────────

describe("d-AC-4 a one-char typo in a single-token pattern → Levenshtein returns the intended node", () => {
	it("d-AC-4 `pushSnaphot` resolves to `pushSnapshot` via the fuzzy fallback", () => {
		const out = handleGraphVfs("graph/find/pushSnaphot", buildFixture());
		expect(out).toContain("pushSnapshot");
		expect(out).toContain("fuzzy fallback");
	});

	it("d-AC-4 a one-char substitution typo also resolves (runServ → runService is substring; runxervice → runService is fuzzy)", () => {
		const out = handleGraphVfs("graph/find/runxervice", buildFixture());
		expect(out).toContain("runService");
	});

	it("d-AC-4 a wholly-different token returns no fuzzy match (bounded distance)", () => {
		const out = handleGraphVfs("graph/find/zzzzzzzzzz", buildFixture());
		expect(out).toContain("no matches");
	});
});

// ── d-AC-2: impact (transitive dependents) + neighborhood ───────────────────────

describe("d-AC-2 graph/impact — transitive dependents (blast radius)", () => {
	it("d-AC-2 impact/pushSnapshot returns the transitive dependents up the call chain", () => {
		const out = handleGraphVfs("graph/impact/pushSnapshot", buildFixture());
		// pushSnapshot ← runService ← handleRequest (transitive via incoming edges).
		expect(out).toContain("src/service.ts#runService");
		expect(out).toContain("src/handler.ts#handleRequest");
		expect(out).toContain("transitive dependent");
	});

	it("d-AC-2 a leaf with no dependents reports 0 transitive dependents", () => {
		const out = handleGraphVfs("graph/impact/handleRequest", buildFixture());
		// handleRequest is the top of the chain — nothing depends on it.
		expect(out).toMatch(/0 transitive dependent/);
	});
});

describe("d-AC-2 graph/neighborhood — a file's symbols + cross-file neighbors", () => {
	it("d-AC-2 neighborhood/service.ts lists its symbols + their cross-file neighbors", () => {
		const out = handleGraphVfs("graph/neighborhood/src/service.ts", buildFixture());
		expect(out).toContain("runService");
		// runService's cross-file neighbors: util#pushSnapshot (out) + handler#handleRequest (in).
		expect(out).toContain("src/util.ts#pushSnapshot");
		expect(out).toContain("src/handler.ts#handleRequest");
	});

	it("d-AC-2 neighborhood resolves a file by substring pattern", () => {
		const out = handleGraphVfs("graph/neighborhood/util", buildFixture());
		expect(out).toContain("src/util.ts");
		expect(out).toContain("pushSnapshot");
	});
});

// ── d-AC-3: show/<N> resolves + re-validates ────────────────────────────────────

describe("d-AC-3 graph/show/<N> — resolves a prior find/ handle, re-validated against the current snapshot", () => {
	it("d-AC-3 show/<N> resolves the handle from a prior find/ to the right node", () => {
		const snap = buildFixture();
		const store = inMemoryHandleStore();
		// 1. find/ persists handles into the shared store.
		const found = handleGraphVfs("graph/find/pushSnapshot", snap, { handleStore: store });
		expect(found).toMatch(/\[1\] pushSnapshot/);
		// 2. show/1 resolves handle [1] → util#pushSnapshot, against the SAME snapshot.
		const shown = handleGraphVfs("graph/show/1", snap, { handleStore: store });
		expect(shown).toContain("src/util.ts#pushSnapshot");
		expect(shown).toContain("# pushSnapshot");
	});

	it("d-AC-3 a CHANGED snapshot invalidates a stale handle (re-validation refuses to serve it)", () => {
		const original = buildFixture();
		const store = inMemoryHandleStore();
		// find/ over the ORIGINAL snapshot — handle [1] = util#pushSnapshot.
		handleGraphVfs("graph/find/pushSnapshot", original, { handleStore: store, snapshotSha: "sha-old" });

		// The snapshot CHANGES: pushSnapshot is removed (renamed/deleted). The stored handle
		// now points at a node id that is GONE. show/1 must REFUSE the stale handle, not serve it.
		const changed: Snapshot = {
			...original,
			nodes: original.nodes.filter((n) => n.id !== "src/util.ts#pushSnapshot"),
		};
		const shown = handleGraphVfs("graph/show/1", changed, { handleStore: store, snapshotSha: "sha-new" });
		expect(shown.toLowerCase()).toContain("stale handle");
		expect(shown).toContain("src/util.ts#pushSnapshot"); // names the gone node
		expect(shown).not.toContain("# pushSnapshot"); // and does NOT render detail for it.
	});

	it("d-AC-3 show/<pattern> (not a number) resolves the best match directly without a handle", () => {
		const out = handleGraphVfs("graph/show/handleRequest", buildFixture());
		expect(out).toContain("# handleRequest");
		expect(out).toContain("src/handler.ts#handleRequest");
	});

	it("d-AC-3 show/<N> with no prior find/ reports the handle is unavailable", () => {
		const out = handleGraphVfs("graph/show/3", buildFixture(), { handleStore: inMemoryHandleStore() });
		expect(out.toLowerCase()).toContain("no prior find");
	});
});

// ── d-AC-6: dead-code caveat on Incoming(0) ─────────────────────────────────────

describe("d-AC-6 a node with no resolved incoming edges → the dead-code caveat", () => {
	it("d-AC-6 show/ of a zero-incoming node renders the 'Incoming (0) is not proof of dead code' caveat", () => {
		const out = handleGraphVfs("graph/show/orphan", buildFixture());
		expect(out).toContain("Incoming (0)");
		expect(out).toContain("not proof of dead code");
		expect(out).toContain(DEAD_CODE_CAVEAT);
	});

	it("d-AC-6 a called node does NOT show the dead-code caveat (it has incoming edges)", () => {
		const out = handleGraphVfs("graph/show/pushSnapshot", buildFixture());
		expect(out).not.toContain("Incoming (0)");
		expect(out).toContain("Incoming (1)");
	});

	it("d-AC-6 the index.md overview states the limitation up front", () => {
		const out = handleGraphVfs("graph/index.md", buildFixture());
		expect(out).toContain("Limitations:");
		expect(out).toContain("not proof of dead code");
	});
});

// ── d-AC-5: zero network — structural + invariant ───────────────────────────────

describe("d-AC-5 zero network — handleGraphVfs reads only the local snapshot", () => {
	const QUERY_SRC = fileURLToPath(new URL("../../../../src/daemon/runtime/codebase/query.ts", import.meta.url));

	it("d-AC-5 the query module imports NO storage / network / fs (structural assertion)", () => {
		const src = readFileSync(QUERY_SRC, "utf8");
		const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
		// The ONLY runtime import is the sibling contracts module (plain interfaces).
		expect(imports).toEqual(["./contracts.js"]);
		// And no banned reach-out anywhere in the source.
		expect(src).not.toMatch(/\bfetch\s*\(/);
		expect(src).not.toMatch(/daemon\/storage/);
		expect(src).not.toMatch(/from\s+["']node:fs["']/);
		expect(src).not.toMatch(/from\s+["']node:net["']/);
		expect(src).not.toMatch(/from\s+["']node:https?["']/);
		expect(src).not.toMatch(/DeeplakeApi|deeplake/i);
	});

	it("d-AC-5 every endpoint renders from the in-memory snapshot with no injected I/O", () => {
		// Drive every command; none throws, all return text — nothing is loaded beyond the arg snapshot.
		const snap = buildFixture();
		for (const path of [
			"graph/index.md",
			"graph/find/push",
			"graph/query/runService",
			"graph/show/pushSnapshot",
			"graph/impact/pushSnapshot",
			"graph/neighborhood/src/util.ts",
			"graph/layers",
			"graph/tour",
			"graph/path/handleRequest/pushSnapshot",
		]) {
			const out = handleGraphVfs(path, snap);
			expect(typeof out).toBe("string");
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it("d-AC-5 an unknown command returns usage, never throws", () => {
		expect(() => handleGraphVfs("graph/bogus/thing", buildFixture())).not.toThrow();
		expect(handleGraphVfs("graph/bogus/thing", buildFixture())).toContain("unknown");
	});
});

// ── Supporting endpoints (FR-4 / FR-7) ──────────────────────────────────────────

describe("PRD-014d supporting endpoints — query / layers / tour / path", () => {
	it("query/ returns find results plus a 1-hop neighbor expansion grouped by relation", () => {
		const out = handleGraphVfs("graph/query/runService", buildFixture());
		expect(out).toContain("runService");
		expect(out).toMatch(/outgoing|incoming/);
		expect(out).toContain("calls");
	});

	it("tour is deterministic — identical input yields identical output", () => {
		const snap = buildFixture();
		expect(handleGraphVfs("graph/tour", snap)).toBe(handleGraphVfs("graph/tour", snap));
	});

	it("path/<from>/<to> returns the shortest directed path", () => {
		// handler#handleRequest → service#runService → util#pushSnapshot.
		const out = handleGraphVfs("graph/path/handleRequest/pushSnapshot", buildFixture());
		expect(out).toContain("hop");
		expect(out).toContain("src/handler.ts#handleRequest");
		expect(out).toContain("src/util.ts#pushSnapshot");
	});

	it("layers groups files by subsystem", () => {
		const out = handleGraphVfs("graph/layers", buildFixture());
		expect(out).toContain("src");
		expect(out).toContain("src/util.ts");
	});
});
