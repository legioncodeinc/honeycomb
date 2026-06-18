/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE codebase push/pull SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-014c: exercise the `pushSnapshot`/`pullSnapshot` engine end-to-end  ║
 * ║  against the REAL DeepLake backend through the daemon's StorageQuery:    ║
 * ║    1. push a real finalized snapshot for an identity tuple → `inserted`. ║
 * ║    2. re-push the SAME snapshot_sha256 → `already-current` (no dup row). ║
 * ║    3. push a DIFFERENT hash for the SAME identity → `drift`, REFUSED     ║
 * ║       (the stored row is NOT overwritten — assert the stored hash is the ║
 * ║       original).                                                          ║
 * ║    4. pull for HEAD → `pulled` with the recomputed stable-hash == the    ║
 * ║       claimed snapshot_sha256 (hash revalidation round-trips live).       ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY TABLE-ISOLATED (the proven recall-authz / graph-persist║
 * ║  / sources-purge technique — NOT a SQL-string proxy):                    ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keeps it OUT ║
 * ║      of `npm run test` / `npm run ci`. Only `npm run test:integration`. ║
 * ║    - Authorised workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default       ║
 * ║      `honeycomb_ci`). An invented workspace is 403-rejected.             ║
 * ║    - The push/pull `resolveTable` SEAM routes the canonical `codebase`  ║
 * ║      name to a per-run THROWAWAY table (`ci_codebase_<runid>`): the      ║
 * ║      heal-aware push CREATEs the physical throwaway table NATIVELY on    ║
 * ║      first touch. A SQL-string proxy is FORBIDDEN — it races the heal's  ║
 * ║      CREATE/introspect/ALTER and corrupts a fresh table. DROPped in       ║
 * ║      afterAll. NEVER touches the real `codebase` table.                  ║
 * ║    - `queryTimeoutMs: 120_000`. Multi-row reads are POLL-CONVERGENT      ║
 * ║      (the engine's own poll budget + `scanDistinct` here for read-backs).║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The orchestrator runs this (`npm run test:integration`), NOT the Wave-1 gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import {
	buildAggregateSnapshot,
	finalizeSnapshot,
} from "../../src/daemon/runtime/codebase/snapshot.js";
import type { SnapshotIdentity } from "../../src/daemon/runtime/codebase/contracts.js";
import {
	CODEBASE_TABLE,
	type PushPullContext,
	pullSnapshot,
	pushSnapshot,
} from "../../src/daemon/runtime/codebase/push-pull.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_CODEBASE = `ci_codebase_${RUN_ID}`;

/** Poll budget for a poll-convergent scan (a bare scan can return a stale subset). */
const SCAN_POLLS = 20;

/** Poll a single-column scan SCAN_POLLS times and union the distinct values observed. */
async function scanDistinct(store: StorageClient, sql: string, column: string, s: QueryScope): Promise<Set<string>> {
	const seen = new Set<string>();
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await store.query(sql, s);
		if (isOk(res)) {
			for (const row of res.rows) {
				const v = row[column];
				if (typeof v === "string") seen.add(v);
				else if (v !== undefined && v !== null) seen.add(String(v));
			}
		}
	}
	return seen;
}

describe.skipIf(!HAS_TOKEN)("live codebase push/pull smoke (opt-in, real backend, 014c engine)", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_CODEBASE)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_CODEBASE}: ${JSON.stringify(res)}`);
	});

	/** A real finalized snapshot for the given files + identity (genuine canonical hash). */
	async function snapshotFor(identity: SnapshotIdentity, files: Record<string, string>) {
		const deps = {
			gitLsFiles: () => Object.keys(files).join("\0"),
			readFile: (abs: string) => {
				const key = Object.keys(files).find((k) => abs.replace(/\\/g, "/").endsWith(k));
				if (key === undefined) throw new Error(`no fixture for ${abs}`);
				return files[key];
			},
			noCache: true as const,
		};
		const build = await buildAggregateSnapshot("/repo", identity, deps);
		return finalizeSnapshot(build);
	}

	it("push (insert) → re-push same hash (already-current) → drift refused → pull + hash-revalidate", async () => {
		const identity: SnapshotIdentity = {
			org: scope.org,
			workspace: scope.workspace ?? "default",
			repo: "honeycomb",
			user: `ci-${RUN_ID}`,
			worktree: `wt-${RUN_ID}`,
			commit: `commit-${RUN_ID}`,
		};

		// Route the canonical `codebase` name to the per-run THROWAWAY table NATIVELY
		// via the engine's `resolveTable` seam — the heal-aware push CREATEs the
		// physical throwaway table directly (the proven isolation technique). A
		// SQL-string proxy is FORBIDDEN: it races the heal and corrupts a fresh table.
		const resolveTable = (canonical: string): string =>
			canonical === CODEBASE_TABLE ? TBL_CODEBASE : canonical;
		const ctx: PushPullContext = { storage, scope, authenticated: true, pushedBy: identity.user, resolveTable };

		const original = await snapshotFor(identity, {
			"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
			"src/b.ts": "export function b(){}\n",
		});

		// 1. First push: absent → INSERT (heals/creates the throwaway table).
		const first = await pushSnapshot(original.snapshot, original.sha256, identity, ctx);
		expect(first.kind, `first push inserted (was ${JSON.stringify(first)})`).toBe("inserted");

		// 2. Re-push the SAME hash for the SAME identity → already-current no-op.
		const second = await pushSnapshot(original.snapshot, original.sha256, identity, ctx);
		expect(second.kind).toBe("already-current");

		// Poll-convergent: exactly ONE stored hash for this identity, and it is the original.
		const whereId =
			`WHERE ${sqlIdent("user_id")} = ${sLiteral(identity.user)} ` +
			`AND ${sqlIdent("commit_sha")} = ${sLiteral(identity.commit)}`;
		const hashes1 = await scanDistinct(
			storage,
			`SELECT snapshot_sha256 FROM "${sqlIdent(TBL_CODEBASE)}" ${whereId}`,
			"snapshot_sha256",
			scope,
		);
		expect(hashes1.has(original.sha256)).toBe(true);
		expect(hashes1.size, "exactly one snapshot hash for the identity (no duplicate)").toBe(1);

		// 3. Push a DIFFERENT hash for the SAME identity → drift, REFUSED (no overwrite).
		// A different commit content yields a genuinely different stable hash; force the
		// same identity by reusing it but with a drifted snapshot.
		const drifted = await snapshotFor(identity, {
			"src/a.ts": "import { b } from './b';\nexport function a(){ b(); b(); }\n",
			"src/b.ts": "export function b(){}\nexport function extra(){}\n",
		});
		expect(drifted.sha256, "the drifted snapshot has a different hash").not.toBe(original.sha256);

		const driftPush = await pushSnapshot(drifted.snapshot, drifted.sha256, identity, ctx);
		expect(driftPush.kind).toBe("drift");

		// The stored hash is STILL the original — drift never clobbered it.
		const hashes2 = await scanDistinct(
			storage,
			`SELECT snapshot_sha256 FROM "${sqlIdent(TBL_CODEBASE)}" ${whereId}`,
			"snapshot_sha256",
			scope,
		);
		expect(hashes2.has(original.sha256), "stored hash unchanged after drift").toBe(true);
		expect(hashes2.has(drifted.sha256), "drifted hash was NOT stored (refused)").toBe(false);

		// 4. Pull for HEAD → pulled, recomputed stable-hash == claimed snapshot_sha256.
		const pulled = await pullSnapshot(identity, ctx, { headCommit: identity.commit });
		expect(pulled.kind, `pull revalidates (was ${JSON.stringify(pulled.kind)})`).toBe("pulled");
		if (pulled.kind === "pulled") {
			expect(pulled.sha256, "pulled hash == the original stored hash").toBe(original.sha256);
		}
	});
});
