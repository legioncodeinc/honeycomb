/**
 * PRD-013c Obsidian provider — proves c-AC-1..6 against a REAL temp-vault fixture.
 *
 * Verification posture (EXECUTION_LEDGER-prd-013): no live DeepLake. The provider is
 * a READ-ONLY ingest seam — it walks a vault directory and YIELDS `SourceArtifact`s;
 * the lifecycle (tested separately) does every write. So these tests write `.md`
 * files into an OS temp dir, point `createObsidianProvider(config)` at it, drain
 * `index()`, and assert the emitted artifacts:
 *   - c-AC-1: each `.md` → one `note` artifact carrying the provenance quartet
 *             (vault-relative `source_path`, `source_root`=vault); the vault topology
 *             mounts as `graphTriples`.
 *   - c-AC-3: a file WITH headings → `chunks` split by heading, each carrying path +
 *             heading + line range.
 *   - c-AC-4: wiki links `[[Note]]` → dependency-edge `graphTriples`.
 *   - c-AC-2/c-AC-5: the watcher change set (`changes(since)`) surfaces add/modify/
 *             remove; a rename is a removed + an added (delete + add).
 *   - c-AC-6: a malformed file → a `failure` artifact while OTHER files index normally.
 *
 * The decisive cross-cutting assertion: the provider NEVER writes the vault — every
 * file's bytes are unchanged after a full index + a changes() diff.
 *
 * SECURITY: Path validation tests verify that the mitigation for the directory traversal
 * vulnerability is effective. The provider MUST reject vault paths outside the workspace
 * base directory (`$HONEYCOMB_WORKSPACE` or the daemon's cwd).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	type ObsidianConfig,
	createObsidianProvider,
	extractWikiLinks,
	splitByHeading,
} from "../../../../../src/daemon/runtime/sources/providers/obsidian.js";
import type { SourceArtifact } from "../../../../../src/daemon/runtime/sources/contracts.js";

let vault: string;
let workspaceBase: string;
let originalEnv: string | undefined;

// Create a single workspace base directory for ALL tests. This ensures that the
// memoized workspace base directory in the provider module is consistent across
// all tests. Each test will create its own vault within this workspace base.
beforeAll(async () => {
	workspaceBase = await mkdtemp(path.join(tmpdir(), "workspace-"));
	originalEnv = process.env.HONEYCOMB_WORKSPACE;
	process.env.HONEYCOMB_WORKSPACE = workspaceBase;
});

afterAll(async () => {
	// Restore the original environment variable.
	if (originalEnv === undefined) {
		delete process.env.HONEYCOMB_WORKSPACE;
	} else {
		process.env.HONEYCOMB_WORKSPACE = originalEnv;
	}
	// Clean up the workspace base directory.
	await rm(workspaceBase, { recursive: true, force: true });
});

/** Make a config pointing at the current temp vault. */
function config(): ObsidianConfig {
	return { vaultPath: vault, sourceId: "src-obs-1", org: "acme", workspace: "backend" };
}

/** Write a `.md` (creating parent dirs) into the temp vault. */
async function writeNote(rel: string, content: string): Promise<void> {
	const abs = path.join(vault, rel.split("/").join(path.sep));
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf8");
}

/** Drain a provider's `index()` into an array (the lifecycle drains it the same way). */
async function drain(scope: Parameters<ReturnType<typeof createObsidianProvider>["index"]>[0] = {}): Promise<SourceArtifact[]> {
	const provider = createObsidianProvider(config());
	const out: SourceArtifact[] = [];
	for await (const artifact of provider.index(scope)) out.push(artifact);
	return out;
}

/** Find the artifact whose vault-relative `source_path` matches. */
function bySourcePath(artifacts: SourceArtifact[], rel: string): SourceArtifact | undefined {
	return artifacts.find((a) => a.provenance.sourcePath === rel);
}

beforeEach(async () => {
	// Create a unique vault for this test within the shared workspace base.
	vault = path.join(workspaceBase, `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(vault, { recursive: true });
});

afterEach(async () => {
	// Clean up the vault (but not the workspace base).
	await rm(vault, { recursive: true, force: true });
});

describe("PRD-013c Obsidian provider", () => {
	it("c-AC-1 each .md → one note artifact w/ the provenance quartet + vault topology graphTriples", async () => {
		await writeNote("notes/alpha.md", "# Alpha\n\nThe alpha note body.\n");
		await writeNote("notes/beta.md", "# Beta\n\nThe beta note body.\n");
		await writeNote("root-note.md", "Just a root note with no heading.\n");

		const artifacts = await drain();
		const notes = artifacts.filter((a) => a.failure === undefined);
		expect(notes).toHaveLength(3); // one artifact per .md

		const alpha = bySourcePath(artifacts, "notes/alpha.md");
		expect(alpha).toBeDefined();
		// The provenance quartet (c-AC-1 / a-AC-3): vault-relative path + vault root.
		expect(alpha?.kind).toBe("note");
		expect(alpha?.provenance.sourceId).toBe("src-obs-1");
		expect(alpha?.provenance.sourceKind).toBe("obsidian");
		expect(alpha?.provenance.sourcePath).toBe("notes/alpha.md"); // vault-relative
		expect(alpha?.provenance.sourceRoot).toBe(vault); // the vault dir
		expect(alpha?.provenance.org).toBe("acme");
		expect(alpha?.provenance.workspace).toBe("backend");

		// The vault TOPOLOGY mounts into the ontology as graphTriples: a root entity,
		// the folder contains the note, and the note has its heading.
		const triples = alpha?.graphTriples ?? [];
		expect(triples.some((t) => t.subject === "vault:root" && t.predicate === "is_a")).toBe(true);
		expect(triples.some((t) => t.predicate === "contains" && t.object === "note:notes/alpha")).toBe(true);
		expect(triples.some((t) => t.predicate === "has_heading")).toBe(true);
	});

	it("c-AC-3 a file with headings → chunks split by heading, each w/ path + heading + line range", async () => {
		const body = [
			"# Intro", // line 1
			"intro text", // line 2
			"", // line 3
			"## Details", // line 4
			"detail line one", // line 5
			"detail line two", // line 6
			"", // line 7
			"## Summary", // line 8
			"the summary", // line 9
		].join("\n");
		await writeNote("structured.md", body);

		const artifacts = await drain();
		const note = bySourcePath(artifacts, "structured.md");
		const chunks = note?.chunks ?? [];
		// Three headings → three heading-split chunks.
		expect(chunks).toHaveLength(3);

		const headings = chunks.map((c) => c.metadata?.heading);
		expect(headings).toEqual(["Intro", "Details", "Summary"]);

		// Each chunk carries the vault-relative path + heading + line range (c-AC-3).
		const details = chunks.find((c) => c.metadata?.heading === "Details");
		expect(details?.metadata?.path).toBe("structured.md");
		expect(details?.metadata?.lineStart).toBe(4);
		expect(details?.metadata?.lineEnd).toBe(7);
		expect(details?.metadata?.lines).toEqual([4, 7]);
		// The chunk's own sourcePath is narrowed to a heading anchor.
		expect(details?.provenance.sourcePath).toBe("structured.md#details");
		// The chunk text is the heading section body (heading line included).
		expect(details?.content).toContain("## Details");
		expect(details?.content).toContain("detail line two");
	});

	it("c-AC-4 wiki links between notes → dependency-edge graphTriples", async () => {
		await writeNote("a.md", "# A\n\nSee [[B]] and also [[Folder/C|see C]] and [[B#section]].\n");
		await writeNote("b.md", "# B\n\nThe B note.\n");

		const artifacts = await drain();
		const a = bySourcePath(artifacts, "a.md");
		const deps = (a?.graphTriples ?? []).filter((t) => t.predicate === "depends_on");

		// A depends_on B and A depends_on Folder/C — the wiki links became dep edges.
		const objects = deps.map((t) => t.object);
		expect(objects).toContain("note:B");
		expect(objects).toContain("note:Folder/C");
		// `[[B]]` and `[[B#section]]` collapse to a single B dependency (deduped, fragment stripped).
		expect(deps.filter((t) => t.object === "note:B")).toHaveLength(1);
		// Every dep edge is subject = the source note.
		for (const t of deps) expect(t.subject).toBe("note:a");
	});

	it("c-AC-6 a malformed file → a failure artifact while other files index normally", async () => {
		await writeNote("good-one.md", "# Good One\n\nfine\n");
		await writeNote("good-two.md", "# Good Two\n\nalso fine\n");
		// A NUL byte makes this a corrupt file masquerading as .md (the malformed signal).
		await writeNote("broken.md", `# Broken

body with a NUL:${String.fromCharCode(0)}here
`);

		const artifacts = await drain();
		// One bad file never aborts the batch: both good files indexed.
		const good = artifacts.filter((a) => a.failure === undefined);
		expect(good.map((a) => a.provenance.sourcePath).sort()).toEqual(["good-one.md", "good-two.md"]);

		// The malformed file became a FAILURE artifact carrying its reason + path.
		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures).toHaveLength(1);
		expect(failures[0].provenance.sourcePath).toBe("broken.md");
		expect(failures[0].failure?.reason).toMatch(/malformed/i);
	});

	it("c-AC-2 a vault file edited → the change set surfaces it as modified (re-read drives update in place)", async () => {
		await writeNote("note.md", "# Note\n\noriginal\n");
		const provider = createObsidianProvider(config());

		const first = await provider.changes(); // empty prior → everything added
		expect(first.added).toContain("note.md");
		expect(first.modified).toEqual([]);
		expect(first.removed).toEqual([]);

		// Edit the file on disk; the next diff reports it modified (FR-6 fingerprint-gated).
		await writeNote("note.md", "# Note\n\nedited body\n");
		const second = await provider.changes(first.snapshot);
		expect(second.modified).toEqual(["note.md"]);
		expect(second.added).toEqual([]);

		// An unchanged re-scan is single-flight-skippable: no change reported.
		const third = await provider.changes(second.snapshot);
		expect(third.added).toEqual([]);
		expect(third.modified).toEqual([]);
		expect(third.removed).toEqual([]);
	});

	it("c-AC-2 a removed file → the change set surfaces it as removed (lifecycle soft-deletes + purges chunks)", async () => {
		await writeNote("keep.md", "# Keep\n\nkeep me\n");
		await writeNote("drop.md", "# Drop\n\ndrop me\n");
		const provider = createObsidianProvider(config());
		const baseline = await provider.changes();

		// Remove one file; the diff surfaces it as `removed` (the lifecycle does the soft-delete).
		await rm(path.join(vault, "drop.md"));
		const diff = await provider.changes(baseline.snapshot);
		expect(diff.removed).toEqual(["drop.md"]);
		expect(diff.added).toEqual([]);
		expect(diff.modified).toEqual([]);
	});

	it("c-AC-5 a renamed file → old removed + new added (delete + add)", async () => {
		await writeNote("old-name.md", "# Note\n\nbody\n");
		const provider = createObsidianProvider(config());
		const baseline = await provider.changes();

		await rename(path.join(vault, "old-name.md"), path.join(vault, "new-name.md"));
		const diff = await provider.changes(baseline.snapshot);
		// A rename is exactly one removed (old) + one added (new).
		expect(diff.removed).toEqual(["old-name.md"]);
		expect(diff.added).toEqual(["new-name.md"]);
		expect(diff.modified).toEqual([]);
	});

	it("the provider NEVER writes the vault (read-only) — bytes unchanged after index + changes", async () => {
		await writeNote("a.md", "# A\n\nlinks [[B]]\n");
		await writeNote("sub/b.md", "# B\n\n## H\n\nbody\n");
		const before = new Map<string, string>();
		for (const rel of ["a.md", "sub/b.md"]) {
			const buf = await readFile(path.join(vault, rel.split("/").join(path.sep)));
			before.set(rel, createHash("sha256").update(buf).digest("hex"));
		}

		// A full index + a watcher diff — both read-only paths.
		await drain();
		await createObsidianProvider(config()).changes();

		for (const [rel, hash] of before) {
			const buf = await readFile(path.join(vault, rel.split("/").join(path.sep)));
			expect(createHash("sha256").update(buf).digest("hex"), `${rel} must be byte-identical`).toBe(hash);
		}
	});

	it("index({ paths }) narrows the re-scan to the changed files (FR-6 single-flight)", async () => {
		await writeNote("one.md", "# One\n");
		await writeNote("two.md", "# Two\n");
		await writeNote("three.md", "# Three\n");

		const narrowed = await drain({ paths: ["two.md"] });
		expect(narrowed.map((a) => a.provenance.sourcePath)).toEqual(["two.md"]);
	});
});

describe("PRD-013c pure parsing helpers", () => {
	it("splitByHeading bounds each section at the line before the next heading", () => {
		const sections = splitByHeading("# H1\nbody1\n## H2\nbody2\n");
		expect(sections.map((s) => s.heading)).toEqual(["H1", "H2"]);
		expect(sections[0].lineStart).toBe(1);
		expect(sections[0].lineEnd).toBe(2);
		expect(sections[1].lineStart).toBe(3);
	});

	it("splitByHeading keeps a pre-first-heading preamble as an empty-heading section", () => {
		const sections = splitByHeading("preamble text\n\n# First\nbody\n");
		expect(sections[0].heading).toBe("");
		expect(sections[0].content).toContain("preamble text");
		expect(sections[1].heading).toBe("First");
	});

	it("splitByHeading does NOT treat a fenced `#` as a heading", () => {
		const text = "# Real\n```\n# not a heading\n```\nafter\n";
		const sections = splitByHeading(text);
		expect(sections.map((s) => s.heading)).toEqual(["Real"]);
	});

	it("extractWikiLinks strips alias + fragment and dedupes", () => {
		expect(extractWikiLinks("[[A]] [[A|alias]] [[B#frag]] [[A]]")).toEqual(["A", "B"]);
	});
});

describe("PRD-013c provider seam conformance", () => {
	it("a configured provider reports connected health for a real vault dir", async () => {
		const health = await createObsidianProvider(config()).health();
		expect(health.state).toBe("connected");
	});

	it("the unconfigured provider stays the honest Wave-1 stub (kind + unreachable + fails loud)", async () => {
		const stub = createObsidianProvider();
		expect(stub.kind).toBe("obsidian");
		expect((await stub.health()).state).toBe("unreachable");
		expect(() => stub.index({})).toThrow(/013c/);
		await expect(stub.connect({ kind: "obsidian", org: "o", workspace: "w", root: "", settings: {} })).rejects.toThrow(/013c/);
	});
});

describe("SECURITY: Path validation prevents directory traversal attacks", () => {
	let secureVault: string;

	beforeEach(async () => {
		// Create a dedicated vault for security tests within the workspace.
		secureVault = path.join(workspaceBase, "secure-vault");
		await mkdir(secureVault, { recursive: true });
	});

	it("SECURITY: rejects a vault path outside the workspace base directory (absolute path escape)", async () => {
		// Attempt to read /etc/passwd (or any absolute path outside the workspace).
		const maliciousConfig = { vaultPath: "/etc", sourceId: "src-malicious", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(maliciousConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);

		// Indexing should yield a failure artifact (not crash, not read the path).
		const artifacts: SourceArtifact[] = [];
		for await (const artifact of provider.index({})) {
			artifacts.push(artifact);
		}
		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures.length).toBeGreaterThan(0);
		expect(failures[0].failure?.reason).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: rejects a vault path with directory traversal (../ escape)", async () => {
		// Attempt to escape the workspace using ../../../etc/passwd.
		const maliciousPath = path.join(secureVault, "..", "..", "..", "etc");
		const maliciousConfig = { vaultPath: maliciousPath, sourceId: "src-traversal", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(maliciousConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: rejects a vault path that equals the workspace root (not strictly within)", async () => {
		// The workspace root itself is not a valid vault (must be a subdirectory).
		const rootConfig = { vaultPath: workspaceBase, sourceId: "src-root", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(rootConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: rejects a vault path pointing to a file (not a directory)", async () => {
		// Create a file in the secure vault and attempt to use it as the vault path.
		const filePath = path.join(secureVault, "file.md");
		await writeFile(filePath, "# File\n\nThis is a file, not a directory.\n", "utf8");
		const fileConfig = { vaultPath: filePath, sourceId: "src-file", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(fileConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: rejects a vault path that does not exist", async () => {
		// Attempt to use a non-existent path.
		const nonExistentPath = path.join(secureVault, "does-not-exist");
		const nonExistentConfig = { vaultPath: nonExistentPath, sourceId: "src-nonexistent", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(nonExistentConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: accepts a valid vault path strictly within the workspace", async () => {
		// The secure vault is within the workspace base directory.
		const validConfig = { vaultPath: secureVault, sourceId: "src-valid", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(validConfig);

		// The provider should report connected health (validation passed).
		const health = await provider.health();
		expect(health.state).toBe("connected");
		expect(health.detail).toMatch(/vault:/i);
	});

	it("SECURITY: accepts a relative vault path that resolves within the workspace", async () => {
		// Use a relative path that resolves to the secure vault.
		const relativePath = path.relative(process.cwd(), secureVault);
		const relativeConfig = { vaultPath: relativePath, sourceId: "src-relative", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(relativeConfig);

		// The provider should report connected health (validation passed).
		const health = await provider.health();
		expect(health.state).toBe("connected");
		expect(health.detail).toMatch(/vault:/i);
	});

	it("SECURITY: symlink escape is prevented (symlink pointing outside workspace)", async () => {
		// Create a symlink inside the secure vault that points outside the workspace.
		// This test requires the ability to create symlinks, which may not be available
		// on all platforms (e.g., Windows without admin rights). We'll skip if it fails.
		const symlinkPath = path.join(secureVault, "symlink-escape");
		try {
			const { symlink } = await import("node:fs/promises");
			await symlink("/etc", symlinkPath, "dir");
		} catch {
			// Skip this test if symlink creation fails (e.g., insufficient permissions).
			return;
		}

		// Attempt to use the symlink as the vault path.
		const symlinkConfig = { vaultPath: symlinkPath, sourceId: "src-symlink", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(symlinkConfig);

		// The provider should report unreachable health (validation failed).
		const health = await provider.health();
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: validation is performed before any file read operations", async () => {
		// This test confirms that validation happens BEFORE any file reads, so an
		// attacker-controlled path never reaches the file system read operations.
		await writeFile(path.join(secureVault, "secret.md"), "# Secret\n\nThis should never be read.\n", "utf8");

		// Attempt to read a path outside the workspace.
		const maliciousConfig = { vaultPath: "/etc", sourceId: "src-prevalidation", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(maliciousConfig);

		// Indexing should yield a failure artifact (not crash, not read the path).
		const artifacts: SourceArtifact[] = [];
		for await (const artifact of provider.index({})) {
			artifacts.push(artifact);
		}

		// The only artifact should be a failure artifact (no content read).
		expect(artifacts.length).toBeGreaterThan(0);
		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures.length).toBeGreaterThan(0);
		expect(failures[0].failure?.reason).toMatch(/invalid or outside the workspace/i);

		// No successful note artifacts should be present (no files were read).
		const notes = artifacts.filter((a) => a.failure === undefined && a.kind === "note");
		expect(notes).toHaveLength(0);
	});

	it("SECURITY: connect() validates the path and rejects invalid configs", async () => {
		// The connect() method should validate the path and reject invalid configs.
		const maliciousConfig = { vaultPath: "/etc", sourceId: "src-connect", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(maliciousConfig);

		// Connect should return unreachable health (validation failed).
		const sourceConfig = { kind: "obsidian" as const, org: "acme", workspace: "backend", root: "/etc", settings: {} };
		const health = await provider.connect(sourceConfig);
		expect(health.state).toBe("unreachable");
		expect(health.detail).toMatch(/invalid or outside the workspace/i);
	});

	it("SECURITY: snapshot() validates the path before reading files", async () => {
		// The snapshot() method should validate the path before reading files.
		const maliciousConfig = { vaultPath: "/etc", sourceId: "src-snapshot", org: "acme", workspace: "backend" };
		const provider = createObsidianProvider(maliciousConfig);

		// Snapshot should return an empty object (validation failed, no files read).
		const snapshot = await provider.snapshot();
		expect(snapshot).toEqual({});
	});
});
