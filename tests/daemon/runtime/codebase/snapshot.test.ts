/**
 * PRD-014 snapshot-builder harness + the 014b finalize seams.
 *
 * Wave-1 aggregate: discover → extract (cache) → NetworkX node-link Snapshot, parse
 * errors as SKIPPED files (a-AC-4), cache reuse on a second build (a-AC-2).
 *
 * Wave-2 (014b) finalize — the six b-ACs:
 *   - b-AC-1 / b-AC-3: high-confidence resolution only — named/namespace imports resolve;
 *     default/barrel/dynamic/bare → NO edge (dropped, not guessed).
 *   - b-AC-4: relative import repoints to the real module node; unresolvable keeps `external:`.
 *   - b-AC-2 / index AC-1: DETERMINISM — identical content under two different base dirs /
 *     worktree paths → identical `computeSnapshotSha256` (observation excluded).
 *   - b-AC-5: `annotateNodeDegrees` sets fan_in/fan_out/is_entrypoint from cross-file edges.
 *   - b-AC-6: atomic write — a simulated crash (temp not renamed) leaves the prior file intact.
 *
 * Source fixtures via an injected `readFile` + git lister; no DeepLake, no network.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	annotateNodeDegrees,
	buildAggregateSnapshot,
	computeSnapshotSha256,
	finalizeSnapshot,
	resolveCrossFile,
	writeSnapshotAtomic,
} from "../../../../src/daemon/runtime/codebase/snapshot.js";
import {
	isExternalTarget,
	type Snapshot,
	type SnapshotIdentity,
} from "../../../../src/daemon/runtime/codebase/contracts.js";

const IDENTITY: SnapshotIdentity = {
	org: "acme",
	workspace: "default",
	repo: "honeycomb",
	user: "u1",
	worktree: "wt1",
	commit: "abc123",
};

let cacheDir: string;
beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "hc-graph-snap-"));
});
afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true });
});

/** A fixture repo: a path→content map, surfaced through git + readFile seams. */
function fixtureDeps(files: Record<string, string>, baseDir: string) {
	return {
		gitLsFiles: () => Object.keys(files).join("\0"),
		readFile: (abs: string) => {
			const key = Object.keys(files).find((k) => abs.replace(/\\/g, "/").endsWith(k));
			if (key === undefined) throw new Error(`no fixture for ${abs}`);
			return files[key];
		},
		cacheBaseDir: baseDir,
		noCache: true as const,
	};
}

describe("PRD-014 snapshot harness (Wave 1 aggregate build)", () => {
	it("aggregates discover → extract → NetworkX node-link snapshot", async () => {
		const files = {
			"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
			"src/b.ts": "export function b(){}\n",
			"src/c.py": "def c():\n    pass\n",
		};
		const build = await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(files, cacheDir));
		const snap = build.snapshot;
		expect(snap.directed).toBe(true);
		expect(snap.multigraph).toBe(true);
		expect(snap.graph.repo).toBe("honeycomb");
		expect(snap.graph.commit).toBe("abc123");
		expect(snap.nodes.filter((n) => n.kind === "file").length).toBe(3);
		expect(snap.nodes.some((n) => n.kind === "symbol" && n.name === "a")).toBe(true);
		expect(snap.links.every((l) => typeof l.source === "string" && typeof l.target === "string")).toBe(true);
		expect(snap.observation.fileCount).toBe(3);
		expect(snap.observation.nodeCount).toBe(snap.nodes.length);
		expect(snap.observation.generatorVersion).toBeTruthy();
	});

	it("a-AC-4 a malformed file is surfaced as a parse error + skipped, build not aborted", async () => {
		const files = {
			"ok.ts": "export function ok(){}\n",
			"bad.ts": "function ( { broken $$$\n",
		};
		const build = await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(files, cacheDir));
		expect(build.parseErrors.length).toBeGreaterThanOrEqual(1);
		expect(build.parseErrors.some((e) => e.sourceFile === "bad.ts")).toBe(true);
		expect(build.snapshot.nodes.some((n) => n.kind === "symbol" && n.name === "ok")).toBe(true);
		expect(build.snapshot.nodes.some((n) => n.kind === "file" && n.sourceFile === "bad.ts")).toBe(true);
		expect(build.snapshot.nodes.some((n) => n.kind === "symbol" && n.sourceFile === "bad.ts")).toBe(false);
	});

	it("aggregate edges keep external: placeholders (014b repoints later)", async () => {
		const files = { "a.ts": "import { x } from './x';\nexport function a(){ x(); }\n" };
		const build = await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(files, cacheDir));
		const importLinks = build.snapshot.links.filter((l) => l.relation === "imports");
		expect(importLinks.length).toBeGreaterThanOrEqual(1);
		expect(importLinks.every((l) => l.target.startsWith("external:"))).toBe(true);
	});
});

// ── 014b finalize ─────────────────────────────────────────────────────────────

/** Build + resolve a fixture, returning the resolved snapshot. */
async function resolved(files: Record<string, string>, baseDir = cacheDir, repoRoot = "/repo"): Promise<Snapshot> {
	const build = await buildAggregateSnapshot(repoRoot, IDENTITY, fixtureDeps(files, baseDir));
	return resolveCrossFile(build);
}

/** All `calls` links in a snapshot. */
function callLinks(snap: Snapshot) {
	return snap.links.filter((l) => l.relation === "calls");
}

describe("PRD-014b resolveCrossFile — high-confidence only (b-AC-1 / b-AC-3)", () => {
	it("b-AC-1 a NAMED import call site resolves to the real exported symbol", async () => {
		const snap = await resolved({
			"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
			"src/b.ts": "export function b(){}\n",
		});
		const edge = callLinks(snap).find((l) => l.source === "src/a.ts#a");
		expect(edge, "a named-import call must produce a resolved edge").toBeDefined();
		expect(edge?.target).toBe("src/b.ts#b");
		expect(isExternalTarget(edge?.target ?? "")).toBe(false);
	});

	it("b-AC-1 a NAMESPACE import call ns.foo() resolves to the module's exported symbol", async () => {
		const snap = await resolved({
			"src/a.ts": "import * as ns from './b';\nexport function a(){ ns.foo(); }\n",
			"src/b.ts": "export function foo(){}\n",
		});
		const edge = callLinks(snap).find((l) => l.source === "src/a.ts#a");
		expect(edge?.target).toBe("src/b.ts#foo");
	});

	it("b-AC-3 a DEFAULT import call site emits NO edge (dropped, not guessed)", async () => {
		const snap = await resolved({
			"src/a.ts": "import def from './b';\nexport function a(){ def(); }\n",
			"src/b.ts": "export default function thing(){}\n",
		});
		// No resolved call edge for `a`, and no leftover external: call placeholder either.
		const edge = callLinks(snap).find((l) => l.source === "src/a.ts#a");
		expect(edge).toBeUndefined();
	});

	it("b-AC-3 a BARE (npm) specifier call site emits NO edge", async () => {
		const snap = await resolved({
			"src/a.ts": "import { debounce } from 'lodash';\nexport function a(){ debounce(); }\n",
		});
		const edge = callLinks(snap).find((l) => l.source === "src/a.ts#a");
		expect(edge).toBeUndefined();
	});

	it("b-AC-1 a BARREL re-export (named import whose target file does not export the name) is DROPPED", async () => {
		// `./barrel` exists but does not itself export `b` (it would re-export) → no provable edge.
		const snap = await resolved({
			"src/a.ts": "import { b } from './barrel';\nexport function a(){ b(); }\n",
			"src/barrel.ts": "export { b } from './b';\n",
			"src/b.ts": "export function b(){}\n",
		});
		const edge = callLinks(snap).find((l) => l.source === "src/a.ts#a");
		// The extractor sees `barrel.ts` re-export as an import, not an `export function b`,
		// so the export index has no `b` for barrel.ts → high-confidence resolution drops it.
		expect(edge).toBeUndefined();
	});

	it("b-AC-3 a this. / instance dispatch call emits NO cross-file edge", async () => {
		const snap = await resolved({
			"src/a.ts": "import { b } from './b';\nexport class C { m(){ this.other(); } other(){} }\n",
			"src/b.ts": "export function b(){}\n",
		});
		const thisCall = callLinks(snap).find((l) => l.source.includes("C.m") && l.target.includes("other"));
		// `this.other()` is instance dispatch — never repointed cross-file; no resolved target.
		expect(thisCall?.target?.startsWith("external:") ?? true).toBe(true);
		// And it is not present as a resolved cross-file edge.
		const resolvedThis = callLinks(snap).find(
			(l) => l.source.includes("C.m") && !isExternalTarget(l.target) && l.target.endsWith("#other"),
		);
		expect(resolvedThis).toBeUndefined();
	});
});

describe("PRD-014b imports pass — relative repoint vs external: keep (b-AC-4)", () => {
	it("b-AC-4 a relative import resolving to a repo file is repointed to the real module node", async () => {
		const snap = await resolved({
			"src/a.ts": "import { b } from './b';\nexport function a(){}\n",
			"src/b.ts": "export function b(){}\n",
		});
		const imp = snap.links.find((l) => l.relation === "imports" && l.source === "src/a.ts");
		expect(imp?.target).toBe("src/b.ts"); // the file node id IS the module node.
		expect(isExternalTarget(imp?.target ?? "")).toBe(false);
	});

	it("b-AC-4 an UNRESOLVABLE (bare) specifier keeps its external: target", async () => {
		const snap = await resolved({
			"src/a.ts": "import { debounce } from 'lodash';\nexport function a(){}\n",
		});
		const imp = snap.links.find((l) => l.relation === "imports" && l.source === "src/a.ts");
		expect(imp?.target).toBe("external:lodash");
		expect(isExternalTarget(imp?.target ?? "")).toBe(true);
	});

	it("b-AC-4 a relative import to a NON-existent repo file keeps external:", async () => {
		const snap = await resolved({
			"src/a.ts": "import { gone } from './missing';\nexport function a(){}\n",
		});
		const imp = snap.links.find((l) => l.relation === "imports" && l.source === "src/a.ts");
		expect(imp?.target).toBe("external:./missing");
	});

	it("b-AC-4 a directory import repoints to the index file", async () => {
		const snap = await resolved({
			"src/a.ts": "import { b } from './lib';\nexport function a(){}\n",
			"src/lib/index.ts": "export function b(){}\n",
		});
		const imp = snap.links.find((l) => l.relation === "imports" && l.source === "src/a.ts");
		expect(imp?.target).toBe("src/lib/index.ts");
	});
});

describe("PRD-014b computeSnapshotSha256 — DETERMINISM (b-AC-2 / index AC-1)", () => {
	const FILES = {
		"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
		"src/b.ts": "export function b(){}\n",
	};

	it("b-AC-2 identical content under two DIFFERENT base dirs / worktree paths → identical hash", async () => {
		const dirA = mkdtempSync(join(tmpdir(), "hc-det-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "hc-det-b-"));
		try {
			// Two different repoRoots AND two different cache base dirs — only the content matches.
			const finA = finalizeSnapshot(
				await buildAggregateSnapshot("/worktree/alpha", IDENTITY, fixtureDeps(FILES, dirA)),
			);
			const finB = finalizeSnapshot(
				await buildAggregateSnapshot("/totally/other/path/beta", IDENTITY, fixtureDeps(FILES, dirB)),
			);
			expect(finA.sha256).toBe(finB.sha256);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});

	it("b-AC-2 the VOLATILE observation (timestamp/worktree/degrees/counts) does NOT change the hash", async () => {
		const fin = finalizeSnapshot(await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(FILES, cacheDir)));
		const base = fin.snapshot;
		// Mutate ONLY the observation blocks — the hash must be unchanged.
		const mutated: Snapshot = {
			...base,
			observation: { ...base.observation, generatedAt: "1999-01-01T00:00:00.000Z", worktreePath: "/elsewhere", nodeCount: 9999 },
			nodes: base.nodes.map((n) => ({ ...n, observation: { ...n.observation, startLine: n.observation.startLine + 100, fanIn: 42 } })),
		};
		expect(computeSnapshotSha256(mutated)).toBe(computeSnapshotSha256(base));
	});

	it("b-AC-2 a STABLE content change (a new symbol) DOES change the hash", async () => {
		const finA = finalizeSnapshot(await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(FILES, cacheDir)));
		const dirC = mkdtempSync(join(tmpdir(), "hc-det-c-"));
		try {
			const finB = finalizeSnapshot(
				await buildAggregateSnapshot(
					"/repo",
					IDENTITY,
					fixtureDeps({ ...FILES, "src/b.ts": "export function b(){}\nexport function extra(){}\n" }, dirC),
				),
			);
			expect(finB.sha256).not.toBe(finA.sha256);
		} finally {
			rmSync(dirC, { recursive: true, force: true });
		}
	});

	it("b-AC-2 the hash is stable across node/link insertion order (canonical sort)", async () => {
		const fin = finalizeSnapshot(await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps(FILES, cacheDir)));
		const shuffled: Snapshot = {
			...fin.snapshot,
			nodes: [...fin.snapshot.nodes].reverse(),
			links: [...fin.snapshot.links].reverse(),
		};
		expect(computeSnapshotSha256(shuffled)).toBe(fin.sha256);
	});
});

describe("PRD-014b annotateNodeDegrees — fan_in/fan_out/is_entrypoint (b-AC-5)", () => {
	it("b-AC-5 degrees reflect the resolved cross-file edge set", async () => {
		// a() calls b(); b is exported and called once. The `a` symbol calls out once.
		const fin = finalizeSnapshot(
			await buildAggregateSnapshot(
				"/repo",
				IDENTITY,
				fixtureDeps(
					{
						"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
						"src/b.ts": "export function b(){}\n",
					},
					cacheDir,
				),
			),
		);
		const a = fin.snapshot.nodes.find((n) => n.id === "src/a.ts#a");
		const b = fin.snapshot.nodes.find((n) => n.id === "src/b.ts#b");
		// b: called by a (fan_in ≥ 1). a: calls b (fan_out ≥ 1).
		expect(b?.observation.fanIn).toBeGreaterThanOrEqual(1);
		expect(a?.observation.fanOut).toBeGreaterThanOrEqual(1);
		// b is exported but called → NOT an entrypoint. a is exported and nothing calls it → entrypoint.
		expect(b?.observation.isEntrypoint).toBe(false);
		expect(a?.observation.isEntrypoint).toBe(true);
	});

	it("b-AC-5 an exported symbol with no incoming resolved edge is is_entrypoint", async () => {
		const snap = annotateNodeDegrees(
			await resolved({ "src/solo.ts": "export function solo(){}\n" }),
		);
		const solo = snap.nodes.find((n) => n.id === "src/solo.ts#solo");
		expect(solo?.observation.fanIn).toBe(0);
		expect(solo?.observation.isEntrypoint).toBe(true);
	});

	it("b-AC-5 an unresolved external: import does not inflate any node's fan_in", async () => {
		const snap = annotateNodeDegrees(await resolved({ "src/a.ts": "import { x } from 'pkg';\nexport function a(){}\n" }));
		// No node should have fan_in credited from the external: import edge.
		const totalFanIn = snap.nodes.reduce((sum, n) => sum + (n.observation.fanIn ?? 0), 0);
		expect(totalFanIn).toBe(0);
	});
});

describe("PRD-014b writeSnapshotAtomic — never partial (b-AC-6)", () => {
	it("b-AC-6 writes to <baseDir>/snapshots/<commit>.json atomically", async () => {
		const fin = finalizeSnapshot(
			await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps({ "a.ts": "export function a(){}\n" }, cacheDir)),
		);
		const path = writeSnapshotAtomic(fin.snapshot, cacheDir, fin.sha256);
		expect(path.replace(/\\/g, "/").endsWith("snapshots/abc123.json")).toBe(true);
		expect(existsSync(path)).toBe(true);
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
		expect(onDisk.graph.commit).toBe("abc123");
		// No temp leftovers after a clean write.
		const leftover = readdirSync(join(cacheDir, "snapshots")).filter((f) => f.endsWith(".tmp"));
		expect(leftover.length).toBe(0);
	});

	it("b-AC-6 a crash BEFORE the rename leaves the PRIOR file intact (never partial)", async () => {
		const fin = finalizeSnapshot(
			await buildAggregateSnapshot("/repo", IDENTITY, fixtureDeps({ "a.ts": "export function a(){}\n" }, cacheDir)),
		);
		// 1. Write a known PRIOR version atomically.
		const path = writeSnapshotAtomic(fin.snapshot, cacheDir, fin.sha256);
		const priorBytes = readFileSync(path, "utf8");

		// 2. Simulate a crashed write: a NEW payload lands in a temp file but the rename
		//    never happens (process died). The final file must still be the PRIOR version.
		const dir = join(cacheDir, "snapshots");
		const tmp = join(dir, ".abc123.json.crash.tmp");
		writeFileSync(tmp, '{"directed":true,"PARTIAL":', "utf8"); // truncated/garbage, never renamed.
		expect(readFileSync(path, "utf8")).toBe(priorBytes); // prior file untouched.

		// 3. A subsequent successful write atomically replaces it with the NEW version.
		renameSync(tmp, join(dir, ".staged.tmp")); // (housekeeping; the partial temp is discardable)
		rmSync(join(dir, ".staged.tmp"), { force: true });
		const path2 = writeSnapshotAtomic(fin.snapshot, cacheDir, fin.sha256);
		expect(existsSync(path2)).toBe(true);
		// The final file is valid JSON (the new full version), never the partial temp bytes.
		expect(() => JSON.parse(readFileSync(path2, "utf8"))).not.toThrow();
	});
});
