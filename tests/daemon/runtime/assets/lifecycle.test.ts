/**
 * PRD-033b — the asset LIFECYCLE (registerAsset + transitionAsset) — b-AC-1..6.
 *
 * Deterministic: a FAKE {@link AssetSyncApi} (captures every publish/tombstone call),
 * a temp-dir registry store, a fixed scope. No DeepLake, no network — the lifecycle is
 * pure orchestration over the registry + sync seams (D-6). The DeepLake side is asserted
 * by inspecting the calls the fake captured (the SCOPE on the write is the b-AC-3/4 proof).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AssetLifecycleDeps,
	type AssetScope,
	type AssetSyncApi,
	type PublishRequest,
	type PublishResponse,
	type PullRequest,
	type PullResponse,
	type RegistryEntry,
	createAssetRegistryStore,
	registerAsset,
	type TombstoneRequest,
	type TombstoneResponse,
	transitionAsset,
	TransitionError,
} from "../../../../src/daemon/runtime/assets/index.js";

// ── A capturing fake AssetSyncApi ────────────────────────────────────────────

interface FakeSync extends AssetSyncApi {
	readonly publishes: PublishRequest[];
	readonly tombstones: TombstoneRequest[];
	readonly pulls: PullRequest[];
}

function createFakeSync(opts: { publishVersion?: number; publishedOk?: boolean; tombstonedOk?: boolean } = {}): FakeSync {
	const publishes: PublishRequest[] = [];
	const tombstones: TombstoneRequest[] = [];
	const pulls: PullRequest[] = [];
	return {
		get publishes() {
			return publishes;
		},
		get tombstones() {
			return tombstones;
		},
		get pulls() {
			return pulls;
		},
		async publish(req: PublishRequest): Promise<PublishResponse> {
			publishes.push(req);
			return { honeycombId: req.honeycombId, version: opts.publishVersion ?? 1, published: opts.publishedOk ?? true };
		},
		async tombstone(req: TombstoneRequest): Promise<TombstoneResponse> {
			tombstones.push(req);
			return { honeycombId: req.honeycombId, version: 2, tombstoned: opts.tombstonedOk ?? true };
		},
		async pull(req: PullRequest): Promise<PullResponse> {
			pulls.push(req);
			return { assets: [], tableAbsent: false };
		},
	};
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "hc-lifecycle-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const SCOPE: AssetScope = { org: "acme", workspace: "platform", author: "mario", deviceId: "dev-1" };

function deps(sync: AssetSyncApi): AssetLifecycleDeps {
	return { sync, registry: createAssetRegistryStore(tmp) };
}

const HC_ID = "hc_0123456789abcdef0123456789abcdef";

function seedLocal(d: AssetLifecycleDeps, over: Partial<RegistryEntry> = {}): RegistryEntry {
	const entry: RegistryEntry = {
		assetType: "skill",
		harness: "claude_code",
		tier: "Local",
		style: "Repository",
		version: 0,
		honeycombId: HC_ID,
		lastSyncedHash: "",
		localHash: "h-local",
		remoteHash: "",
		author: SCOPE.author,
		org: SCOPE.org,
		workspace: SCOPE.workspace,
		deviceSet: [],
		...over,
	};
	d.registry.upsert(entry);
	return entry;
}

describe("PRD-033b b-AC-1 — register lands Local + style + id, NO DeepLake write", () => {
	it("registers at Local with the explicit style + honeycomb_id, and never publishes", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		const entry = await registerAsset(d, {
			honeycombId: HC_ID,
			assetType: "skill",
			harness: "claude_code",
			style: "User",
			contentHash: "h-1",
			scope: SCOPE,
		});

		expect(entry.tier).toBe("Local");
		expect(entry.style).toBe("User");
		expect(entry.honeycombId).toBe(HC_ID);
		expect(entry.localHash).toBe("h-1");

		// Persisted to the registry…
		const stored = d.registry.read();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.tier).toBe("Local");

		// …and NOTHING crossed the daemon (Local is unmanaged).
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones).toHaveLength(0);
	});

	it("re-registering a known id REPLACES the entry (never forks a second artifact)", async () => {
		const d = deps(createFakeSync());
		await registerAsset(d, { honeycombId: HC_ID, assetType: "skill", harness: "claude_code", style: "Repository", contentHash: "h1", scope: SCOPE });
		await registerAsset(d, { honeycombId: HC_ID, assetType: "skill", harness: "claude_code", style: "User", contentHash: "h2", scope: SCOPE });
		expect(d.registry.read()).toHaveLength(1);
		expect(d.registry.read()[0]!.style).toBe("User");
	});
});

describe("PRD-033 F-3 — registerAsset records sourcePath (additive, optional)", () => {
	it("records the supplied sourcePath on the Local entry", async () => {
		const d = deps(createFakeSync());
		const entry = await registerAsset(d, {
			honeycombId: HC_ID,
			assetType: "agent",
			harness: "codex",
			style: "Repository",
			contentHash: "h-1",
			scope: SCOPE,
			sourcePath: "/abs/path/agent.md",
		});
		expect(entry.sourcePath).toBe("/abs/path/agent.md");
		expect(d.registry.read()[0]!.sourcePath).toBe("/abs/path/agent.md");
	});

	it("omits sourcePath when none is supplied (back-compat — field stays optional)", async () => {
		const d = deps(createFakeSync());
		const entry = await registerAsset(d, {
			honeycombId: HC_ID,
			assetType: "skill",
			harness: "claude_code",
			style: "Repository",
			contentHash: "h-1",
			scope: SCOPE,
		});
		expect(entry.sourcePath).toBeUndefined();
		expect(d.registry.read()[0]!.sourcePath).toBeUndefined();
	});

	it("preserves sourcePath across a tier transition (promote keeps the recorded source)", async () => {
		const d = deps(createFakeSync());
		seedLocal(d, { sourcePath: "/abs/path/skill" });
		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Team", scope: SCOPE, native: "B", contentHash: "h" });
		expect(d.registry.read()[0]!.tier).toBe("Team");
		expect(d.registry.read()[0]!.sourcePath).toBe("/abs/path/skill");
	});
});

describe("PRD-033b b-AC-2 — Local→Team publishes; Team→Local tombstones", () => {
	it("Local→Team promotion calls publish; the registry ends at Team", async () => {
		const sync = createFakeSync({ publishVersion: 5 });
		const d = deps(sync);
		seedLocal(d);

		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Team", scope: SCOPE, native: "BODY", contentHash: "h-team" });

		expect(res.direction).toBe("promote");
		expect(res.published).toBe(true);
		expect(sync.publishes).toHaveLength(1);
		expect(sync.tombstones).toHaveLength(0);
		expect(d.registry.read()[0]!.tier).toBe("Team");
		expect(d.registry.read()[0]!.version).toBe(5);
	});

	it("Team→Local demotion writes a tombstone; the registry ends at Local", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d, { tier: "Team" });

		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Local", scope: SCOPE });

		expect(res.direction).toBe("demote");
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones.length).toBeGreaterThanOrEqual(1);
		expect(d.registry.read()[0]!.tier).toBe("Local");
	});
});

describe("PRD-033b b-AC-3 — Device publish scope is author + device_set", () => {
	it("a Device promotion publishes at the Device cell carrying the author + device set", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d);

		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Device", scope: SCOPE, native: "B", contentHash: "h", deviceSet: ["dev-1"] });

		expect(sync.publishes).toHaveLength(1);
		const req = sync.publishes[0]!;
		expect(req.cell.tier).toBe("Device");
		// The Device audience is keyed by author + the device set (FR-7).
		expect(req.scope.author).toBe("mario");
		expect(req.deviceSet).toContain("dev-1");
	});

	it("the acting device id is ensured present in the published device set (a-AC-4)", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d);
		// Pass a device set WITHOUT this machine's id; the lifecycle adds scope.deviceId.
		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Device", scope: SCOPE, native: "B", contentHash: "h", deviceSet: ["other-dev"] });
		expect(sync.publishes[0]!.deviceSet).toEqual(["other-dev", "dev-1"]);
	});
});

describe("PRD-033b b-AC-4 — Team publish scope is org + workspace", () => {
	it("a Team promotion publishes at the Team cell carrying org + workspace, empty device set", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d);

		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Team", scope: SCOPE, native: "B", contentHash: "h" });

		const req = sync.publishes[0]!;
		expect(req.cell.tier).toBe("Team");
		expect(req.scope.org).toBe("acme");
		expect(req.scope.workspace).toBe("platform");
		// Team reach is org+workspace, NOT a device set.
		expect(req.deviceSet).toEqual([]);
	});
});

describe("PRD-033b b-AC-5 — demotion tombstones EVERY wider tier left (jump-aware)", () => {
	it("a Team→Local jump tombstones BOTH Team and Device", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d, { tier: "Team", deviceSet: ["dev-1"] });

		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Local", scope: SCOPE });

		expect(res.tombstonedTiers).toEqual(["Team", "Device"]);
		const tieredCells = sync.tombstones.map((t) => t.cell.tier).sort();
		expect(tieredCells).toEqual(["Device", "Team"]);
		// The Device tombstone carries the device set so it reaches the right machines; the Team
		// tombstone carries none (Team reach is org+workspace).
		const deviceT = sync.tombstones.find((t) => t.cell.tier === "Device")!;
		const teamT = sync.tombstones.find((t) => t.cell.tier === "Team")!;
		expect(deviceT.deviceSet).toContain("dev-1");
		expect(teamT.deviceSet).toEqual([]);
	});

	it("a Team→Device demotion tombstones ONLY Team (Device is the new home, not left)", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d, { tier: "Team" });

		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Device", scope: SCOPE });

		expect(res.tombstonedTiers).toEqual(["Team"]);
		expect(sync.tombstones).toHaveLength(1);
		expect(sync.tombstones[0]!.cell.tier).toBe("Team");
		expect(d.registry.read()[0]!.tier).toBe("Device");
	});

	it("a Device→Local demotion tombstones ONLY Device", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d, { tier: "Device", deviceSet: ["dev-1"] });

		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Local", scope: SCOPE });

		expect(res.tombstonedTiers).toEqual(["Device"]);
		expect(d.registry.read()[0]!.tier).toBe("Local");
		expect(d.registry.read()[0]!.deviceSet).toEqual([]);
	});
});

describe("PRD-033b b-AC-6 — every transition ends in EXACTLY one cell; illegal moves rejected", () => {
	it("a style-only flip publishes/tombstones nothing and keeps the tier", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d, { tier: "Team", style: "Repository" });

		const res = await transitionAsset(d, { honeycombId: HC_ID, toStyle: "User", scope: SCOPE });

		expect(res.direction).toBe("none");
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones).toHaveLength(0);
		expect(d.registry.read()[0]!.tier).toBe("Team");
		expect(d.registry.read()[0]!.style).toBe("User");
	});

	it("the registry holds exactly one entry per artifact after any sequence of moves", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d);
		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Device", scope: SCOPE, native: "B", contentHash: "h", deviceSet: ["dev-1"] });
		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Team", scope: SCOPE, native: "B", contentHash: "h2" });
		await transitionAsset(d, { honeycombId: HC_ID, toStyle: "User", scope: SCOPE });
		await transitionAsset(d, { honeycombId: HC_ID, toTier: "Local", scope: SCOPE });

		const stored = d.registry.read();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.tier).toBe("Local");
		expect(stored[0]!.style).toBe("User");
	});

	it("transitioning an UNKNOWN artifact throws TransitionError (rejected, no write)", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		await expect(transitionAsset(d, { honeycombId: "hc_unknown", toTier: "Team", scope: SCOPE })).rejects.toBeInstanceOf(TransitionError);
		expect(sync.publishes).toHaveLength(0);
	});
});

describe("PRD-033b — promotion to Local publishes nothing (Local is unmanaged)", () => {
	it("a Local→Local same-cell move is a legal no-op with no DeepLake write", async () => {
		const sync = createFakeSync();
		const d = deps(sync);
		seedLocal(d);
		const res = await transitionAsset(d, { honeycombId: HC_ID, toTier: "Local", scope: SCOPE });
		expect(res.direction).toBe("none");
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones).toHaveLength(0);
	});
});
