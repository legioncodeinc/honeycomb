/**
 * PRD-030 Wave 2a — the standalone compaction trigger seam suite (D-2 PRIMARY).
 *
 * Verification posture (mirrors the dream/dashboard/logs seam suites): the seam is mounted on
 * a REAL daemon (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's
 * permission middleware is open) and exercised in-process via `daemon.app.request(...)` — no
 * socket, no live DeepLake. A FAKE compactor seam records the call + scripts the per-table
 * summary, and a FAKE existence probe scripts which tables exist, so each test proves the
 * wiring + the summary contract WITHOUT touching the real compactor or a live catalog.
 *
 * The cases prove:
 *  - the handler runs the compactor over EVERY allow-listed version-bumped table that EXISTS,
 *    resolving each table's key column + catalog columns.
 *  - a table that does NOT exist is SKIPPED (no compactor call, no 500) and reported in
 *    `skippedTables`.
 *  - `--table <name>` (body `{table}`) narrows the pass to one allow-listed table; an unknown
 *    table name compacts nothing.
 *  - a per-table compaction error is fail-soft (folded into `errored`), never a 500.
 *  - the fail-closed edge: a request with NO resolvable org is 400'd.
 *  - the summary body carries no token/secret/header value.
 */

import { describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type CompactSeam,
	type CompactSummaryBody,
	COMPACTABLE_KEY_COLUMNS,
	keyColumnFor,
	mountCompactApi,
} from "../../../../src/daemon/runtime/maintenance/compact-api.js";
import { COMPACTABLE_VERSION_BUMPED_TABLES, type CompactionRetention } from "../../../../src/daemon/storage/compaction.js";
import type { HealTarget } from "../../../../src/daemon/storage/heal.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A minimal fake storage client — the compactor seam override never touches it. */
const fakeStorage = { async query() { return { kind: "ok", rows: [], durationMs: 0 }; } } as unknown as StorageQuery;

/** The daemon's default tenancy scope (the single local tenant). */
const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

/** A fixed retention policy injected so the mount never reads the env. */
const RETENTION: CompactionRetention = {
	keepLatestN: 5,
	windowDays: 30,
	timestampColumn: "updated_at",
	versionColumn: "version",
};

/** One recorded compactor call (table + key column) for assertion. */
interface RecordedCompact {
	readonly table: string;
	readonly keyColumn: string;
	readonly columns: number;
}

/**
 * A recording fake compactor seam: records each call (table + key column + column count) and
 * returns a scripted summary. `reaped` per table drives `rowsReaped`; an `error` table throws.
 */
function recordingCompactor(opts: { reaped?: Readonly<Record<string, number>>; skipped?: Readonly<Record<string, number>>; error?: string } = {}): {
	seam: CompactSeam;
	calls: RecordedCompact[];
} {
	const calls: RecordedCompact[] = [];
	const seam: CompactSeam = {
		async compact(_client: StorageQuery, target: HealTarget, _scope: QueryScope, o: { keyColumn: string; retention: CompactionRetention }) {
			calls.push({ table: target.table, keyColumn: o.keyColumn, columns: target.columns.length });
			if (opts.error !== undefined && opts.error === target.table) throw new Error("simulated flap");
			return {
				table: target.table,
				keysScanned: 1,
				keysCompacted: (opts.reaped?.[target.table] ?? 0) > 0 ? 1 : 0,
				rowsReaped: opts.reaped?.[target.table] ?? 0,
				keysSkipped: opts.skipped?.[target.table] ?? 0,
			};
		},
	};
	return { seam, calls };
}

/** A fake existence probe scripted by a present-set; tables NOT in the set are absent. */
function presence(present: ReadonlySet<string>): (c: StorageQuery, t: string, s: QueryScope) => Promise<boolean | null> {
	return async (_c, t) => present.has(t);
}

/** Mount the compact seam on a fresh local-mode daemon with the supplied fakes. */
function daemonWithCompactor(
	seam: CompactSeam,
	exists: (c: StorageQuery, t: string, s: QueryScope) => Promise<boolean | null>,
	over: Partial<RuntimeConfig> = {},
	scope: QueryScope = DEFAULT_SCOPE,
): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: fakeStorage as never, logger: createRequestLogger({ silent: true }) });
	mountCompactApi(daemon, { storage: fakeStorage, defaultScope: scope, compactor: seam, exists, retention: RETENTION });
	return daemon;
}

/** POST to the compact endpoint with an optional body and return the parsed summary + status. */
async function postCompact(daemon: Daemon, body?: unknown): Promise<{ status: number; out: CompactSummaryBody }> {
	const res = await daemon.app.request("/api/diagnostics/compact", {
		method: "POST",
		...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
	});
	const out = (await res.json()) as CompactSummaryBody;
	return { status: res.status, out };
}

describe("PRD-030 D-2 — the compaction trigger runs the Wave-1 compactor over the allow-listed tables", () => {
	it("runs the compactor over EVERY allow-listed version-bumped table that EXISTS, resolving each key column", async () => {
		const present = new Set(COMPACTABLE_VERSION_BUMPED_TABLES);
		const { seam, calls } = recordingCompactor({ reaped: { skills: 4, dreaming_state: 2 } });
		const daemon = daemonWithCompactor(seam, presence(present));

		const { status, out } = await postCompact(daemon);

		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		// One compactor call per allow-listed table.
		expect(calls.map((c) => c.table).sort()).toEqual(Array.from(present).sort());
		// Each call resolved the table's key column + catalog columns (a non-empty ColumnDef array).
		for (const call of calls) {
			expect(call.keyColumn).toBe(keyColumnFor(call.table));
			expect(call.columns).toBeGreaterThan(0);
		}
		// The summary carries the per-table reaps.
		const bySummary = Object.fromEntries(out.summaries.map((s) => [s.table, s.rowsReaped]));
		expect(bySummary.skills).toBe(4);
		expect(bySummary.dreaming_state).toBe(2);
	});

	it("each table resolves the key column its REAL writer keys the version chain by", () => {
		// Each entry is pinned to the column the table's REAL writer keys its version chain by —
		// the column whose value is SHARED across a version chain and on which the writer resolves
		// "current state" via `ORDER BY version DESC LIMIT 1`. A WRONG key column here is a SAFETY
		// bug, not a no-op: keying by a per-version-UNIQUE column makes "highest version per key"
		// resolve to a singleton (compaction silently does nothing), and keying by a column that is
		// EMPTY/shared across distinct logical entities collapses them into one bogus chain. The
		// `WRITER_KEYED_BY` table below is the durable regression guard; this case is the
		// human-readable summary.
		//   - skills               → id        (product/api.ts:151 buildHighestVersionSql("skills","id"); NO `key` col on skills)
		//   - rules                → key       (product/api.ts:164 buildHighestVersionSql("rules","key"))
		//   - entity_attributes    → claim_key (ontology/supersede.ts:437 buildHighestActiveVersionSql(claimKey); `id` is unique-per-version)
		//   - epistemic_assertions → id        (ontology/control-plane.ts:482-483 appendVersionBumped({keyColumn:"id"}); `claim_key` is an OPTIONAL cross-link `?? ""`)
		//   - dreaming_state       → id        (dreaming/trigger.ts:285 appendVersionBumped({keyColumn:"id"}); deterministic per-scope id)
		expect(COMPACTABLE_KEY_COLUMNS.skills).toBe("id");
		expect(COMPACTABLE_KEY_COLUMNS.rules).toBe("key");
		expect(keyColumnFor("entity_attributes")).toBe("claim_key");
		expect(keyColumnFor("epistemic_assertions")).toBe("id");
		expect(keyColumnFor("dreaming_state")).toBe("id");
		// An unknown table defaults to `id` (conservative).
		expect(keyColumnFor("unknown_table")).toBe("id");
	});

	/**
	 * REGRESSION GUARD (the durable fix for the "silent no-op key-column" class).
	 *
	 * Each row pins a compactable table to the EXACT key column its REAL writer keys the version
	 * chain by, with the writer's `file:line` cited inline. This is a TABLE-DRIVEN test that
	 * asserts the EXACT contents of `COMPACTABLE_KEY_COLUMNS` — both that every entry matches its
	 * writer AND that the map has no extra/missing entries. A future drift (or a false-analogy
	 * "fix" like the original `epistemic_assertions: "claim_key"` bug, which keyed compaction by an
	 * optional cross-link that defaults to `""` and would collapse distinct assertions into one
	 * bogus chain) FAILS this unit suite instead of silently no-opping / bogus-collapsing in
	 * production. If you change `COMPACTABLE_KEY_COLUMNS`, you MUST update the writer citation here
	 * to the new source of truth — that is the point of the guard.
	 */
	const WRITER_KEYED_BY: ReadonlyArray<{ table: string; keyColumn: string; writer: string }> = [
		{ table: "skills", keyColumn: "id", writer: "src/daemon/runtime/product/api.ts:151 — buildHighestVersionSql(\"skills\", \"id\", …); there is NO `key` column on skills" },
		{ table: "rules", keyColumn: "key", writer: "src/daemon/runtime/product/api.ts:164 — buildHighestVersionSql(\"rules\", \"key\", …); the rule's logical `key` column" },
		{ table: "entity_attributes", keyColumn: "claim_key", writer: "src/daemon/runtime/ontology/supersede.ts:437 — buildHighestActiveVersionSql(claimKey); `id` is UNIQUE PER VERSION" },
		{ table: "epistemic_assertions", keyColumn: "id", writer: "src/daemon/runtime/ontology/control-plane.ts:482-483 — appendVersionBumped({ keyColumn: \"id\", keyValue: assertionKey() }); `claim_key` is an OPTIONAL cross-link (`assertion.claimKey ?? \"\"`), NOT a chain key" },
		{ table: "dreaming_state", keyColumn: "id", writer: "src/daemon/runtime/dreaming/trigger.ts:285 — appendVersionBumped({ keyColumn: \"id\", keyValue: state.id }); the deterministic per-scope id" },
	];

	it.each(WRITER_KEYED_BY)(
		"COMPACTABLE_KEY_COLUMNS pins $table to its writer's key column ($keyColumn)",
		({ table, keyColumn, writer }) => {
			// The map MUST key `table` by exactly the column its REAL writer keys the chain by.
			// `writer` names the source-of-truth file:line — when this fails, go read it and either
			// fix the map or fix this row, never just flip the expected value to make it pass.
			expect(COMPACTABLE_KEY_COLUMNS[table], `writer of record: ${writer}`).toBe(keyColumn);
			// And `keyColumnFor` (the resolver the handler actually calls) must agree with the map.
			expect(keyColumnFor(table)).toBe(keyColumn);
		},
	);

	it("COMPACTABLE_KEY_COLUMNS has EXACTLY the writer-verified entries — no drift, no extras", () => {
		// Lock the whole map: a new compactable table added without a verified writer citation,
		// or a stray entry, FAILS here. (The handler also reaches every member of the allow-list
		// `COMPACTABLE_VERSION_BUMPED_TABLES`; tables in that set but absent here intentionally
		// default to `id` via `keyColumnFor` — but each table that DOES carry a non-`id` key must
		// be pinned + cited above.)
		const expected = Object.fromEntries(WRITER_KEYED_BY.map((r) => [r.table, r.keyColumn]));
		expect({ ...COMPACTABLE_KEY_COLUMNS }).toEqual(expected);
		// Every map key is a real version-bumped allow-list member (no typo'd table name).
		for (const table of Object.keys(COMPACTABLE_KEY_COLUMNS)) {
			expect(COMPACTABLE_VERSION_BUMPED_TABLES.has(table), `${table} must be in the version-bumped allow-list`).toBe(true);
		}
	});

	it("a table that does NOT exist is SKIPPED — no compactor call, no 500", async () => {
		// Only `skills` exists; the rest are not-yet-created.
		const { seam, calls } = recordingCompactor({ reaped: { skills: 1 } });
		const daemon = daemonWithCompactor(seam, presence(new Set(["skills"])));

		const { status, out } = await postCompact(daemon);

		expect(status).toBe(200); // NOT a 500 — a missing table is skipped, not fatal.
		// The compactor ran ONLY on the table that exists.
		expect(calls.map((c) => c.table)).toEqual(["skills"]);
		// The absent tables are reported in skippedTables, not as errors.
		for (const t of COMPACTABLE_VERSION_BUMPED_TABLES) {
			if (t !== "skills") expect(out.skippedTables).toContain(t);
		}
	});

	it("a transient probe failure (null) FAILS OPEN — the compactor still runs", async () => {
		const { seam, calls } = recordingCompactor({ reaped: { skills: 1 } });
		// Probe returns null for every table (transient catalog blip) → fail open → compact all.
		const daemon = daemonWithCompactor(seam, async () => null);

		const { status, out } = await postCompact(daemon);

		expect(status).toBe(200);
		expect(calls.length).toBe(COMPACTABLE_VERSION_BUMPED_TABLES.size);
		expect(out.skippedTables).toHaveLength(0);
	});

	it("--table <name> (body {table}) narrows the pass to one allow-listed table", async () => {
		const present = new Set(COMPACTABLE_VERSION_BUMPED_TABLES);
		const { seam, calls } = recordingCompactor({ reaped: { rules: 3 } });
		const daemon = daemonWithCompactor(seam, presence(present));

		const { status, out } = await postCompact(daemon, { table: "rules" });

		expect(status).toBe(200);
		expect(calls.map((c) => c.table)).toEqual(["rules"]);
		expect(out.summaries.map((s) => s.table)).toEqual(["rules"]);
	});

	it("an unknown / non-compactable --table compacts NOTHING (fail-closed selector)", async () => {
		const { seam, calls } = recordingCompactor();
		const daemon = daemonWithCompactor(seam, presence(new Set(COMPACTABLE_VERSION_BUMPED_TABLES)));

		// `sessions` is append-only, not in the version-bumped allow-list.
		const { status, out } = await postCompact(daemon, { table: "sessions" });

		expect(status).toBe(200);
		expect(calls).toHaveLength(0);
		expect(out.summaries).toHaveLength(0);
	});

	it("a per-table compaction error is FAIL-SOFT (folded into `errored`), never a 500", async () => {
		const present = new Set(COMPACTABLE_VERSION_BUMPED_TABLES);
		// `skills` throws; the rest succeed. The pass must complete with skills.errored=1.
		const { seam } = recordingCompactor({ reaped: { rules: 2 }, error: "skills" });
		const daemon = daemonWithCompactor(seam, presence(present));

		const { status, out } = await postCompact(daemon);

		expect(status).toBe(200); // one table erroring never 500s the request.
		expect(out.ok).toBe(true);
		const skills = out.summaries.find((s) => s.table === "skills");
		expect(skills?.errored).toBe(1);
		expect(skills?.rowsReaped).toBe(0);
		// The other tables still completed.
		expect(out.summaries.find((s) => s.table === "rules")?.rowsReaped).toBe(2);
	});
});

describe("PRD-030 D-2 / security: fail-closed edge + no secret in the summary", () => {
	it("a request with NO resolvable org fails closed at the edge (400)", async () => {
		const { seam, calls } = recordingCompactor();
		// Team mode + a malformed default scope (empty org) → no tenant resolvable → 400/401/403.
		const daemon = createDaemon({ config: cfg({ mode: "team" }), storage: fakeStorage as never, logger: createRequestLogger({ silent: true }) });
		mountCompactApi(daemon, { storage: fakeStorage, defaultScope: { org: "" }, compactor: seam, exists: presence(new Set(COMPACTABLE_VERSION_BUMPED_TABLES)), retention: RETENTION });

		const res = await daemon.app.request("/api/diagnostics/compact", { method: "POST" });
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(200);
		// The compactor was NOT run on a fail-closed request.
		expect(calls).toHaveLength(0);
	});

	it("the summary body carries NO token/secret/header value (grep-proven)", async () => {
		const present = new Set(COMPACTABLE_VERSION_BUMPED_TABLES);
		const { seam } = recordingCompactor({ reaped: { skills: 1 }, skipped: { rules: 1 } });
		const daemon = daemonWithCompactor(seam, presence(present));

		const res = await daemon.app.request("/api/diagnostics/compact", { method: "POST" });
		const raw = await res.text();
		expect(raw).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
		// The body is just counts + table names + the ok bit.
		const out = JSON.parse(raw) as CompactSummaryBody;
		expect(out.ok).toBe(true);
		expect(Array.isArray(out.summaries)).toBe(true);
	});
});

describe("PRD-030 D-2 — mounting is fail-safe", () => {
	it("mountCompactApi is a no-op when the /api/diagnostics group is not mounted (unknown daemon shape)", () => {
		const stub = { group: () => undefined, config: cfg() } as unknown as Daemon;
		const { seam } = recordingCompactor();
		expect(() =>
			mountCompactApi(stub, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, compactor: seam, exists: presence(new Set()), retention: RETENTION }),
		).not.toThrow();
	});

	it("a GET to the compact path is NOT the trigger (POST only)", async () => {
		const { seam } = recordingCompactor();
		const daemon = daemonWithCompactor(seam, presence(new Set(COMPACTABLE_VERSION_BUMPED_TABLES)));
		const res = await daemon.app.request("/api/diagnostics/compact", { method: "GET" });
		expect(res.status).not.toBe(200);
	});
});
