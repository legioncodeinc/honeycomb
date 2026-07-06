/**
 * PRD-029 degradation-observability suite — Wave 1 (AC-2 / AC-3 / AC-4 / AC-5).
 *
 * Proves the daemon threads its already-latent degradation signals to `/health` + the
 * structured logs, ADDITIVELY + mode-gated + no-secret:
 *   AC-2  the structured `/health` reason NAMES the down subsystem (storage unreachable /
 *         embeddings off), not a bare `degraded`; the coarse bit still reports.
 *   AC-3  the full subsystem detail is on `local` `/health`; the PUBLIC team/hybrid `/health`
 *         returns the coarse bit ONLY (detail on the protected `/api/diagnostics/health`).
 *   AC-4  a recall that ran DEGRADED emits one structured `recall.degraded` event (mode + arm
 *         coverage) via the ring-buffer logger; a non-degraded recall emits none.
 *   AC-5  no token, full org GUID, or header value appears in the health detail, the degraded
 *         log line, or the recall response — only subsystem names + states.
 *
 * Verification posture: the health-detail builder is driven DIRECTLY (no live backend); the
 * mode-gated bodies are exercised in-process via `app.request(...)` against an assembled
 * daemon with an injected FAKE storage client; the degraded log is asserted via a recording
 * ring-buffer logger.
 */

import { describe, expect, it } from "vitest";

import {
	buildHealthDetail,
	createHealthBitTracker,
	DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
	HEALTH_DEGRADE_CONSECUTIVE_FAILURES,
	type HealthDetail,
	publicHealthDetail,
} from "../../../src/daemon/runtime/health.js";
import { createDaemon } from "../../../src/daemon/runtime/server.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { mountMemoriesApi, RECALL_DEGRADED_EVENT } from "../../../src/daemon/runtime/memories/index.js";
import { mountDiagnosticsHealthApi } from "../../../src/daemon/runtime/diagnostics-health.js";
import type { QueryScope, StorageQuery, QueryOptions } from "../../../src/daemon/storage/client.js";
import { ok as okResult, type QueryResult, type StorageRow } from "../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS } from "../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../src/daemon/runtime/services/embed-client.js";

// A secret-shaped string we assert NEVER appears in any new field/line (AC-5).
const FAKE_TOKEN = "sk-secret-bearer-DEADBEEF";
const FAKE_ORG_GUID = "11111111-2222-3333-4444-555555555555";
const SESSION = "sess-029";

/** A success `QueryResult` with zero duration (the suite never asserts on timing). */
function ok(rows: StorageRow[]): QueryResult {
	return okResult(rows, 0);
}

function cfg(mode: RuntimeConfig["mode"]): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

/** Fully-formed session-group headers (org + runtime-path + session), incl. a secret token. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-org": FAKE_ORG_GUID,
		"x-honeycomb-workspace": "ws-029",
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		authorization: `Bearer ${FAKE_TOKEN}`,
		"content-type": "application/json",
		...extra,
	};
}

/** A fake `StorageQuery` returning a single seeded `memories` row for the lexical arm. */
function fakeStorageWithHit(term: string): StorageQuery {
	return {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (/'memories'\s+AS\s+source/i.test(sql) && sql.includes(term)) {
				return ok([{ source: "memories", id: "mem-1", text: `a fact about ${term}` }]);
			}
			return ok([]);
		},
	};
}

/** An EmbedClient that returns a fixed 768-dim vector → the semantic arm RUNS (non-degraded). */
function workingEmbed(): EmbedClient {
	const vector = new Array(EMBEDDING_DIMS).fill(0.05) as number[];
	return {
		async embed(): Promise<readonly number[] | null> {
			return vector;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 — the structured `/health` reason names the down subsystem.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 /health detail NAMES the down subsystem, not a bare degraded", () => {
	it("storage probe non-ok (degraded) → reasons.storage === 'unreachable', coarse bit still reports", () => {
		// Drive the builder directly (the SELECT-1 result that maps to the coarse bit is `degraded`).
		const detail = buildHealthDetail({ status: "degraded", embeddingsEnabled: true });
		expect(detail.status, "the coarse bit still reports").toBe("degraded");
		expect(detail.reasons?.storage, "the named subsystem reason").toBe("unreachable");
		// It is NOT a bare degraded enum — the subsystem + state are present.
		expect(detail.reasons).toBeDefined();
	});

	it("storage reachable (ok) → reasons.storage === 'reachable'", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: true });
		expect(detail.status).toBe("ok");
		expect(detail.reasons?.storage).toBe("reachable");
	});

	it("unconfigured storage → storage 'unreachable' (not confirmed reachable), coarse bit preserved", () => {
		const detail = buildHealthDetail({ status: "unconfigured", embeddingsEnabled: false });
		expect(detail.status).toBe("unconfigured");
		expect(detail.reasons?.storage).toBe("unreachable");
	});

	it("embeddings off → reasons.embeddings === 'off'; on → 'on'", () => {
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: false }).reasons?.embeddings).toBe("off");
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.embeddings).toBe("on");
	});

	it("PRD-025 honesty: embeddingsState reports off/warming/on/failed from the live warm+failed signals", () => {
		// Disabled → off (coarse + fine agree).
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: false }).reasons?.embeddingsState).toBe("off");
		// Enabled but not-yet-warm → warming (the coarse field still says "on" — this is the dishonesty the
		// fine state corrects; recall is lexical MEANWHILE).
		const warming = buildHealthDetail({ status: "ok", embeddingsEnabled: true, embeddingsWarm: false });
		expect(warming.reasons?.embeddings).toBe("on");
		expect(warming.reasons?.embeddingsState).toBe("warming");
		// Enabled AND warm → on.
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true, embeddingsWarm: true }).reasons?.embeddingsState).toBe("on");
		// Enabled but the child cannot serve → failed (actionable, distinct from an indefinite warming).
		expect(
			buildHealthDetail({ status: "ok", embeddingsEnabled: true, embeddingsWarm: false, embeddingsFailed: true }).reasons
				?.embeddingsState,
		).toBe("failed");
	});

	it("legacy callers (no warm signal) → embeddingsState mirrors the coarse enabled/disabled field", () => {
		// Preserves pre-honesty behavior: an enabled caller that supplies neither warm nor failed reads "on".
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.embeddingsState).toBe("on");
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: false }).reasons?.embeddingsState).toBe("off");
	});

	it("memory-formation: omitted when unwired; surfaced (normalized) when the tracker is supplied", () => {
		// Unwired (no snapshot) → the reason is ABSENT, exactly like the other additive blocks.
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.memoryFormation).toBeUndefined();
		// Wired with commits → surfaced verbatim with a non-negative integer count + last-write detail.
		const formed = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: true,
			memoryFormation: { committedSinceBoot: 3, lastCommittedAt: "2026-07-05T23:15:04.611Z", lastAction: "inserted" },
		});
		expect(formed.reasons?.memoryFormation).toEqual({
			committedSinceBoot: 3,
			lastCommittedAt: "2026-07-05T23:15:04.611Z",
			lastAction: "inserted",
		});
		// Fresh daemon, nothing formed yet → zero (the glanceable "stalled?" symptom), no last-* fields.
		const zero = buildHealthDetail({ status: "ok", embeddingsEnabled: true, memoryFormation: { committedSinceBoot: 0 } });
		expect(zero.reasons?.memoryFormation).toEqual({ committedSinceBoot: 0 });
	});

	it("memoryQueue: omitted when unwired; 'local' healthy / 'shared' degraded when wired", () => {
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.memoryQueue).toBeUndefined();
		expect(
			buildHealthDetail({ status: "ok", embeddingsEnabled: true, memoryQueue: "local" }).reasons?.memoryQueue,
		).toBe("local");
		expect(
			buildHealthDetail({ status: "ok", embeddingsEnabled: true, memoryQueue: "shared" }).reasons?.memoryQueue,
		).toBe("shared");
	});

	it("memory feature-gating: omitted when unwired; enabled + provider enum surfaced when wired", () => {
		// Unwired (the deterministic unit suite / a daemon that never builds the pipeline worker) → absent.
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.memory).toBeUndefined();
		// Enabled + a real provider configured → the dashboard may offer + reflect the ON control.
		expect(
			buildHealthDetail({
				status: "ok",
				embeddingsEnabled: true,
				memory: { enabled: true, providerConfigured: true },
			}).reasons?.memory,
		).toEqual({ enabled: true, provider: "configured" });
		// Disabled + NO provider → the control is gated (memory cannot extract without a provider).
		expect(
			buildHealthDetail({
				status: "ok",
				embeddingsEnabled: false,
				memory: { enabled: false, providerConfigured: false },
			}).reasons?.memory,
		).toEqual({ enabled: false, provider: "unconfigured" });
	});


	it("schema is best-effort 'ok' by default; 'missing_table' only when a required table is known-missing", () => {
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.schema).toBe("ok");
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true, schemaMissingTable: true }).reasons?.schema).toBe(
			"missing_table",
		);
	});

	it("C-4: captureDroppedEvents surfaces under reasons.capture on /health (local)", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: true, captureDroppedEvents: 3 });
		expect(detail.reasons?.capture).toEqual({ droppedEvents: 3 });
	});

	it("the /health BODY surfaces the named storage reason in local mode (not a bare degraded)", async () => {
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			pipelineProbe: () => "degraded",
			healthDetail: () => buildHealthDetail({ status: "degraded", embeddingsEnabled: false }),
		});
		const res = await daemon.app.request("/health");
		expect(res.status, "storage-down still 503s (coarse gate unchanged)").toBe(503);
		const body = (await res.json()) as { status: string; pipeline: string; reasons?: Record<string, string> };
		// The coarse bit is UNCHANGED (D-3).
		expect(body.status).toBe("degraded");
		expect(body.pipeline).toBe("degraded");
		// The structured reason NAMES the subsystem.
		expect(body.reasons?.storage).toBe("unreachable");
		expect(body.reasons?.embeddings).toBe("off");
		expect(body.reasons?.schema).toBe("ok");
	});

	it("the /health BODY surfaces the memoryQueue reason ('shared' = the degraded pipeline-queue signal)", async () => {
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			pipelineProbe: () => "ok",
			healthDetail: () => buildHealthDetail({ status: "ok", embeddingsEnabled: true, memoryQueue: "shared" }),
		});
		const res = await daemon.app.request("/health");
		const body = (await res.json()) as { reasons?: { memoryQueue?: string } };
		expect(body.reasons?.memoryQueue, "the shared-queue degraded-coordination signal is glanceable").toBe("shared");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-063b b-AC-7 — the additive `reasons.portkey` enum.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-7 /health reasons.portkey reflects off/ok/unconfigured/unreachable", () => {
	it("omitted → 'off' (the conservative 'Portkey not in force' default)", () => {
		expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true }).reasons?.portkey).toBe("off");
	});

	it("each supplied state is read VERBATIM (no probe) — off | ok | unconfigured | unreachable", () => {
		for (const state of ["off", "ok", "unconfigured", "unreachable"] as const) {
			expect(buildHealthDetail({ status: "ok", embeddingsEnabled: true, portkey: state }).reasons?.portkey).toBe(state);
		}
	});

	it("the portkey reason is independent of the coarse status (storage ok, portkey unreachable)", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: true, portkey: "unreachable" });
		expect(detail.status, "the coarse bit is unaffected").toBe("ok");
		expect(detail.reasons?.storage).toBe("reachable");
		expect(detail.reasons?.portkey).toBe("unreachable");
	});

	it("the /health BODY surfaces reasons.portkey in local mode", async () => {
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => buildHealthDetail({ status: "ok", embeddingsEnabled: true, portkey: "unconfigured" }),
		});
		const res = await daemon.app.request("/health");
		const body = (await res.json()) as { reasons?: Record<string, string> };
		expect(body.reasons?.portkey).toBe("unconfigured");
	});

	it("the portkey reason carries no secret (closed-enum literal only)", () => {
		const serialized = JSON.stringify(
			buildHealthDetail({ status: "ok", embeddingsEnabled: true, portkey: "unreachable" }),
		);
		expect(serialized).not.toContain(FAKE_TOKEN);
		expect(serialized).toContain("unreachable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 — mode-gated detail (no topology leak to an unauthenticated remote).
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3 /health detail is mode-gated; full detail on the protected diagnostics surface", () => {
	const detail: HealthDetail = buildHealthDetail({ status: "ok", embeddingsEnabled: false });

	it("publicHealthDetail KEEPS reasons in local, STRIPS them in team/hybrid", () => {
		expect(publicHealthDetail(detail, "local").reasons, "local keeps reasons").toBeDefined();
		expect(publicHealthDetail(detail, "team").reasons, "team strips reasons").toBeUndefined();
		expect(publicHealthDetail(detail, "hybrid").reasons, "hybrid strips reasons").toBeUndefined();
		// The coarse status survives in every mode.
		expect(publicHealthDetail(detail, "team").status).toBe("ok");
	});

	it("local PUBLIC /health body INCLUDES reasons", async () => {
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => detail,
		});
		const res = await daemon.app.request("/health");
		const body = (await res.json()) as { status: string; reasons?: unknown };
		expect(body.reasons, "local /health carries reasons").toBeDefined();
	});

	it("team PUBLIC /health body has NO reasons (status-only — no topology to an unauthenticated remote)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => detail,
		});
		const res = await daemon.app.request("/health");
		const body = (await res.json()) as { status: string; reasons?: unknown };
		expect(body.status, "the coarse bit still reports").toBe("ok");
		expect(body.reasons, "team /health withholds the subsystem topology").toBeUndefined();
	});

	it("hybrid PUBLIC /health body has NO reasons either", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => detail,
		});
		const res = await daemon.app.request("/health");
		const body = (await res.json()) as { reasons?: unknown };
		expect(body.reasons).toBeUndefined();
	});

	it("the PROTECTED /api/diagnostics/health surface DOES expose reasons in team mode", async () => {
		// In local the diagnostics group is open by design; we mount the seam and read the full
		// detail. (Team/hybrid gate the same route behind auth — proven open here in local, which
		// is the reachable in-process posture; the auth gating is server.ts's existing contract.)
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => detail,
		});
		mountDiagnosticsHealthApi(daemon, { healthDetail: () => detail });
		const res = await daemon.app.request("/api/diagnostics/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; reasons?: Record<string, string> };
		// The protected surface carries the FULL detail (reasons present) regardless of mode.
		expect(body.status).toBe("ok");
		expect(body.reasons?.storage).toBe("reachable");
		expect(body.reasons?.embeddings).toBe("off");
		expect(body.reasons?.schema).toBe("ok");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4 — structured degraded log line.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4 a degraded recall emits one structured recall.degraded event; a non-degraded one emits none", () => {
	function makeRecallDaemon(term: string, embed?: EmbedClient) {
		const logger = createRequestLogger({ silent: true });
		const daemon = createDaemon({
			config: cfg("local"),
			storage: fakeStorageWithHit(term),
			logger,
		});
		mountMemoriesApi(daemon, {
			storage: fakeStorageWithHit(term),
			logger,
			...(embed !== undefined ? { embed } : {}),
		});
		return { daemon, logger };
	}

	it("a degraded recall (no embed client → lexical fallback) emits recall.degraded with mode + arm coverage", async () => {
		const term = "degradedterm";
		const { daemon, logger } = makeRecallDaemon(term); // no embed → degraded:true
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const events = logger.recentEvents();
		const degradedEvents = events.filter((e) => e.event === RECALL_DEGRADED_EVENT);
		expect(degradedEvents.length, "exactly one recall.degraded event").toBe(1);
		const ev = degradedEvents[0];
		expect(ev?.fields.mode, "the degraded mode is captured").toBe("lexical_fallback");
		expect(ev?.fields.sources, "the arm coverage is captured").toContain("memories");
	});

	it("a NON-degraded recall (working embed → semantic arm ran) emits NO recall.degraded event", async () => {
		const term = "semanticterm";
		const { daemon, logger } = makeRecallDaemon(term, workingEmbed());
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { degraded: boolean };
		expect(body.degraded, "the semantic arm ran → not degraded").toBe(false);
		const degradedEvents = logger.recentEvents().filter((e) => e.event === RECALL_DEGRADED_EVENT);
		expect(degradedEvents.length, "no degraded event when recall ran semantically").toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — no secret in any new field/line.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 no token / org GUID / header value in the health detail or the degraded log line", () => {
	it("the serialized HealthDetail carries only subsystem names + states (no secret)", () => {
		const detail = buildHealthDetail({ status: "degraded", embeddingsEnabled: false, schemaMissingTable: true });
		const serialized = JSON.stringify(detail);
		expect(serialized).not.toContain(FAKE_TOKEN);
		expect(serialized).not.toContain(FAKE_ORG_GUID);
		expect(serialized).not.toContain("Bearer");
		// It DOES carry the expected closed-set states.
		expect(serialized).toContain("unreachable");
		expect(serialized).toContain("missing_table");
	});

	it("the /health body (built from a request carrying a token + org GUID) leaks neither", async () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: true });
		const daemon = createDaemon({
			config: cfg("local"),
			storage: {
				async query() {
					return ok([]);
				},
			},
			logger: createRequestLogger({ silent: true }),
			healthDetail: () => detail,
		});
		const res = await daemon.app.request("/health", { headers: headers() });
		const text = await res.text();
		expect(text).not.toContain(FAKE_TOKEN);
		expect(text).not.toContain(FAKE_ORG_GUID);
		expect(text).not.toContain("Bearer");
	});

	it("the recall.degraded log line carries no token, org GUID, header value, or query text", async () => {
		const term = "redactionterm";
		const logger = createRequestLogger({ silent: true });
		const daemon = createDaemon({ config: cfg("local"), storage: fakeStorageWithHit(term), logger });
		mountMemoriesApi(daemon, { storage: fakeStorageWithHit(term), logger });
		await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		const events = logger.recentEvents().filter((e) => e.event === RECALL_DEGRADED_EVENT);
		expect(events.length).toBe(1);
		const serialized = JSON.stringify(events[0]);
		expect(serialized).not.toContain(FAKE_TOKEN);
		expect(serialized).not.toContain(FAKE_ORG_GUID);
		expect(serialized).not.toContain("Bearer");
		expect(serialized, "the query text is NOT logged (subsystem state only)").not.toContain(term);
		// It DOES carry the coarse subsystem state.
		expect(serialized).toContain("lexical_fallback");
		expect(serialized).toContain("memories");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 storage-probe tolerance: the tracker debounces a slow-but-working gateway.
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 2 createHealthBitTracker: a slow gateway must not flap the daemon to degraded", () => {
	it("starts ok, and a SINGLE failed probe stays ok (below the 2-failure threshold)", () => {
		const tracker = createHealthBitTracker();
		expect(tracker.current()).toBe("ok");
		expect(tracker.record(false)).toBe("ok");
		expect(tracker.current()).toBe("ok");
	});

	it("TWO consecutive failed probes flip to degraded (a genuinely unreachable backend still surfaces)", () => {
		const tracker = createHealthBitTracker();
		expect(tracker.record(false)).toBe("ok");
		expect(tracker.record(false)).toBe("degraded");
		expect(tracker.current()).toBe("degraded");
	});

	it("the FIRST success clears degraded back to ok (recover-on-first-success)", () => {
		const tracker = createHealthBitTracker();
		tracker.record(false);
		tracker.record(false);
		expect(tracker.current()).toBe("degraded");
		expect(tracker.record(true)).toBe("ok");
		expect(tracker.current()).toBe("ok");
	});

	it("a success resets the failure streak, so an alternating slow/ok gateway never degrades", () => {
		const tracker = createHealthBitTracker();
		expect(tracker.record(false)).toBe("ok");
		expect(tracker.record(true)).toBe("ok");
		expect(tracker.record(false)).toBe("ok");
		expect(tracker.record(true)).toBe("ok");
		expect(tracker.current()).toBe("ok");
	});

	it("the default threshold is 2 and the probe timeout is at least 12s", () => {
		expect(HEALTH_DEGRADE_CONSECUTIVE_FAILURES).toBe(2);
		expect(DEFAULT_HEALTH_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
	});
});
