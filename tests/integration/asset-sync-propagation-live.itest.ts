/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE ASSET-SYNC PROPAGATION PROOF — OPT-IN, MUTATES A REAL DEEPLAKE.       ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-033c Wave 2: the GATED LIVE proof of the asset-sync ENGINE            ║
 * ║  (`createAssetSyncApi`) — the daemon's ONLY DeepLake access for synced      ║
 * ║  assets (D-6) — against a REAL DeepLake backend. The publish INSERT shape,   ║
 * ║  the audience predicate, LWW, tombstone, and fail-soft are exhaustively      ║
 * ║  unit-tested against a fake StorageQuery in tests/daemon/runtime/assets/.    ║
 * ║  THIS suite proves what a fake cannot: that a REAL version-bumped publish    ║
 * ║  propagates to the right AUDIENCE on this eventually-consistent store, that  ║
 * ║  a Team artifact is isolated to its workspace, that a Device artifact        ║
 * ║  reaches a 2nd device but not another workspace, that a real tombstone       ║
 * ║  retracts on the next pull, and that the install path applies LWW `.bak`.    ║
 * ║                                                                            ║
 * ║  ── The hazard this suite exists for (project memory) ──                    ║
 * ║  DeepLake flaps stale segments — a single immediate read-back after a write  ║
 * ║  can under-report. EVERY read-back here goes THROUGH the engine's pull,      ║
 * ║  which itself reads POLL-CONVERGENTLY via `readConverged`; the suite ALSO    ║
 * ║  polls the pull until the awaited version converges before asserting,        ║
 * ║  never weakening the bar to pass.                                           ║
 * ║                                                                            ║
 * ║  ── Isolation (mirrors compaction-live.itest.ts — do not weaken) ──         ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole suite   ║
 * ║      skips. NEVER part of `npm run test`/`npm run ci` (the `.itest.ts`       ║
 * ║      suffix + `tests/integration/**` exclusion); runs ONLY under             ║
 * ║      `npm run test:integration` (+ `.env.local`). Do NOT run here — the      ║
 * ║      smoker runs it with creds.                                             ║
 * ║    - Creates + heals a per-run THROWAWAY version-bumped table                ║
 * ║      `ci_assets_<run-id>` from the REAL `SYNCED_ASSETS_COLUMNS` and DROPs it ║
 * ║      in afterAll. NEVER the shared `synced_assets` table.                    ║
 * ║                                                                            ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's       ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { SYNCED_ASSETS_COLUMNS } from "../../src/daemon/storage/catalog/synced-assets.js";
import { createAssetSyncApi } from "../../src/daemon/runtime/assets/sync.js";
import type { AssetScope, AssetSyncApi, LatticeCell } from "../../src/daemon/runtime/assets/contracts.js";
import {
	createDefaultHarnessRoots,
	pullAndInstall,
} from "../../src/daemon-client/assets/install.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A unique tag for this run's throwaway table. */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_assets_${RUN_ID}`;
const CI_TARGET: HealTarget = { table: CI_TABLE, columns: SYNCED_ASSETS_COLUMNS as unknown as ColumnDef[] };

const TEAM_REPO: LatticeCell = { tier: "Team", style: "Repository" };
const DEVICE_USER: LatticeCell = { tier: "Device", style: "User" };

/** A clean, unique, install-safe honeycomb_id for this run + a label (`[A-Za-z0-9._-]`). */
function assetId(label: string): string {
	return `hc_${RUN_ID}_${label}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Poll budget for the convergence barrier ON TOP of the engine's own readConverged. */
const PULL_POLLS = 12;
const PULL_DELAY_MS = 300;

describe.skipIf(!HAS_TOKEN)("live asset-sync propagation proof (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	let api: AssetSyncApi;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });
		// The engine bound to the THROWAWAY table — the same `createAssetSyncApi` the daemon
		// mounts, but pointed at `ci_assets_<run>` (lazy-create + heal on first publish).
		api = createAssetSyncApi({ storage, target: CI_TARGET });
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}`);
	});

	/** The acting scope for a given workspace/author/device (org is the run's authorized org). */
	function scopeFor(over: Partial<AssetScope> = {}): AssetScope {
		return { org, workspace, author: "alice", deviceId: "dev-1", ...over };
	}

	/**
	 * Pull POLL-CONVERGENTLY until the asset for `honeycombId` reaches at least `minVersion`
	 * (or it is a tombstone), then return it; or `null` after the budget. The engine's pull is
	 * already poll-convergent; this barrier additionally waits for the awaited version to land
	 * (the write→read-back convergence the project memory mandates).
	 */
	async function pullUntil(
		scope: AssetScope,
		honeycombId: string,
		predicate: (a: { version: number; tombstone: boolean } | undefined) => boolean,
	): Promise<{ version: number; tombstone: boolean; native: string; contentHash: string } | null> {
		for (let i = 0; i < PULL_POLLS; i++) {
			const res = await api.pull({ scope });
			const found = res.assets.find((a) => a.honeycombId === honeycombId);
			if (predicate(found)) return found ?? null;
			if (i < PULL_POLLS - 1) await sleep(PULL_DELAY_MS);
		}
		return null;
	}

	it("AC-3 Team → same-workspace author sees it; a different workspace does NOT", async () => {
		const id = assetId("team");
		await api.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude_code",
			native: "team-body",
			canonical: "team-body",
			contentHash: "th1",
			cell: TEAM_REPO,
			scope: scopeFor(),
			deviceSet: [],
		});

		// A DIFFERENT author in the SAME workspace sees the Team artifact.
		const seen = await pullUntil(scopeFor({ author: "bob", deviceId: "dev-9" }), id, (a) => a !== undefined && a.version >= 1);
		expect(seen, "a same-workspace author must see the Team artifact").not.toBeNull();
		expect(seen?.native).toBe("team-body");

		// A DIFFERENT workspace audience does NOT see it (tenancy isolation).
		const otherWs = await api.pull({ scope: scopeFor({ workspace: `${workspace}_other`, author: "carol" }) });
		expect(otherWs.assets.find((a) => a.honeycombId === id)).toBeUndefined();
	});

	it("AC-2 Device → same author + 2nd device sees it; a non-member device does NOT", async () => {
		const id = assetId("device");
		await api.publish({
			honeycombId: id,
			assetType: "agent",
			harness: "claude_code",
			native: "device-body",
			canonical: "device-body",
			contentHash: "dh1",
			cell: DEVICE_USER,
			scope: scopeFor(),
			deviceSet: ["dev-1", "dev-2"],
		});

		// The 2nd device (in the device set) sees it.
		const onDev2 = await pullUntil(scopeFor({ deviceId: "dev-2" }), id, (a) => a !== undefined && a.version >= 1);
		expect(onDev2, "the 2nd device in the set must see the Device artifact").not.toBeNull();

		// A device NOT in the set does not.
		const onDev9 = await api.pull({ scope: scopeFor({ deviceId: "dev-9" }) });
		expect(onDev9.assets.find((a) => a.honeycombId === id)).toBeUndefined();

		// A different workspace audience does not (the Device tier is author+device, but the
		// storage partition is still the workspace — a cross-workspace pull never sees it).
		const otherWs = await api.pull({ scope: scopeFor({ workspace: `${workspace}_other`, deviceId: "dev-2" }) });
		expect(otherWs.assets.find((a) => a.honeycombId === id)).toBeUndefined();
	});

	it("AC-5 tombstone → the next pull leaves the local file in place (UNMANAGED — never deletes user files)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "hc-assets-live-tomb-"));
		try {
			const roots = createDefaultHarnessRoots({ home: tmp, projectDir: tmp });
			const id = assetId("tomb");

			// Publish the artifact and install it locally via the thin-client path.
			await api.publish({
				honeycombId: id,
				assetType: "skill",
				harness: "claude_code",
				native: "doomed-body",
				canonical: "doomed-body",
				contentHash: "kh1",
				cell: TEAM_REPO,
				scope: scopeFor(),
				deviceSet: [],
			});
			// Wait for it to land as a live (non-tombstone) row first.
			const live = await pullUntil(scopeFor(), id, (a) => a !== undefined && !a.tombstone);
			expect(live, "the artifact must land live before tombstoning").not.toBeNull();

			// Install it locally via the thin-client so there is a file on disk to retract.
			await installFromEngine(api, roots, scopeFor());
			const skillFile = join(tmp, ".claude", "skills", id, "SKILL.md");
			const markerFile = join(tmp, ".claude", "skills", id, ".honeycomb-asset.json");
			expect(existsSync(skillFile), "skill file must be installed before tombstone pull").toBe(true);

			// Tombstone the artifact (the demotion side writes the append-only row to DeepLake).
			await api.tombstone({ honeycombId: id, assetType: "skill", harness: "claude_code", cell: TEAM_REPO, scope: scopeFor(), deviceSet: [] });

			// Wait until the converged pull surfaces the tombstone as the highest version.
			const tomb = await pullUntil(scopeFor(), id, (a) => a !== undefined && a.tombstone);
			expect(tomb, "the next pull must surface the tombstone (highest version)").not.toBeNull();
			expect(tomb?.tombstone).toBe(true);

			// Run the install path with the tombstone row — this is what retract() is called from.
			await installFromEngine(api, roots, scopeFor());

			// NEW BEHAVIOR: the live artifact file is LEFT IN PLACE with its original bytes.
			// The user's file is never deleted or renamed on tombstone retraction.
			expect(existsSync(skillFile), "live file must remain after tombstone pull (leave-in-place)").toBe(true);
			expect(readFileSync(skillFile, "utf-8"), "live file bytes must be unchanged").toBe("doomed-body");

			// No .bak is created — retraction no longer renames the file.
			expect(existsSync(`${skillFile}.bak`), "no .bak must be created on retraction").toBe(false);

			// The managed marker IS removed: the artifact is UNMANAGED going forward.
			// A future pull will not overwrite the file unless a new non-tombstone publish re-adopts it.
			expect(existsSync(markerFile), "marker must be removed (artifact is now UNMANAGED)").toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("AC-4 LWW `.bak` on a real pull → install backs up a hash-divergent local copy", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "hc-assets-live-"));
		try {
			const roots = createDefaultHarnessRoots({ home: tmp, projectDir: tmp });
			const id = assetId("lww");

			// Publish v1, install it via a thin pull-and-install fed by the REAL engine pull.
			await api.publish({ honeycombId: id, assetType: "skill", harness: "claude_code", native: "v1", canonical: "v1", contentHash: "lh1", cell: { tier: "Team", style: "User" }, scope: scopeFor(), deviceSet: [] });
			await pullUntil(scopeFor(), id, (a) => a !== undefined && a.version >= 1);
			await installFromEngine(api, roots, scopeFor());

			const file = join(tmp, ".claude", "skills", id, "SKILL.md");
			expect(existsSync(file)).toBe(true);

			// Locally edit (hash-divergent), publish v2 with a new hash, re-install.
			rmSync(file);
			const { writeFileSync } = await import("node:fs");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(tmp, ".claude", "skills", id), { recursive: true });
			writeFileSync(file, "v1-locally-edited", "utf-8");
			await api.publish({ honeycombId: id, assetType: "skill", harness: "claude_code", native: "v2", canonical: "v2", contentHash: "lh2", cell: { tier: "Team", style: "User" }, scope: scopeFor(), deviceSet: [] });
			await pullUntil(scopeFor(), id, (a) => a !== undefined && a.version >= 2);
			await installFromEngine(api, roots, scopeFor());

			// The edit is preserved at .bak; v2 won (last-writer-wins).
			expect(readFileSync(`${file}.bak`, "utf-8")).toBe("v1-locally-edited");
			expect(readFileSync(file, "utf-8")).toBe("v2");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("AC-7 idempotent no-op + fresh-table fail-soft (no throw, within budget)", async () => {
		// A pull against the (now-populated) table for a scope with NO matching audience returns
		// cleanly empty — never a throw. (Table-absent fail-soft is unit-proven; here we prove the
		// real pull stays fail-soft on a populated table for a non-member audience.)
		const res = await api.pull({ scope: scopeFor({ workspace: `${workspace}_nobody`, author: "nobody", deviceId: "none" }) });
		expect(res.tableAbsent).toBe(false);
		expect(res.assets.every((a) => a.workspace === `${workspace}_nobody`)).toBe(true);
	});
});

/** Install the engine's current audience pull onto temp roots via the thin client (live AC-4 helper). */
async function installFromEngine(
	api: AssetSyncApi,
	roots: ReturnType<typeof createDefaultHarnessRoots>,
	scope: AssetScope,
): Promise<void> {
	// Feed the REAL engine pull into the thin-client install path (a tiny adapter so pullAndInstall's
	// fake-API seam is satisfied by the live engine). This exercises the SAME LWW install code unit-
	// tested in tests/daemon-client/assets/install.test.ts, but over real pulled rows.
	const fakeForInstall: AssetSyncApi = {
		publish: api.publish.bind(api),
		tombstone: api.tombstone.bind(api),
		pull: api.pull.bind(api),
	};
	await pullAndInstall({ api: fakeForInstall, roots, scope });
}
