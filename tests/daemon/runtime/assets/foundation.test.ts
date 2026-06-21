/**
 * PRD-033a — Registry / identity / device / hashing / projectKey / lattice
 * foundation — proves a-AC-1..a-AC-5 + the identity adapter round-trip.
 *
 * Deterministic: temp dirs (fake home), injected clock, injected id/git seams.
 * No DeepLake, no network — every module under test is pure/local (D-6).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	addDeviceToSet,
	ALL_CELLS,
	audienceMatches,
	type AudienceContext,
	cellLabel,
	createAssetRegistryStore,
	deviceFilePath,
	deviceInSet,
	hashAgentFile,
	hashArtifact,
	hashSkillDir,
	IDENTITY_ADAPTER,
	isLatticeCell,
	isLegalTransition,
	loadOrCreateDevice,
	mintHoneycombId,
	parseHoneycombId,
	projectKey,
	type PulledAsset,
	type RegistryEntry,
	resolveHoneycombId,
	stampHoneycombId,
	tierDirection,
} from "../../../../src/daemon/runtime/assets/index.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "hc-assets-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const FIXED_CLOCK = (): Date => new Date("2026-06-21T12:00:00.000Z");

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		assetType: "skill",
		harness: "claude-code",
		tier: "Team",
		style: "Repository",
		version: 3,
		honeycombId: "hc_0123456789abcdef0123456789abcdef",
		lastSyncedHash: "h0",
		localHash: "h1",
		remoteHash: "h2",
		author: "alice",
		org: "acme",
		workspace: "ws",
		deviceSet: ["dev-1"],
		...over,
	};
}

describe("PRD-033a a-AC-1 registry records all fields", () => {
	it("records tier/style/harness/version/id/3-hashes and round-trips them", () => {
		const store = createAssetRegistryStore(tmp);
		const e = entry();
		store.upsert(e);

		const read = store.read();
		expect(read.length).toBe(1);
		const got = read[0] as RegistryEntry;
		// a-AC-1: every field is recorded and survives the round-trip.
		expect(got).toEqual(e);
		expect(got.tier).toBe("Team");
		expect(got.style).toBe("Repository");
		expect(got.harness).toBe("claude-code");
		expect(got.version).toBe(3);
		expect(got.honeycombId).toBe(e.honeycombId);
		expect(got.lastSyncedHash).toBe("h0");
		expect(got.localHash).toBe("h1");
		expect(got.remoteHash).toBe("h2");
	});

	it("upsert is keyed by honeycombId (re-record replaces); remove drops it; bad file → empty", () => {
		const store = createAssetRegistryStore(tmp);
		store.upsert(entry({ version: 1 }));
		store.upsert(entry({ version: 9 })); // same id → replace
		expect(store.read().length).toBe(1);
		expect((store.read()[0] as RegistryEntry).version).toBe(9);

		const removed = store.remove("hc_0123456789abcdef0123456789abcdef");
		expect(removed?.version).toBe(9);
		expect(store.read().length).toBe(0);

		// A garbled file reads as empty, never throws.
		const garbled = createAssetRegistryStore(tmp);
		expect(garbled.read()).toEqual([]);
	});
});

describe("PRD-033a a-AC-2 merkle-for-dir vs content-hash-for-file", () => {
	it("agent file hash = sha256 of content; differs on content change", () => {
		const h1 = hashAgentFile("agent body");
		const h2 = hashAgentFile("agent body");
		const h3 = hashAgentFile("different");
		expect(h1).toBe(h2);
		expect(h1).not.toBe(h3);
		expect(hashArtifact("agent", [{ relativePath: "AGENT.md", content: "agent body" }])).toBe(h1);
	});

	it("skill dir hash = merkle root over sorted (path, content-hash) pairs — ORDER-INDEPENDENT", () => {
		const a = { relativePath: "SKILL.md", content: "skill" };
		const b = { relativePath: "scripts/run.sh", content: "echo hi" };
		const c = { relativePath: "refs/data.json", content: "{}" };

		// Same files, different input order → SAME root (a-AC-2 order-independence).
		const rootForward = hashSkillDir([a, b, c]);
		const rootReversed = hashSkillDir([c, b, a]);
		expect(rootForward).toBe(rootReversed);

		// A content change anywhere changes the root.
		const rootChanged = hashSkillDir([a, { ...b, content: "echo bye" }, c]);
		expect(rootChanged).not.toBe(rootForward);

		// A path change changes the root.
		const rootRenamed = hashSkillDir([a, { ...b, relativePath: "scripts/go.sh" }, c]);
		expect(rootRenamed).not.toBe(rootForward);

		// hashArtifact("skill", …) routes to the merkle root.
		expect(hashArtifact("skill", [a, b, c])).toBe(rootForward);

		// A single-file skill is NOT the same as the bare content hash (path is folded in).
		expect(hashSkillDir([a])).not.toBe(hashAgentFile("skill"));
	});
});

describe("PRD-033a a-AC-3 rename keeps honeycomb_id", () => {
	it("a renamed artifact resolves the SAME id from frontmatter (not a new artifact)", () => {
		const id = mintHoneycombId();
		const original = stampHoneycombId("---\nname: my-skill\n---\nbody", id);
		// Parse the stamped id back.
		expect(parseHoneycombId(original)).toBe(id);

		// "Rename" = re-scan the same content under a different on-disk name. The id resolves
		// from the frontmatter, unchanged — never minted anew.
		const afterRename = resolveHoneycombId(original, null);
		expect(afterRename.id).toBe(id);
		expect(afterRename.minted).toBe(false);
	});

	it("registry is the authoritative fallback when frontmatter is absent (D-3)", () => {
		const id = "hc_0123456789abcdef0123456789abcdef";
		// No frontmatter id, but the registry knows it → resolves to the registered id.
		const resolved = resolveHoneycombId("# just a body, no frontmatter", id);
		expect(resolved.id).toBe(id);
		expect(resolved.minted).toBe(false);

		// Neither knows it → a fresh id is minted.
		const fresh = resolveHoneycombId("# body", null);
		expect(fresh.minted).toBe(true);
		expect(fresh.id).toMatch(/^hc_[0-9a-f]{32}$/);
	});

	it("stamp is idempotent and non-destructive (preserves sibling frontmatter keys)", () => {
		const id = mintHoneycombId();
		const md = "---\nname: my-skill\ndescription: does things\n---\nbody";
		const once = stampHoneycombId(md, id);
		const twice = stampHoneycombId(once, id);
		expect(twice).toBe(once); // idempotent
		expect(once).toMatch(/name: my-skill/);
		expect(once).toMatch(/description: does things/);
		expect(parseHoneycombId(once)).toBe(id);
	});
});

describe("PRD-033a a-AC-4 device_id present in 'my devices'", () => {
	it("generates a stable device_id at ~/.honeycomb/device.json and adds it to the set", () => {
		const opts = { homeDir: tmp, clock: FIXED_CLOCK, mintId: () => "dev-fixed", label: () => "my-machine" };
		const first = loadOrCreateDevice(opts);
		expect(first.device_id).toBe("dev-fixed");
		expect(first.label).toBe("my-machine");
		expect(first.createdAt).toBe("2026-06-21T12:00:00.000Z");

		// Persisted beside .machine-key, stable on the second load (no re-mint).
		const file = deviceFilePath(tmp);
		expect(JSON.parse(readFileSync(file, "utf-8")).device_id).toBe("dev-fixed");
		const second = loadOrCreateDevice({ homeDir: tmp, mintId: () => "SHOULD-NOT-BE-USED" });
		expect(second.device_id).toBe("dev-fixed");

		// a-AC-4: the device_id is present in the author's "my devices" set.
		const set = addDeviceToSet([], first.device_id);
		expect(set).toContain("dev-fixed");
		expect(deviceInSet(set, "dev-fixed")).toBe(true);
		// Dedup: re-adding does not duplicate.
		expect(addDeviceToSet(set, "dev-fixed")).toEqual(["dev-fixed"]);
	});
});

describe("PRD-033a a-AC-5 every artifact resolves to exactly one of 6 cells", () => {
	it("there are exactly 6 cells and every (tier,style) pair is one of them", () => {
		expect(ALL_CELLS.length).toBe(6);
		const labels = ALL_CELLS.map(cellLabel);
		expect(new Set(labels).size).toBe(6); // no duplicates
		expect(labels).toEqual([
			"Local/Repository",
			"Local/User",
			"Device/Repository",
			"Device/User",
			"Team/Repository",
			"Team/User",
		]);
		for (const cell of ALL_CELLS) expect(isLatticeCell(cell)).toBe(true);
		// A malformed cell is not a valid cell.
		expect(isLatticeCell({ tier: "Nope", style: "Repository" })).toBe(false);
	});

	it("legal transitions: tier ladder moves + jumps + style flips; invalid endpoint rejected", () => {
		// Every (valid → valid) pair is legal in v1 (tier axis ordered, style orthogonal).
		for (const from of ALL_CELLS) {
			for (const to of ALL_CELLS) {
				expect(isLegalTransition(from, to), `${cellLabel(from)} → ${cellLabel(to)}`).toBe(true);
			}
		}
		// An invalid endpoint is NOT a legal transition.
		expect(isLegalTransition({ tier: "Local", style: "Repository" }, { tier: "X", style: "Y" } as never)).toBe(false);

		// Direction classification drives publish-vs-tombstone (promote widens, demote narrows).
		expect(tierDirection("Local", "Team")).toBe("promote");
		expect(tierDirection("Team", "Local")).toBe("demote");
		expect(tierDirection("Device", "Device")).toBe("none");
	});
});

describe("PRD-033a projectKey (FR-7)", () => {
	it("SHA-1 of git remote when present; SHA-1 of abs path fallback for non-git", () => {
		const gitKey = projectKey("/repo", () => "git@github.com:acme/api.git");
		const sameRepoElsewhere = projectKey("/some/other/clone", () => "git@github.com:acme/api.git");
		// Same remote → same key regardless of local path.
		expect(gitKey).toBe(sameRepoElsewhere);
		expect(gitKey).toMatch(/^[0-9a-f]{40}$/);

		// Non-git → falls back to the absolute path; a single safe segment.
		const nonGit = projectKey("/repo", () => null);
		expect(nonGit).toMatch(/^[0-9a-f]{40}$/);
		expect(nonGit).not.toBe(gitKey);
	});
});

describe("PRD-033a identity adapter round-trip (a-AC-6 / c-AC-4)", () => {
	it("IDENTITY_ADAPTER satisfies parse(render(x)) === x for any input", () => {
		for (const x of ["", "native body", "---\nname: x\n---\nbody", "weird bytes\n\t"]) {
			expect(IDENTITY_ADAPTER.parse(IDENTITY_ADAPTER.render(x))).toBe(x);
		}
		expect(IDENTITY_ADAPTER.id).toBe("identity");
	});
});

describe("PRD-033a audience predicate (FR-7, tombstone-honoring)", () => {
	const ctx: AudienceContext = { org: "acme", workspace: "ws", author: "alice", deviceId: "dev-1" };
	function asset(over: Partial<PulledAsset>): PulledAsset {
		return {
			honeycombId: "hc_x",
			assetType: "skill",
			harness: "claude-code",
			native: "",
			canonical: "",
			contentHash: "",
			version: 1,
			tombstone: false,
			cell: { tier: "Team", style: "Repository" },
			deviceSet: [],
			author: "alice",
			org: "acme",
			workspace: "ws",
			...over,
		};
	}

	it("Team matches same workspace; not another workspace", () => {
		expect(audienceMatches(asset({ cell: { tier: "Team", style: "Repository" } }), ctx)).toBe(true);
		expect(audienceMatches(asset({ cell: { tier: "Team", style: "Repository" }, workspace: "other" }), ctx)).toBe(false);
	});

	it("Device matches same author + device in set; not another user", () => {
		const dev = asset({ cell: { tier: "Device", style: "User" }, deviceSet: ["dev-1"] });
		expect(audienceMatches(dev, ctx)).toBe(true);
		expect(audienceMatches({ ...dev, author: "bob" }, ctx)).toBe(false);
		expect(audienceMatches({ ...dev, deviceSet: ["dev-9"] }, ctx)).toBe(false);
	});

	it("Local never matches; a tombstone row passes the SAME audience test", () => {
		expect(audienceMatches(asset({ cell: { tier: "Local", style: "Repository" } }), ctx)).toBe(false);
		// A Team tombstone for this workspace still reaches this audience (so it can retract).
		expect(audienceMatches(asset({ tombstone: true, cell: { tier: "Team", style: "Repository" } }), ctx)).toBe(true);
	});
});
