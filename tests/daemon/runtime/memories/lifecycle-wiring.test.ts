/**
 * PRD-058 Wave 1 — the five lifecycle-seam WIRING suite.
 *
 * Verification posture (mirrors `assemble.test.ts` + `assembled-net.test.ts`):
 *   - Tests 1–5 use Option A — a recording `SeamFns.mountMemories` fake that captures the
 *     options object the composition root hands it, so the assertion is "the mount CARRIES
 *     this seam" (the same shape `assemble.test.ts` uses to prove each seam fires once).
 *   - Test 1 ALSO invokes the captured `recordRecallAccessFactory` against the fake storage
 *     to prove the factory is not just present but produces a real `memory_access` INSERT
 *     when its returned callback runs (a behavioural check, not just a structural one).
 *   - Test 6 (integration smoke) uses Option B — `assembleTestDaemonApp` boots the REAL
 *     daemon through `assembleDaemon` → `assembleSeams` (every seam in real order, behind
 *     the real middleware) backed by a FAKE storage, and drives `POST /api/memories/recall`
 *     via `app.request(...)`. Proves the wiring did not break the recall path.
 *
 * What this suite does NOT do: it does NOT re-test the ACT-R math (`activation.spec.ts`),
 * the calibration curve (`calibration.spec.ts`), the σ multiplier (`recall-staleness.spec.ts`),
 * or the lifecycle config defaults (`lifecycle-config.spec.ts`). Each of those engines is
 * unit-tested where it lives; HERE we assert only that the composition root in
 * `assemble.ts` lines ~1370–1423 constructs each seam and injects it into the mount —
 * i.e. the WIRE, not the math.
 *
 * Embeddings posture: `HONEYCOMB_EMBEDDINGS=false` is stubbed in the integration test so
 * recall is deterministically LEXICAL-only (no fetch to a non-existent embed daemon, no
 * flake) — the documented silent BM25/ILIKE fallback (`guides/03-bm25-fallback.md`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type SeamFns,
	assembleDaemon,
} from "../../../../src/daemon/runtime/assemble.js";
import type { QueryScope, StorageClient } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult } from "../../../../src/daemon/storage/result.js";
import type { CalibrationModel } from "../../../../src/daemon/runtime/memories/calibration.js";
import type { ActivationSource, StalenessSource } from "../../../../src/daemon/runtime/memories/recall.js";
import type { RecencyConfig } from "../../../../src/daemon/runtime/recall/config.js";
import {
	type AssembledTestDaemonApp,
	type FakeStorageResponder,
	assembleTestDaemonApp,
} from "../../../integration/_daemon-harness.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** A resolved config for the assembly without touching env. */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/**
 * A no-op storage client whose every `query` returns the scripted result. The health probe
 * runs `SELECT 1` through this; an `ok` result keeps the cached bit green.
 */
function fakeStorage(result: QueryResult): StorageClient {
	return {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return result;
		},
		async query() {
			return result;
		},
	} as unknown as StorageClient;
}

const OK_RESULT: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };

/**
 * The lifecycle options captured off the `mountMemories` call. The five PRD-058 seams are
 * the optional fields on `MountMemoriesOptions`; absent → undefined.
 */
interface CapturedMemoriesOptions {
	storage?: StorageClient;
	defaultScope?: QueryScope;
	recordRecallAccessFactory?: (scope: QueryScope) => (memoryId: string) => Promise<void>;
	activationSource?: ActivationSource;
	stalenessSource?: StalenessSource;
	stalenessExponent?: number;
	lifecycleRecency?: RecencyConfig;
	calibrationModel?: Promise<CalibrationModel>;
	confidenceExponent?: number;
}

/**
 * Option A harness: a `SeamFns` whose `mountMemories` records the options object the
 * composition root handed it. Every other seam is a no-op (this suite is scoped to the
 * memories lifecycle wiring ONLY). Returns the captured-options sink so a test asserts
 * on the EXACT shape `assemble.ts` injected.
 */
function capturingMemoriesSeams(): { seams: SeamFns; captured: CapturedMemoriesOptions } {
	const captured: CapturedMemoriesOptions = {};
	const noop = (() => {}) as never;
	const seams: SeamFns = {
		attachHooks: (() => ({ register() {}, recordTurn() {} })) as SeamFns["attachHooks"],
		mountDashboard: noop,
		mountNotifications: noop,
		attachPrune: noop,
		mountLogs: noop,
		// THE seam under test: capture the options the composition root passes in.
		mountMemories: ((_daemon, options) => {
			Object.assign(captured, options);
		}) as SeamFns["mountMemories"],
		mountVfs: noop,
		mountProductData: noop,
		mountPollinate: noop,
		mountProjectsSync: noop,
		mountCompact: noop,
		mountDiagnosticsHealth: noop,
	};
	return { seams, captured };
}

// ─── Tests 1–5: Option A — capture the options handed to mountMemories ─────────

describe("PRD-058 Wave 1 — the composition root wires the five lifecycle seams into mountMemories", () => {
	beforeEach(() => {
		// Tests 1–5 use a fake `query()` returning a single ok row; no embed daemon is
		// contacted because `mountMemories` is the captured fake (the real recall engine
		// never runs in these tests). The stub is defensive only.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("L-W1: recordRecallAccessFactory is constructed and non-undefined in the assembled daemon", async () => {
		const { seams, captured } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			seams,
		});

		// Structural: the mount CARRIES the factory.
		expect(
			captured.recordRecallAccessFactory,
			"L-W1: the composition root threaded a recordRecallAccessFactory into mountMemories",
		).toBeDefined();
		expect(typeof captured.recordRecallAccessFactory).toBe("function");

		// Behavioural: the factory is a `(scope) => (memoryId) => Promise<void>` closure that
		// appends ONE `recall` access event to `memory_access` when its returned callback runs.
		// `assemble.ts` line ~1383: `(scope) => createRecordRecallAccess(storage, scope)`.
		const requests: { sql: string }[] = [];
		const recordingStorage = {
			get endpoint() {
				return "https://example.invalid";
			},
			async connect() {
				return OK_RESULT;
			},
			async query(sql: string, _scope: QueryScope): Promise<QueryResult> {
				requests.push({ sql });
				return OK_RESULT;
			},
		} as unknown as StorageClient;
		const { seams: seams2, captured: captured2 } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: recordingStorage,
			logger: createRequestLogger({ silent: true }),
			seams: seams2,
		});
		const factory = captured2.recordRecallAccessFactory!;
		const scope: QueryScope = { org: "local", workspace: "default" };
		// Apply the request scope, then record an access for one memory id.
		const recordOne = factory(scope);
		await expect(recordOne("mem-l-w1")).resolves.toBeUndefined();
		// The factory's callback appended ONE event to `memory_access` (the fail-soft
		// INSERT is the load-bearing side effect of L-W1 — `access-log.ts` `recordAccess`).
		expect(
			requests.some((r) => /INSERT\s+INTO\s+"memory_access"/i.test(r.sql)),
			"L-W1: invoking the factory's callback appended a memory_access event",
		).toBe(true);
		// And the event is a `recall` (usefulness 0 — the grade arrives later), not a reinforce.
		expect(
			requests.some((r) => /'recall'/i.test(r.sql)),
			"L-W1: the access event kind is `recall` (usefulness 0)",
		).toBe(true);
	});

	it("L-W2: activationSource is constructed and non-undefined", () => {
		const { seams, captured } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			seams,
		});

		// The mount CARRIES an ActivationSource. The ACT-R Stage-2 math is proven in
		// `activation.spec.ts`; here we assert only the WIRE.
		expect(
			captured.activationSource,
			"L-W2: the composition root threaded an activationSource into mountMemories",
		).toBeDefined();
		expect(typeof captured.activationSource!.load).toBe("function");
		// `params` carries the resolved ACT-R knobs (decay / A_min / B*).
		expect(captured.activationSource!.params, "the source carries its resolved ACT-R params").toBeDefined();
	});

	it("L-W3: calibrationModel is constructed and resolves to the IDENTITY cold-start model", async () => {
		const { seams, captured } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			// `memory_calibration` is empty on this fake (every query returns the OK `SELECT 1`
			// row, which `readCalibrationModel` treats as no fitted row) → the IDENTITY cold-start.
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			seams,
		});

		// The mount CARRIES the calibration promise.
		expect(
			captured.calibrationModel,
			"L-W3: the composition root threaded a calibrationModel promise into mountMemories",
		).toBeDefined();
		expect(typeof captured.calibrationModel!.then).toBe("function");

		// Awaiting it yields a CalibrationModel. With no `memory_calibration` row the boot
		// read fails soft to the IDENTITY cold-start (`C = f`, AC-55e.2.2).
		const model = await captured.calibrationModel!;
		expect(model, "L-W3: the promise resolves to a CalibrationModel").toBeDefined();
		expect(
			model.identity,
			"L-W3: with no memory_calibration row the model is the IDENTITY cold-start (C = f)",
		).toBe(true);
		expect(Array.isArray(model.knots)).toBe(true);
		expect(model.knots.length, "the identity model carries no knots").toBe(0);
	});

	it("L-W4: stalenessSource is constructed and non-undefined", () => {
		const { seams, captured } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			seams,
		});

		// The mount CARRIES a StalenessSource. The σ-multiplier math is proven in
		// `recall-staleness.spec.ts`; here we assert only the WIRE.
		expect(
			captured.stalenessSource,
			"L-W4: the composition root threaded a stalenessSource into mountMemories",
		).toBeDefined();
		expect(typeof captured.stalenessSource!.load).toBe("function");
		// The source's `exponent` is the posture-gated `s`. Under the default `observe`
		// posture `s = 0` (visible but inert, AC-55c.2.1).
		expect(
			typeof captured.stalenessSource!.exponent,
			"L-W4: the source carries its posture-gated exponent",
		).toBe("number");
	});

	it("L-W5: lifecycle config is resolved and threaded (lifecycleRecency + stalenessExponent + confidenceExponent)", () => {
		const { seams, captured } = capturingMemoriesSeams();
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			seams,
		});

		// `lifecycleRecency` is the projection of the boot-resolved lifecycle config into the
		// recall `RecencyConfig` shape (`a` + per-class half-lives). ABSENT → engine defaults.
		expect(
			captured.lifecycleRecency,
			"L-W5: the composition root threaded a lifecycleRecency config into mountMemories",
		).toBeDefined();
		expect(
			typeof captured.lifecycleRecency!.activationExponent,
			"L-W5: the recency config carries the `a` activation exponent",
		).toBe("number");

		// `stalenessExponent` is the posture-gated `s` threaded SEPARATELY so the recall handler
		// can pass it to the engine's `stalenessSource.exponent` consistently. The default
		// posture is `observe` → `s = 0` (visible but inert, AC-55c.2.1).
		expect(
			captured.stalenessExponent,
			"L-W5: stalenessExponent is threaded as a number",
		).toBeTypeOf("number");
		expect(
			captured.stalenessExponent!,
			"L-W5: under the default `observe` posture s = 0 (inert)",
		).toBe(0);

		// `confidenceExponent` is the `c` from the resolved lifecycle config. It stays 0 until
		// eval-gated (AC-55e.2.3) — informational at this wave, never reorders.
		expect(
			captured.confidenceExponent,
			"L-W5: confidenceExponent is threaded as a number",
		).toBeTypeOf("number");
		expect(
			captured.confidenceExponent!,
			"L-W5: the `c` exponent defaults to 0 (no reorder until eval-gated)",
		).toBe(0);
	});
});

// ─── Test 6: Option B — integration smoke through the REAL assembled daemon ─────

/**
 * A fake-storage responder that makes the `memories` LEXICAL recall arm surface ONE
 * deterministic row and degrades the sibling arms (mirrors `assembled-net.test.ts`).
 * Embeddings are forced off in `beforeEach`, so recall runs lexical-only and reports
 * `degraded: true` — the documented silent BM25/ILIKE fallback.
 */
const RECALL_HIT_TEXT = "the assembled lifecycle-wiring smoke reached the recall handler" as const;
const recallResponder: FakeStorageResponder = (sql: string): QueryResult => {
	if (/FROM\s+"memories"/i.test(sql)) {
		return ok([{ source: "memories", id: "mem-1", text: RECALL_HIT_TEXT }], 1);
	}
	if (/FROM\s+"memory"/i.test(sql)) return queryError('relation "memory" does not exist', 404);
	if (/FROM\s+"sessions"/i.test(sql)) return queryError('relation "sessions" does not exist', 404);
	return ok([], 1);
};

/** The session-group headers a `/api/memories/*` request must carry to clear the edge. */
const SESSION_HEADERS = {
	"x-honeycomb-runtime-path": "legacy",
	"x-honeycomb-session": "lifecycle-wiring-smoke",
	"content-type": "application/json",
} as const;

describe("L-W-integration: a recall through the assembled daemon (all five seams wired) does not throw and returns hits", () => {
	let net: AssembledTestDaemonApp;

	beforeEach(() => {
		// Force embeddings OFF so recall is deterministically LEXICAL-only (no fetch to a
		// non-existent embed daemon, no flake). `assembleDaemon` reads this at assembly.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
		net = assembleTestDaemonApp({ mode: "local", responder: recallResponder });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("POST /api/memories/recall answers 200 with a hits array (the wiring did not break the recall path)", async () => {
		const res = await net.app.request("/api/memories/recall", {
			method: "POST",
			headers: { ...SESSION_HEADERS },
			body: JSON.stringify({ query: "lifecycle-wiring-smoke" }),
		});

		// The recall handler ran — not 501 (scaffold), not 400 (edge), not 500 (a seam threw).
		// All five lifecycle seams are wired in `assemble.ts`; this proves the wiring is
		// non-throwing end to end (the calibration promise resolved, the activation + staleness
		// sources were constructible, the recency config projected, the access factory closed).
		expect(res.status, "the assembled daemon serves recall with all five seams wired").toBe(200);
		const body = (await res.json()) as {
			hits: { source: string; text: string }[];
			sources: string[];
			degraded: boolean;
		};
		expect(Array.isArray(body.hits), "recall returns a hits array").toBe(true);
		expect(
			body.hits.some((h) => h.source === "memories" && h.text === RECALL_HIT_TEXT),
			"the canned memories hit surfaced through the wired recall path",
		).toBe(true);
		// Lexical-only (embeddings forced off) → honest degraded flag (the silent BM25 fallback
		// is expected here, not a surprising degradation — `guides/03-bm25-fallback.md`).
		expect(body.degraded, "lexical-only fallback is signalled honestly").toBe(true);
	});
});
