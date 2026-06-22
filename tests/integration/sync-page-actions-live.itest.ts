/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE SYNC-PAGE ACTIONS PROOF — OPT-IN, MUTATES A REAL DEEPLAKE.            ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-042 (AC-8 / a-AC-3 / b-AC-3 / c-AC-6): the GATED LIVE proof that the   ║
 * ║  Sync page's action engine (`createSyncActionApi`) drives the REAL          ║
 * ║  substrate pipelines against a REAL DeepLake backend:                       ║
 * ║    - promote a local asset → it converges to `shared` (a version-bumped row);║
 * ║    - pull a shared asset → it installs locally → `pulled`;                   ║
 * ║    - demote → it tombstones → the converged read is no longer live `shared`. ║
 * ║  Each verified by polling for convergence (DeepLake flaps stale segments —   ║
 * ║  project memory), never a single immediate read, never weakening the bar.   ║
 * ║                                                                            ║
 * ║  ── Isolation (mirrors asset-sync-propagation-live.itest.ts — do not weaken) ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole suite   ║
 * ║      skips. NEVER part of `npm run test` / `npm run ci` (the `.itest.ts`     ║
 * ║      suffix + `tests/integration/**` exclusion); runs ONLY under             ║
 * ║      `npm run test:integration` (+ `.env.local`).                           ║
 * ║    - Creates + heals a per-run THROWAWAY table `ci_sync_<run>` from the REAL ║
 * ║      `SYNCED_ASSETS_COLUMNS` and DROPs it in afterAll. NEVER the shared      ║
 * ║      `synced_assets` table. The install target is a per-run temp dir.        ║
 * ║                                                                            ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's       ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
import type { AssetScope, SyncedAssetType } from "../../src/daemon/runtime/assets/contracts.js";
import { createSyncActionApi, type SyncActionApi } from "../../src/daemon/runtime/dashboard/sync-api.js";
import { createFsAssetInstallTarget, type AssetInstallTarget } from "../../src/daemon/runtime/dashboard/asset-install-target.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A unique tag for this run's throwaway table. */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_sync_${RUN_ID}`;
const CI_TARGET: HealTarget = { table: CI_TABLE, columns: SYNCED_ASSETS_COLUMNS as unknown as ColumnDef[] };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ACTION_POLLS = 12;
const ACTION_DELAY_MS = 300;

/** A clean, install-safe honeycomb_id for this run + a label (`[A-Za-z0-9._-]`). */
function assetId(label: string): string {
	return `hc_${RUN_ID}_${label}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

describe.skipIf(!HAS_TOKEN)("live Sync-page actions proof (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	let api: SyncActionApi;
	let installTarget: AssetInstallTarget;
	let tmp: string;
	let projectDir: string;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = { read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }) };
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });
		tmp = mkdtempSync(join(tmpdir(), "hc-sync-live-"));
		projectDir = join(tmp, "project");
		mkdirSync(projectDir, { recursive: true });
		installTarget = createFsAssetInstallTarget({ projectDir, globalDir: join(tmp, "home") });
		// The SAME engine the daemon mounts, pointed at the THROWAWAY table (lazy-create + heal).
		const engine = createAssetSyncApi({ storage, target: CI_TARGET });
		api = createSyncActionApi({ storage, engine, installTarget });
	});

	afterAll(async () => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}`);
	});

	function scopeFor(over: Partial<AssetScope> = {}): AssetScope {
		return { org, workspace, author: "alice", deviceId: "dev-1", ...over };
	}

	/** Seed a local on-disk asset so promote reads its native body. */
	function seedLocal(assetType: SyncedAssetType, name: string, body: string): void {
		if (assetType === "agent") {
			const dir = join(projectDir, ".claude", "agents");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${name}.md`), body, "utf-8");
		} else {
			const dir = join(projectDir, ".claude", "skills", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
		}
	}

	it("a-AC-3 / AC-8: promote a local skill → converges to shared", async () => {
		const id = assetId("promote_skill");
		seedLocal("skill", "live-skill", "live-skill-body");
		// Poll the promote until the converged read-back confirms `shared` (the action itself
		// reads poll-convergently; this barrier waits for the backend to settle).
		let ok = false;
		for (let i = 0; i < ACTION_POLLS; i++) {
			const res = await api.promote({ assetType: "skill", name: "live-skill", honeycombId: id, scope: scopeFor() });
			if (res.ok && res.state === "shared") {
				ok = true;
				break;
			}
			await sleep(ACTION_DELAY_MS);
		}
		expect(ok, "promote must converge to shared on the real backend").toBe(true);
	}, 30_000);

	it("b-AC-3 / AC-8: promote a local agent → converges to shared (symmetry)", async () => {
		const id = assetId("promote_agent");
		seedLocal("agent", "live-agent", "live-agent-body");
		let ok = false;
		for (let i = 0; i < ACTION_POLLS; i++) {
			const res = await api.promote({ assetType: "agent", name: "live-agent", honeycombId: id, scope: scopeFor() });
			if (res.ok && res.state === "shared") {
				ok = true;
				break;
			}
			await sleep(ACTION_DELAY_MS);
		}
		expect(ok, "an agent promote must converge to shared (symmetric to skills)").toBe(true);
	}, 30_000);

	it("a-AC-4: pull a shared skill → installs locally → pulled", async () => {
		const id = assetId("pull_skill");
		// Publish a teammate's skill directly through the engine, then pull it as another author.
		const engine = createAssetSyncApi({ storage, target: CI_TARGET });
		await engine.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude-code",
			native: "pulled-skill-body",
			canonical: "pulled-skill-body",
			contentHash: "ph1",
			cell: { tier: "Team", style: "Repository" },
			scope: scopeFor(),
			deviceSet: [],
		});
		let ok = false;
		for (let i = 0; i < ACTION_POLLS; i++) {
			const res = await api.pull({ assetType: "skill", name: "pulled-skill", honeycombId: id, scope: scopeFor({ author: "bob", deviceId: "dev-9" }) });
			if (res.ok && res.state === "pulled" && installTarget.exists("skill", "project", "pulled-skill")) {
				ok = true;
				break;
			}
			await sleep(ACTION_DELAY_MS);
		}
		expect(ok, "pull must install the artifact and converge to pulled").toBe(true);
	}, 30_000);

	it("a-AC-5 / AC-8: demote a shared skill → tombstones → no longer live shared", async () => {
		const id = assetId("demote_skill");
		const engine = createAssetSyncApi({ storage, target: CI_TARGET });
		await engine.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude-code",
			native: "to-demote-body",
			canonical: "to-demote-body",
			contentHash: "dh1",
			cell: { tier: "Team", style: "Repository" },
			scope: scopeFor(),
			deviceSet: [],
		});
		let ok = false;
		for (let i = 0; i < ACTION_POLLS; i++) {
			const res = await api.demote({ assetType: "skill", name: "to-demote", honeycombId: id, scope: scopeFor() });
			if (res.ok && res.state === "local") {
				ok = true;
				break;
			}
			await sleep(ACTION_DELAY_MS);
		}
		expect(ok, "demote must tombstone and converge off live shared").toBe(true);
	}, 30_000);
});
