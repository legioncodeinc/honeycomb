/**
 * PRD-080a — the durable controlled-write outbox (a-AC-1 .. a-AC-7).
 *
 * Two verification layers:
 *   1. STAGE GATE (applyControlledWrite over a stub StorageQuery + an in-memory outbox) — a-AC-1/a-AC-2/
 *      a-AC-6: a TRANSIENT commit failure at EITHER the dedup-probe OR the INSERT branch routes the
 *      resolved write to the outbox and returns `deferred` (no throw); a GENUINE failure still throws
 *      (never enqueued); a throwing/absent outbox degrades cleanly to the pre-080 throw.
 *   2. OUTBOX UNIT (in-memory / temp-dir `node:sqlite`, injected clock, stub storage) — a-AC-3/a-AC-4/
 *      a-AC-5/a-AC-7: the drainer re-executes the commit (idempotent dedup replay → no duplicate INSERT),
 *      bounded backoff + due-skipping, persist-across-restart, secret-free events + health shape.
 *
 * `vitest run` passes `--experimental-sqlite` to the worker (vitest.config.ts), so `node:sqlite` is live.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	applyControlledWrite,
	type ControlledWriteHandlerDeps,
	type ControlledWriteInput,
	type ResolvedControlledWrite,
} from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import {
	type MemoryOutboxSink,
	type OutboxClock,
	openMemoryOutbox,
} from "../../../../src/daemon/runtime/pipeline/memory-outbox.js";
import { buildHealthDetail } from "../../../../src/daemon/runtime/health.js";
import { createMemoryFormationTracker } from "../../../../src/daemon/runtime/pipeline/memory-formation.js";
import { PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import type { Proposal } from "../../../../src/daemon/runtime/pipeline/contracts.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	LOCAL_QUEUE_DAEMON_DIR_NAME,
	LOCAL_QUEUE_DB_FILE_NAME,
} from "../../../../src/daemon/runtime/services/local-job-queue.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { connectionError, ok, type QueryResult, queryError, timeoutResult } from "../../../../src/daemon/storage/result.js";
import { type RowValues, val } from "../../../../src/daemon/storage/writes.js";

// ── shared fixtures ──────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "org-1", workspace: "ws-1" };

/** Is this SQL the dedup probe (`content_hash = ...`)? */
function isDedupProbe(sql: string): boolean {
	return /content_hash\s*=/.test(sql);
}
/** Is this SQL the version-read SELECT? */
function isVersionRead(sql: string): boolean {
	return /SELECT\s+version\b/i.test(sql) && /ORDER\s+BY\s+version/i.test(sql);
}
/** Is this SQL the memories INSERT? */
function isInsert(sql: string): boolean {
	return /INSERT\s+INTO\s+"memories"/i.test(sql);
}

/** A recorded structured event (name + fields) so a test can assert the secret-free `memory.outbox.*` shape. */
interface RecordedEvent {
	readonly name: string;
	readonly fields: Readonly<Record<string, unknown>>;
}
function recordingLogger(): {
	logger: { event(name: string, fields?: Readonly<Record<string, unknown>>): void };
	events: RecordedEvent[];
} {
	const events: RecordedEvent[] = [];
	return {
		logger: {
			event(name: string, fields: Readonly<Record<string, unknown>> = {}): void {
				events.push({ name, fields });
			},
		},
		events,
	};
}

/** A controllable clock + interval seam so the drainer never sleeps for real (mirrors capture-outbox.test). */
function fakeClock(startMs: number): OutboxClock & { advance(ms: number): void } {
	let nowMs = startMs;
	return {
		now: () => nowMs,
		setInterval: () => 1,
		clearInterval: () => {},
		advance(ms: number): void {
			nowMs += ms;
		},
	};
}

/** A no-op embed client (null vector → the row writes `content_embedding` NULL, exactly the disabled path). */
const nullEmbed: EmbedClient = {
	async embed(): Promise<readonly number[] | null> {
		return null;
	},
};

/** Build controlled-write deps over a stub storage + an optional injected outbox. */
function deps(storage: StorageQuery, over: Partial<ControlledWriteHandlerDeps> = {}): ControlledWriteHandlerDeps {
	return {
		storage,
		config: PipelineConfigSchema.parse({}),
		embed: nullEmbed,
		now: () => new Date("2026-07-11T00:00:00.000Z"),
		newId: () => "mem_deferred_1",
		...over,
	};
}

function addProposal(over: Partial<Proposal> = {}): Proposal {
	return { action: "add", confidence: 0.9, reason: "", ...over };
}
function addInput(over: Partial<ControlledWriteInput> = {}): ControlledWriteInput {
	return {
		proposal: addProposal(),
		content: "distilled fact body",
		normalizedContent: "distilled fact body",
		factConfidence: 0.9,
		...over,
	};
}

/** A stub StorageQuery whose dedup / version-read / insert outcomes are each injectable (no retry layer). */
function stubStorage(handlers: {
	dedup?: () => QueryResult;
	version?: () => QueryResult;
	insert?: () => QueryResult;
}): { storage: StorageQuery; state: { dedupProbes: number; versionReads: number; inserts: number } } {
	const state = { dedupProbes: 0, versionReads: 0, inserts: 0 };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isDedupProbe(sql)) {
				state.dedupProbes += 1;
				return (handlers.dedup ?? (() => ok([], 1)))();
			}
			if (isVersionRead(sql)) {
				state.versionReads += 1;
				return (handlers.version ?? (() => ok([], 1)))();
			}
			if (isInsert(sql)) {
				state.inserts += 1;
				return (handlers.insert ?? (() => ok([], 1)))();
			}
			return ok([], 1);
		},
	};
	return { storage, state };
}

/** A stub WRITE client for the DRAINER whose commit outcome is switchable (fail / ok / already-landed). */
function driverStorage(): {
	storage: StorageQuery;
	setMode(m: "fail" | "ok" | "landed"): void;
	get inserts(): number;
} {
	const st = { mode: "fail" as "fail" | "ok" | "landed", inserts: 0 };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isDedupProbe(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000); // transient → the commit defers/retries
				if (st.mode === "landed") return ok([{ id: "already-there" }], 1); // dedup HIT → deduped, no INSERT
				return ok([], 1); // ok, no rows → proceed to the INSERT
			}
			if (isVersionRead(sql)) return ok([], 1); // version 0 → the append bumps to 1
			if (isInsert(sql)) {
				st.inserts += 1;
				return st.mode === "ok" ? ok([], 1) : timeoutResult(10_000);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		setMode: (m) => {
			st.mode = m;
		},
		get inserts() {
			return st.inserts;
		},
	};
}

/** Build a `memories` RowValues carrying its deterministic `id` + `content_hash` (as `buildMemoryRow` does). */
function memRow(id: string, hash: string, content = "a distilled fact"): RowValues {
	return [
		["id", val.str(id)],
		["type", val.str("fact")],
		["content", val.text(content)],
		["content_hash", val.str(hash)],
		["is_deleted", val.num(0)],
		["agent_id", val.str("default")],
		["created_at", val.str("2026-07-11T00:00:00.000Z")],
		["updated_at", val.str("2026-07-11T00:00:00.000Z")],
	];
}
function addWrite(id: string, hash: string, scope: QueryScope = SCOPE, content?: string): ResolvedControlledWrite {
	return { action: "add", keyId: id, row: memRow(id, hash, content), scope };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-memory-outbox-"));
});
afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort temp cleanup
	}
});

// ── a-AC-1: a TRANSIENT failure at BOTH branches → enqueue + deferred, no throw ──

describe("a-AC-1: a transient controlled-write failure routes to the outbox and returns `deferred`", () => {
	it("BRANCH A (dedup probe transient) enqueues the resolved write and defers instead of throwing", async () => {
		const { storage, state } = stubStorage({ dedup: () => queryError("service unavailable", 503) });
		const outbox = openMemoryOutbox({ storage, memory: true });
		const out = await applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: outbox }));

		expect(out.action).toBe("deferred");
		expect(out.memoryId).toBe("mem_deferred_1");
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 0, deadLettered: 0 });
		// A transient dedup-probe failure never reaches the INSERT (no unguarded write).
		expect(state.inserts).toBe(0);
		outbox.close();
	});

	it("BRANCH B (version-bumped INSERT transient) enqueues the resolved write and defers", async () => {
		// The dedup probe is clean (no dup), the version read is clean, the INSERT flaps transiently (503).
		const { storage } = stubStorage({ insert: () => queryError("service unavailable", 503) });
		const outbox = openMemoryOutbox({ storage, memory: true });
		const out = await applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: outbox }));

		expect(out.action).toBe("deferred");
		expect(out.memoryId).toBe("mem_deferred_1");
		expect(outbox.counts().pending).toBe(1);
		outbox.close();
	});

	it("a transient UPDATE (version-bump) also defers to the outbox", async () => {
		const { storage } = stubStorage({ insert: () => connectionError("ECONNRESET") });
		const outbox = openMemoryOutbox({ storage, memory: true });
		const out = await applyControlledWrite(
			addInput({ proposal: { action: "update", targetId: "target-1", confidence: 0.9, reason: "now changed" } }),
			SCOPE,
			deps(storage, {
				memoryOutbox: outbox,
				config: PipelineConfigSchema.parse({ autonomous: { allowUpdateDelete: true } }),
			}),
		);
		expect(out.action).toBe("deferred");
		expect(out.memoryId).toBe("target-1");
		expect(outbox.counts().pending).toBe(1);
		outbox.close();
	});
});

// ── a-AC-2: a GENUINE failure still throws — never enqueued ──────────────────────

describe("a-AC-2: a genuine (non-transient) failure still throws and never enqueues", () => {
	it("a permission-denied dedup probe throws exactly as pre-080 and leaves the outbox empty", async () => {
		const { storage, state } = stubStorage({ dedup: () => queryError("permission denied for relation memories", 403) });
		const outbox = openMemoryOutbox({ storage, memory: true });
		await expect(applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: outbox }))).rejects.toThrow(
			/controlled-write dedup probe failed/,
		);
		// The safety invariant: never enqueued, never a deferred ack, never an unguarded duplicate insert.
		expect(outbox.counts().pending).toBe(0);
		expect(state.inserts).toBe(0);
		outbox.close();
	});

	it("a genuine INSERT failure (400 syntax) throws and never enqueues", async () => {
		const { storage } = stubStorage({ insert: () => queryError("syntax error at or near", 400) });
		const outbox = openMemoryOutbox({ storage, memory: true });
		await expect(applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: outbox }))).rejects.toThrow(
			/controlled-write insert failed/,
		);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});

// ── a-AC-3: the drainer re-executes the commit; fail→recover drains; landed replay dedups ─

describe("a-AC-3: the drainer re-executes the commit (idempotent replay, no duplicate INSERT)", () => {
	it("a fail-then-recover backlog drains to empty across two ticks", async () => {
		const driver = driverStorage(); // starts in fail mode
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: driver.storage, memory: true, clock });
		outbox.enqueue(addWrite("mem-a", "hash-a"));
		expect(outbox.counts().pending).toBe(1);

		// Tick 1: still degraded → the re-commit fails transiently, the row stays, attempts bumps.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 1, deadLettered: 0 });

		// The backend recovers; advance past the backoff so the row is due, then drain → committed + deleted.
		driver.setMode("ok");
		clock.advance(10 * 60 * 1000);
		expect(await outbox.drainDue()).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 0 });
		outbox.close();
	});

	it("replay of an ALREADY-LANDED row is deduped → NO duplicate INSERT", async () => {
		const driver = driverStorage();
		driver.setMode("landed"); // the dedup probe finds the memory a prior attempt already committed
		const outbox = openMemoryOutbox({ storage: driver.storage, memory: true });
		outbox.enqueue(addWrite("mem-landed", "hash-landed"));

		// The drainer re-runs the dedup probe → deduped → deletes the row, and issues NO INSERT (idempotent).
		expect(await outbox.drainDue()).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(driver.inserts, "an already-landed replay never inserts a duplicate").toBe(0);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});

// ── a-AC-4: bounded backoff grows; a not-yet-due row is skipped ───────────────────

describe("a-AC-4: bounded exponential backoff; not-yet-due rows are skipped (no hot-loop)", () => {
	it("next_attempt_at grows per failed attempt and a future row is not attempted", async () => {
		const driver = driverStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			clock,
			backoff: { baseMs: 1_000, capMs: 60_000 },
		});
		outbox.enqueue(addWrite("mem-b", "hash-b"));

		// Attempt 1 fails → next_attempt_at pushed out ~base (1s). An immediate second pass is a NO-OP (not due).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		expect(await outbox.drainDue(), "not yet due → skipped").toEqual({ drained: 0, retried: 0, deadLettered: 0 });

		// Advance past attempt-1 backoff (1s) → due → attempt 2 fails, pushes out ~2s (grows).
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		// 1s later is NOT enough for the attempt-2 (2s) backoff → still skipped (the delay grew).
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		// One more second (2s total since attempt 2) → due again.
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		outbox.close();
	});
});

// ── a-AC-5: persist across close / reopen, drain on the next boot ─────────────────

describe("a-AC-5: queued writes survive a stop/start and drain on the next boot", () => {
	it("enqueue, close, reopen the SAME home-anchored db, and drain the persisted row", async () => {
		const driver = driverStorage();
		const first = openMemoryOutbox({ storage: driver.storage, baseDir: dir });
		first.enqueue(addWrite("persist-me", "hash-persist"));
		expect(first.counts().pending).toBe(1);
		first.close();

		// The db lives at the SAME home-anchored path the local queue + capture outbox use (D-1/D-6).
		expect(existsSync(join(dir, LOCAL_QUEUE_DAEMON_DIR_NAME, LOCAL_QUEUE_DB_FILE_NAME))).toBe(true);

		// Reopen: the persisted row is still queued, and drains once the backend is up.
		driver.setMode("ok");
		const second = openMemoryOutbox({ storage: driver.storage, baseDir: dir });
		expect(second.counts().pending).toBe(1);
		expect(await second.drainDue()).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(second.counts().pending).toBe(0);
		second.close();
	});
});

// ── a-AC-6: fail-soft — a throwing/absent outbox degrades to the pre-080 throw ────

describe("a-AC-6: an outbox fault degrades cleanly to the pre-080 throw (no dangling rejection)", () => {
	it("a throwing outbox stub makes the stage fall back to the pre-080 throw, escaping no rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const throwingOutbox: MemoryOutboxSink = {
				enqueue(): never {
					throw new Error("disk full");
				},
			};
			const { storage } = stubStorage({ dedup: () => timeoutResult(10_000) }); // transient → would defer
			// The enqueue THROWS → deferOrThrow catches it and falls back to the pre-080 throw (never lost).
			await expect(
				applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: throwingOutbox })),
			).rejects.toThrow(/controlled-write dedup probe failed/);
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled, "NO unhandled rejection escaped").toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("with NO outbox wired a transient failure throws exactly as pre-080 (byte-for-byte)", async () => {
		const { storage } = stubStorage({ dedup: () => connectionError("ECONNREFUSED") });
		await expect(applyControlledWrite(addInput(), SCOPE, deps(storage))).rejects.toThrow(
			/controlled-write dedup probe failed/,
		);
	});

	it("openMemoryOutbox degrades to an inert no-op when the substrate cannot open (untrusted baseDir)", () => {
		const { storage } = stubStorage({});
		const outbox = openMemoryOutbox({ storage, baseDir: "/definitely/not/trusted" });
		// The inert no-op reports nothing persisted → the stage falls back to the pre-080 throw.
		expect(outbox.enqueue(addWrite("x", "hash-x"))).toEqual({ enqueued: 0, dropped: 1 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 0 });
		outbox.close();
	});

	it("a throwing WRITE client in the drainer degrades to a normal backoff, escaping no rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const rejecting: StorageQuery = {
				async query(sql: string): Promise<QueryResult> {
					if (isDedupProbe(sql)) throw new Error("commit rejected (degraded window)");
					return ok([], 1);
				},
			};
			const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
			const outbox = openMemoryOutbox({ storage: rejecting, memory: true, clock, backoff: { baseMs: 1_000, capMs: 60_000 } });
			outbox.enqueue(addWrite("mem-throw", "hash-throw"));
			// The throwing commit is a normal failed attempt (backoff), never a pass abort / rejection.
			await expect(outbox.drainDue()).resolves.toEqual({ drained: 0, retried: 1, deadLettered: 0 });
			expect(outbox.counts()).toEqual({ pending: 1, retrying: 1, deadLettered: 0 });
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled, "no unhandled rejection escaped").toEqual([]);
			outbox.close();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

// ── a-AC-7: observability — health shape + secret-free events ─────────────────────

describe("a-AC-7: observability is secret-free (health shape + events carry no content/hash/scope)", () => {
	it("counts() reports { pending, retrying } and the drainer events carry no content/hash/scope", async () => {
		const driver = driverStorage(); // fail first, recover second
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openMemoryOutbox({ storage: driver.storage, memory: true, clock, logger });
		outbox.enqueue(addWrite("secret-id", "secret-hash-abc", { org: "sekret-org", workspace: "sekret-ws" }, "secret-content-here"));

		// Health shape: exactly the two counts.
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 0, deadLettered: 0 });

		// Tick 1 fails → a `retry` event; recover + advance → a `drained` event.
		await outbox.drainDue();
		driver.setMode("ok");
		clock.advance(10 * 60 * 1000);
		await outbox.drainDue();

		const names = events.map((e) => e.name);
		expect(names).toContain("memory.outbox.enqueued");
		expect(names).toContain("memory.outbox.retry");
		expect(names).toContain("memory.outbox.drained");

		// No event field may carry memory content, a content_hash, an org, or a workspace (secret-free — a-AC-7).
		for (const e of events) {
			const blob = JSON.stringify(e.fields);
			expect(blob, `${e.name} leaks content`).not.toContain("secret-content-here");
			expect(blob, `${e.name} leaks hash`).not.toContain("secret-hash-abc");
			expect(blob, `${e.name} leaks org`).not.toContain("sekret-org");
			expect(blob, `${e.name} leaks workspace`).not.toContain("sekret-ws");
		}
		// Allow-listed keys only: counts / durations / attempt / reason.
		const allowed = new Set(["count", "durationMs", "attempt", "reason"]);
		for (const e of events) {
			for (const key of Object.keys(e.fields)) {
				expect(allowed.has(key), `${e.name}.${key} is not an allow-listed field`).toBe(true);
			}
		}
		outbox.close();
	});

	it("/health surfaces reasons.memoryOutbox { pending, retrying }, normalized to non-negative ints", () => {
		const detail = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: false,
			// A negative/fractional input is clamped so /health never emits a fractional or negative count.
			memoryOutbox: { pending: 3, retrying: -2 },
		});
		expect(detail.reasons?.memoryOutbox).toEqual({ pending: 3, retrying: 0, deadLettered: 0 });
	});

	it("/health omits memoryOutbox when the outbox is not wired", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: false });
		expect(detail.reasons?.memoryOutbox).toBeUndefined();
	});
});

// ── b-AC-1: a permanently-failing write dead-letters (maxAttempts / maxAgeMs) and is not re-leased ─

describe("b-AC-1: a permanently-failing write dead-letters and stops being leased", () => {
	it("dead-letters after maxAttempts failed re-commits, then is never re-leased", async () => {
		const driver = driverStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			clock,
			backoff: { baseMs: 1, capMs: 1 },
			maxAttempts: 3,
		});
		outbox.enqueue(addWrite("mem-dead", "hash-dead"));

		// Attempts 1 + 2 fail → retried (attempt < maxAttempts). Advance past the 1ms backoff each pass.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		clock.advance(10);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		clock.advance(10);
		// Attempt 3 fails → attempt (3) >= maxAttempts (3) → terminal `dead`.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });

		// A `dead` row is RETAINED but NEVER re-leased: a further pass (even far in the future) is a no-op.
		clock.advance(10_000_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		expect(outbox.counts().deadLettered, "the dead row is retained, not deleted").toBe(1);
		outbox.close();
	});

	it("dead-letters after maxAgeMs is exceeded, even well before maxAttempts", async () => {
		const driver = driverStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			clock,
			backoff: { baseMs: 1, capMs: 1 },
			maxAttempts: 1_000, // attempts will never trip; only age does.
			maxAgeMs: 60_000,
		});
		outbox.enqueue(addWrite("mem-old", "hash-old"));

		// First failed attempt while the row is young → retried (age 0 < maxAgeMs).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		// Age the row past maxAgeMs → the next failed attempt dead-letters despite attempts ≪ maxAttempts.
		clock.advance(120_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		expect(outbox.counts().deadLettered).toBe(1);
		outbox.close();
	});
});

// ── b-AC-2: dead-letter observability — secret-free event + counts partition + /health deadLettered ─

describe("b-AC-2: dead-letter observability is secret-free (event + counts partition + /health)", () => {
	it("emits a secret-free memory.outbox.dead_lettered { attempt, ageMs, count } and partitions counts", async () => {
		const driver = driverStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			clock,
			logger,
			backoff: { baseMs: 1, capMs: 1 },
			maxAttempts: 1, // the FIRST failed attempt dead-letters immediately (attempt 1 >= 1).
		});
		outbox.enqueue(
			addWrite("dead-id", "dead-hash-xyz", { org: "sekret-org", workspace: "sekret-ws" }, "secret-dead-content"),
		);

		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		// counts partition (b-AC-2): a `dead` row is EXCLUDED from pending/retrying, counted only as deadLettered.
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });

		const dead = events.find((e) => e.name === "memory.outbox.dead_lettered");
		expect(dead, "a dead_lettered event fired").toBeDefined();
		// Allow-listed keys ONLY — attempt / ageMs / count, never content/hash/org/workspace.
		expect(Object.keys(dead!.fields).sort()).toEqual(["ageMs", "attempt", "count"]);
		const blob = JSON.stringify(dead!.fields);
		expect(blob, "no memory content").not.toContain("secret-dead-content");
		expect(blob, "no content_hash").not.toContain("dead-hash-xyz");
		expect(blob, "no org").not.toContain("sekret-org");
		expect(blob, "no workspace").not.toContain("sekret-ws");
		outbox.close();
	});

	it("/health surfaces reasons.memoryOutbox.deadLettered, normalized to a non-negative int", () => {
		const detail = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: false,
			// A negative/fractional deadLettered is clamped so /health never emits a fractional or negative count.
			memoryOutbox: { pending: 1, retrying: 1, deadLettered: -4 },
		});
		expect(detail.reasons?.memoryOutbox).toEqual({ pending: 1, retrying: 1, deadLettered: 0 });
	});

	it("/health emits deadLettered even when a legacy caller omits it (defaults to 0)", () => {
		const detail = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: false,
			memoryOutbox: { pending: 2, retrying: 0 },
		});
		expect(detail.reasons?.memoryOutbox).toEqual({ pending: 2, retrying: 0, deadLettered: 0 });
	});
});

// ── b-AC-3: a landing controlled-write kicks an immediate drain (recovery kick) ───────────────────

describe("b-AC-3: a successful pipeline commit kicks an immediate outbox drain", () => {
	it("a landing controlled-write clears a queued row via the kick, without the 30s interval", async () => {
		const driver = driverStorage();
		driver.setMode("ok"); // the backend has recovered.
		const outbox = openMemoryOutbox({ storage: driver.storage, memory: true });
		// A row is already queued from an earlier degraded window.
		outbox.enqueue(addWrite("queued-1", "hash-queued-1"));
		expect(outbox.counts().pending).toBe(1);

		// A NEW controlled-write LANDS on the recovered backend → its success kicks an immediate drain.
		// The drainer interval was NEVER started, so the ONLY thing that can clear the queued row is the kick.
		const out = await applyControlledWrite(
			addInput({ content: "fresh landing fact", normalizedContent: "fresh landing fact" }),
			SCOPE,
			deps(driver.storage, { memoryOutbox: outbox, newId: () => "mem_fresh_1" }),
		);
		expect(out.action).toBe("inserted");

		// Let the fire-and-forget kick's single drain pass settle, then assert the backlog cleared.
		await new Promise((r) => setTimeout(r, 0));
		expect(outbox.counts().pending, "the queued row cleared via the recovery kick, not the interval").toBe(0);
		outbox.close();
	});

	it("a successful commit calls the outbox sink's kick (the recovery signal is wired)", async () => {
		let kicks = 0;
		const recordingSink: MemoryOutboxSink = {
			enqueue: () => ({ enqueued: 1, dropped: 0 }),
			kick: () => {
				kicks += 1;
			},
		};
		const { storage } = stubStorage({}); // all-ok → inserted
		const out = await applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: recordingSink }));
		expect(out.action).toBe("inserted");
		expect(kicks, "a landed commit kicks the outbox drain").toBe(1);
	});
});

// ── b-AC-5: fail-soft + non-regression — the kick/dead-letter never break the pipeline ────────────

describe("b-AC-5: the recovery kick is fail-soft and never breaks a committed write", () => {
	it("a throwing kick sink never breaks the committed write (the outcome is unaffected)", async () => {
		const throwingKickSink: MemoryOutboxSink = {
			enqueue: () => ({ enqueued: 1, dropped: 0 }),
			kick: () => {
				throw new Error("kick boom");
			},
		};
		const { storage, state } = stubStorage({}); // all-ok → inserted
		const out = await applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: throwingKickSink }));
		// The kick fault is swallowed secret-free — the commit still reports `inserted` (non-regression).
		expect(out.action).toBe("inserted");
		expect(state.inserts, "the write still committed exactly once").toBe(1);
	});

	it("a sink with NO kick implemented (pre-080b stub) commits exactly as 080a", async () => {
		const noKickSink: MemoryOutboxSink = { enqueue: () => ({ enqueued: 1, dropped: 0 }) };
		const { storage } = stubStorage({}); // all-ok → inserted
		const out = await applyControlledWrite(addInput(), SCOPE, deps(storage, { memoryOutbox: noKickSink }));
		expect(out.action).toBe("inserted"); // the optional `kick?` is a no-op when absent — byte-for-byte 080a.
	});
});

// ── PRD-080c fixtures — a COALESCE-aware WRITE stub (batched `IN` probe + multi-row `INSERT`) ─────────

/** Does this SQL carry the BATCHED dedup probe (`content_hash IN (...)`)? */
function isBatchProbe(sql: string): boolean {
	return /content_hash\s+IN\s*\(/i.test(sql);
}

/**
 * A WRITE stub for the c-AC-2 coalesced drainer: it recognizes BOTH the batched `content_hash IN (…)` probe
 * and the per-row `content_hash = …` probe, the multi-row / single INSERT, and the version read — and lets
 * a test switch the probe outcome (ok / transient-fail / reject) and the insert outcome (ok / transient-fail)
 * plus seed the set of ALREADY-LANDED hashes (a dedup hit → no re-insert). Records the SQL of every INSERT so
 * a test can assert which rows a coalesced append actually wrote (no duplicate of an already-present hash).
 */
function coalesceStorage(): {
	storage: StorageQuery;
	present: Set<string>;
	setInsertMode(m: "ok" | "fail"): void;
	setProbeMode(m: "ok" | "fail" | "throw"): void;
	readonly state: { batchProbes: number; singleProbes: number; inserts: number; insertSql: string[] };
} {
	const present = new Set<string>();
	const cfg = { insert: "ok" as "ok" | "fail", probe: "ok" as "ok" | "fail" | "throw" };
	const state = { batchProbes: 0, singleProbes: 0, inserts: 0, insertSql: [] as string[] };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isBatchProbe(sql)) {
				state.batchProbes += 1;
				if (cfg.probe === "throw") throw new Error("batched probe rejected (degraded window)");
				if (cfg.probe === "fail") return timeoutResult(10_000);
				// Return the already-landed hashes that appear in this IN-list (a dedup HIT → no re-insert).
				return ok([...present].filter((h) => sql.includes(`'${h}'`)).map((h) => ({ content_hash: h })), 1);
			}
			if (isDedupProbe(sql)) {
				state.singleProbes += 1;
				if (cfg.probe === "throw") throw new Error("probe rejected");
				if (cfg.probe === "fail") return timeoutResult(10_000);
				const hit = [...present].find((h) => sql.includes(`'${h}'`));
				return hit === undefined ? ok([], 1) : ok([{ id: `existing-${hit}` }], 1);
			}
			if (isVersionRead(sql)) return ok([], 1);
			if (isInsert(sql)) {
				state.inserts += 1;
				state.insertSql.push(sql);
				if (cfg.insert !== "ok") return timeoutResult(10_000);
				// Keep the stub's dedup state in sync: a LANDED insert makes its content_hash(es) present, so a
				// later probe/replay of the same hash is correctly a dedup HIT (content_hash is a 64-hex SHA-256).
				for (const [, h] of sql.matchAll(/'([0-9a-f]{64})'/g)) present.add(h);
				return ok([], 1);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		present,
		setInsertMode: (m) => {
			cfg.insert = m;
		},
		setProbeMode: (m) => {
			cfg.probe = m;
		},
		state,
	};
}

/** A `memories` ADD row with a WIDER column shape (an extra `confidence` column) → a distinct group signature. */
function memRowWide(id: string, hash: string): RowValues {
	return [...memRow(id, hash), ["confidence", val.num(0.9)]];
}
function addWriteWide(id: string, hash: string): ResolvedControlledWrite {
	return { action: "add", keyId: id, row: memRowWide(id, hash), scope: SCOPE };
}

// ── c-AC-1: maxRows cap — oldest-first shed, counted, `dead` excluded ─────────────────────────────

describe("c-AC-1: an enqueue over maxRows sheds the oldest pending rows (counted, dead excluded)", () => {
	it("sheds the OLDEST pending rows oldest-first, bounds the backlog, logs the count", async () => {
		const co = coalesceStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true, clock, logger, maxRows: 3 });

		// Enqueue 5 rows, advancing the clock so each carries a DISTINCT (increasing) outbox created_at.
		for (let i = 1; i <= 5; i++) {
			outbox.enqueue(addWrite(`row-${i}`, `hash-${i}`));
			clock.advance(1_000);
		}

		// The ACTIVE backlog is bounded to maxRows; the two OLDEST (row-1, row-2) were shed.
		expect(outbox.counts().pending).toBe(3);
		const shedTotal = events.filter((e) => e.name === "memory.outbox.shed").reduce((n, e) => n + Number(e.fields.count), 0);
		expect(shedTotal, "exactly the 2 overflow rows were shed, never silently").toBe(2);

		// Drain the survivors (one coalesced append) and prove the OLDEST were the ones dropped.
		expect((await outbox.drainDue()).drained).toBe(3);
		const inserted = co.state.insertSql.join(" ");
		expect(inserted).not.toContain("'row-1'");
		expect(inserted).not.toContain("'row-2'");
		expect(inserted).toContain("'row-3'");
		expect(inserted).toContain("'row-5'");
		outbox.close();
	});

	it("terminal `dead` rows do NOT count toward the cap and are never shed", async () => {
		const co = coalesceStorage();
		co.setInsertMode("fail"); // the drain fails → the two rows dead-letter (maxAttempts 1).
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openMemoryOutbox({
			storage: co.storage,
			memory: true,
			clock,
			logger,
			maxRows: 2,
			maxAttempts: 1,
			backoff: { baseMs: 1, capMs: 1 },
		});

		// Two rows dead-letter (a failed coalesced append at maxAttempts 1).
		outbox.enqueue(addWrite("dead-1", "hash-dead-1"));
		clock.advance(1_000);
		outbox.enqueue(addWrite("dead-2", "hash-dead-2"));
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 2 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 2 });

		// Now push the PENDING backlog to exactly maxRows=2 — the 2 `dead` rows must NOT count toward the cap.
		co.setInsertMode("ok");
		clock.advance(1_000);
		outbox.enqueue(addWrite("keep-1", "hash-keep-1"));
		clock.advance(1_000);
		outbox.enqueue(addWrite("keep-2", "hash-keep-2"));
		expect(events.some((e) => e.name === "memory.outbox.shed"), "at cap, nothing shed yet").toBe(false);

		// One more pending row → over cap → shed the OLDEST pending (keep-1); the 2 dead rows are untouched.
		clock.advance(1_000);
		outbox.enqueue(addWrite("keep-3", "hash-keep-3"));
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 0, deadLettered: 2 });
		expect(events.some((e) => e.name === "memory.outbox.shed"), "a pending overflow was shed").toBe(true);
		outbox.close();
	});
});

// ── c-AC-2: coalesced drain preserves the content_hash dedup (no duplicate memories row) ───────────

describe("c-AC-2: due rows coalesce by scope+shape into one batched-dedup multi-row append", () => {
	it("coalesces same-scope same-shape ADDs, dedups an already-present member, inserts NO duplicate", async () => {
		const co = coalesceStorage();
		co.present.add("hash-co-2"); // a PRIOR attempt already landed co-2's fact — replay must dedup it.
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true });
		outbox.enqueue(addWrite("co-1", "hash-co-1"));
		outbox.enqueue(addWrite("co-2", "hash-co-2"));
		outbox.enqueue(addWrite("co-3", "hash-co-3"));

		// ONE batched dedup probe + ONE multi-row append for the whole group (never a per-row `content_hash =`).
		const res = await outbox.drainDue();
		expect(res.drained, "all 3 committed: co-1/co-3 inserted, co-2 deduped").toBe(3);
		expect(co.state.batchProbes, "exactly one batched dedup probe").toBe(1);
		expect(co.state.singleProbes, "the coalesced path never fell back to per-row probes").toBe(0);
		expect(co.state.inserts, "exactly one multi-row append").toBe(1);

		// The idempotency invariant: the already-present hash is NOT re-inserted (no duplicate memories row).
		const insert = co.state.insertSql[0] as string;
		expect(insert).toContain("'co-1'");
		expect(insert).toContain("'co-3'");
		expect(insert, "the already-landed member is deduped, never re-inserted").not.toContain("'co-2'");
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});

	it("a WHOLE group already present is all-deduped → drained with NO insert at all", async () => {
		const co = coalesceStorage();
		co.present.add("hash-all-1");
		co.present.add("hash-all-2");
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true });
		outbox.enqueue(addWrite("all-1", "hash-all-1"));
		outbox.enqueue(addWrite("all-2", "hash-all-2"));

		expect((await outbox.drainDue()).drained).toBe(2);
		expect(co.state.inserts, "every member deduped → NO append issued").toBe(0);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});

	it("heterogeneous column shapes split into SEPARATE coalesced appends (buildInsertMany stays same-shape)", async () => {
		const co = coalesceStorage();
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true });
		// Two narrow-shape ADDs + two wide-shape ADDs, same scope. The two shapes must NOT fuse into one batch.
		outbox.enqueue(addWrite("narrow-1", "hash-n-1"));
		outbox.enqueue(addWrite("narrow-2", "hash-n-2"));
		outbox.enqueue(addWriteWide("wide-1", "hash-w-1"));
		outbox.enqueue(addWriteWide("wide-2", "hash-w-2"));

		expect((await outbox.drainDue()).drained).toBe(4);
		expect(co.state.inserts, "two shapes → two separate multi-row appends").toBe(2);
		outbox.close();
	});

	it("a failed coalesced group backs off EACH member independently, then recovers with no loss/dup", async () => {
		const co = coalesceStorage();
		co.setInsertMode("fail"); // the multi-row append flaps transiently.
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true, clock, backoff: { baseMs: 1_000, capMs: 60_000 } });
		outbox.enqueue(addWrite("grp-1", "hash-grp-1"));
		outbox.enqueue(addWrite("grp-2", "hash-grp-2"));

		// The group append fails → EACH member is backed off independently (no member lost, none committed).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 2, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 2, deadLettered: 0 });

		// The backend recovers; advance past the backoff → the group drains with no duplicate.
		co.setInsertMode("ok");
		clock.advance(10_000);
		expect((await outbox.drainDue()).drained).toBe(2);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});

	it("an in-group DUPLICATE hash is NOT coalesced — it stays on the per-row dedup path (no duplicate)", async () => {
		const co = coalesceStorage();
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true });
		// Two DISTINCT ids carrying the SAME content_hash: a batch would insert both (a duplicate memory), so
		// the group is kept on the per-row path where the second row's probe dedups against the first.
		outbox.enqueue(addWrite("dup-1", "same-hash"));
		outbox.enqueue(addWrite("dup-2", "same-hash"));

		await outbox.drainDue();
		expect(co.state.singleProbes, "the duplicate-hash group fell back to per-row probes").toBeGreaterThan(0);
		expect(co.state.batchProbes, "no batched append for an unsafe duplicate-hash group").toBe(0);
		outbox.close();
	});
});

// ── c-AC-3: back-pressure — one pass attempts at most maxDrainPerInterval, the rest stay due ───────

describe("c-AC-3: maxDrainPerInterval bounds a single pass; the remainder is left due", () => {
	it("a backlog over the cap attempts at most N per pass and leaves the rest pending", async () => {
		const co = coalesceStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true, clock, maxDrainPerInterval: 2 });
		for (let i = 1; i <= 5; i++) {
			outbox.enqueue(addWrite(`bp-${i}`, `hash-bp-${i}`));
			clock.advance(1_000);
		}
		expect(outbox.counts().pending).toBe(5);

		// Pass 1 leases at most 2 (the oldest) → one coalesced append of 2 → drained 2, the other 3 stay due.
		expect((await outbox.drainDue()).drained).toBe(2);
		expect(outbox.counts().pending, "the remaining 3 are left due").toBe(3);

		// Subsequent passes drain the rest at the same bounded rate.
		expect((await outbox.drainDue()).drained).toBe(2);
		expect((await outbox.drainDue()).drained).toBe(1);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});

// ── c-AC-4: fail-soft + observability preserved across cap / coalesce / back-pressure ─────────────

describe("c-AC-4: cap/coalesce/back-pressure are fail-soft and /health stays honest under load", () => {
	it("a rejecting batched probe degrades the coalesced group to per-member backoff, escaping no rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const co = coalesceStorage();
			co.setProbeMode("throw"); // the batched dedup probe REJECTS (a degraded-window transport error).
			const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
			const outbox = openMemoryOutbox({ storage: co.storage, memory: true, clock, backoff: { baseMs: 1_000, capMs: 60_000 } });
			outbox.enqueue(addWrite("fs-1", "hash-fs-1"));
			outbox.enqueue(addWrite("fs-2", "hash-fs-2"));

			// The whole coalesced group is a failed attempt → each member backs off; the pass never aborts.
			expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 2, deadLettered: 0 });
			expect(outbox.counts(), "/health honest under a coalesce fault").toEqual({ pending: 2, retrying: 2, deadLettered: 0 });
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled, "no unhandled rejection escaped the coalesced drain").toEqual([]);
			outbox.close();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("an over-cap enqueue keeps enqueue accounting honest and /health reports the bounded backlog", async () => {
		const co = coalesceStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: co.storage, memory: true, clock, maxRows: 2 });
		// Every enqueue reports enqueued:1 even when it triggers a shed of an older row (shed never corrupts
		// the caller's accounting), and /health never reports more than the cap or a negative count.
		for (let i = 1; i <= 6; i++) {
			expect(outbox.enqueue(addWrite(`cap-${i}`, `hash-cap-${i}`))).toEqual({ enqueued: 1, dropped: 0 });
			clock.advance(1_000);
		}
		const counts = outbox.counts();
		expect(counts.pending, "the backlog is bounded to maxRows under load").toBe(2);
		expect(counts.retrying).toBe(0);
		expect(counts.deadLettered).toBe(0);
		outbox.close();
	});
});

// ── W-1: drain-recovered commits feed the SAME committedSinceBoot signal the live stage feeds ─────

describe("W-1: a memory recovered by the drainer increments committedSinceBoot (BUG-04 Verify)", () => {
	it("a coalesced drain increments the tracker by the number of committed/deduped members", async () => {
		const tracker = createMemoryFormationTracker(() => Date.parse("2026-07-11T00:00:00.000Z"));
		const co = coalesceStorage();
		co.present.add("hash-w1-2"); // w1-2 already landed → deduped; w1-1 is a fresh insert. BOTH count.
		const outbox = openMemoryOutbox({
			storage: co.storage,
			memory: true,
			onCommitted: (memoryId, action) => tracker.record({ action, memoryId }),
		});
		outbox.enqueue(addWrite("w1-1", "hash-w1-1"));
		outbox.enqueue(addWrite("w1-2", "hash-w1-2"));

		expect((await outbox.drainDue()).drained).toBe(2);
		// The counter climbs by the committed member count (1 inserted + 1 deduped), mirroring the live stage.
		expect(tracker.snapshot().committedSinceBoot).toBe(2);
		expect(["inserted", "deduped"]).toContain(tracker.snapshot().lastAction);
		outbox.close();
	});

	it("a per-row drain-recovered commit increments the tracker by 1", async () => {
		const tracker = createMemoryFormationTracker();
		const driver = driverStorage();
		driver.setMode("ok");
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			onCommitted: (memoryId, action) => tracker.record({ action, memoryId }),
		});
		outbox.enqueue(addWrite("w1-solo", "hash-w1-solo")); // a lone group → per-row commit path.

		expect((await outbox.drainDue()).drained).toBe(1);
		expect(tracker.snapshot().committedSinceBoot).toBe(1);
		outbox.close();
	});

	it("a transient-fail/backoff does NOT increment the tracker; it climbs only when the commit recovers", async () => {
		const tracker = createMemoryFormationTracker();
		const driver = driverStorage(); // starts failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({
			storage: driver.storage,
			memory: true,
			clock,
			onCommitted: (memoryId, action) => tracker.record({ action, memoryId }),
		});
		outbox.enqueue(addWrite("w1-window", "hash-w1-window"));

		// During the degraded window the re-commit fails (backoff) → the counter must NOT move.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		expect(tracker.snapshot().committedSinceBoot, "a backoff is not a commit").toBe(0);

		// The backend recovers → the drainer commits → the counter climbs THROUGH the window (BUG-04 Verify).
		driver.setMode("ok");
		clock.advance(10 * 60 * 1000);
		expect((await outbox.drainDue()).drained).toBe(1);
		expect(tracker.snapshot().committedSinceBoot).toBe(1);
		outbox.close();
	});

	it("a THROWING tracker hook never breaks the drain (fail-soft)", async () => {
		const co = coalesceStorage();
		const outbox = openMemoryOutbox({
			storage: co.storage,
			memory: true,
			onCommitted: () => {
				throw new Error("tracker boom");
			},
		});
		outbox.enqueue(addWrite("w1-fs-1", "hash-w1-fs-1"));
		outbox.enqueue(addWrite("w1-fs-2", "hash-w1-fs-2"));

		// The commit still lands + drains despite the throwing hook (the write is durable; the hook is advisory).
		expect((await outbox.drainDue()).drained).toBe(2);
		expect(co.state.inserts).toBe(1);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});
