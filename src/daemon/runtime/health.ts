/**
 * The structured `/health` detail contract — PRD-029 Wave 1 (AC-2 / AC-3 / D-2..D-5).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ADDITIVE, BACKWARD-COMPATIBLE (D-3). The coarse {@link PipelineStatus} bit
 * (`ok`/`degraded`/`unconfigured`) and its every existing consumer (`/api/status`,
 * the connectivity banner, the 503 gate in `server.ts`) are UNCHANGED. This module
 * adds a per-subsystem `reasons` block that NAMES which subsystem is down — storage,
 * embeddings, schema — so a degraded daemon stops looking healthy with no WHY (the
 * live-dogfood pain this PRD surfaces). The `reasons` are NEW fields layered on the
 * SAME cached health bit; no new probe is introduced (D-4).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── No secret, by construction (D-5) ─────────────────────────────────────────
 * Every field here is a SUBSYSTEM NAME + a coarse STATE enum (`reachable`/`on`/`ok`…).
 * There is no token, endpoint credential, org GUID, header value, or URL in any field
 * — the same redaction posture `RequestLogRecord` and the SQL tracer already enforce.
 * The shape is a closed set of string literals, so a value can NEVER carry a secret.
 *
 * ── Where each reason comes from (D-4: read the already-cached state) ─────────
 *   - `storage`     ← the coarse pipeline bit the `refreshHealth` `SELECT 1` probe
 *                     maintains (`assemble.ts`). `ok` → reachable; anything else →
 *                     unreachable. No new round-trip; we read the cached bit.
 *   - `embeddings`  ← the embed-seam state KNOWN AT ASSEMBLY (the no-op vs real embed
 *                     client, ledger D-4). `on` when the real embedder is wired,
 *                     `off` for the no-op / explicit `HONEYCOMB_EMBEDDINGS=false`.
 *   - `schema`      ← best-effort: `ok` unless a REQUIRED table is known-missing. With
 *                     no cheap always-on signal at the health seam, this stays `ok`
 *                     (conservative — never a false "missing_table"); a caller that
 *                     HAS a known-missing signal passes `missing_table` explicitly.
 *
 * ── Mode-gating lives at the CALLER, not here (D-2 / AC-3) ────────────────────
 * This module is the pure contract + builder. WHICH surface exposes `reasons` is the
 * caller's call: `server.ts` `/health` includes `reasons` in `local` mode and omits
 * them on the PUBLIC team/hybrid `/health` (status-only — no topology to an
 * unauthenticated remote), while the PROTECTED `/api/diagnostics/health` surface
 * exposes the full detail in team/hybrid. {@link publicHealthDetail} is the helper
 * that strips `reasons` for the public-by-mode body so the gating is one named call.
 */

import type { MemoryFormationSnapshot } from "./pipeline/memory-formation.js";

/** The coarse pipeline status the cached `/health` bit reports (mirrors `server.ts`). */
export type PipelineStatus = "ok" | "degraded" | "unconfigured";

/**
 * The storage `SELECT 1` probe timeout (ms). Raised from the original 5s so a slow-but-working
 * Deeplake gateway (a `SELECT 1` that returns 200 but takes several seconds of wall time) is not
 * misread as unreachable. A genuinely unreachable backend still surfaces: the probe fails on the
 * timeout and the consecutive-failure rule below flips the bit after repeated misses.
 */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 12_000;

/**
 * Consecutive failed probes required before the cached health bit flips to `degraded`. A SINGLE
 * slow/timed-out probe must not flap the daemon to `degraded` (the live-dogfood pain: one slow
 * gateway round trip turned the whole dashboard red). Recovery is immediate: the first successful
 * probe clears the bit back to `ok`. A genuinely unreachable backend keeps failing, so it still
 * reaches `degraded` on the second miss (never masked).
 */
export const HEALTH_DEGRADE_CONSECUTIVE_FAILURES = 2;

/** A tolerant health-bit tracker: it debounces transient probe failures (see the two constants above). */
export interface HealthBitTracker {
	/**
	 * Feed one probe outcome and return the resulting coarse bit. `true` (a reachable probe) resets
	 * the failure streak and reports `ok` immediately (recover-on-first-success). `false` increments
	 * the streak and reports `degraded` only once the streak reaches the configured threshold; below
	 * it the previously-reported bit stands, so a single failure never flaps to `degraded`.
	 */
	record(ok: boolean): PipelineStatus;
	/** The current coarse bit without feeding a new outcome. */
	current(): PipelineStatus;
}

/**
 * Build a {@link HealthBitTracker}. `degradeAfter` is the number of CONSECUTIVE failed probes
 * required before flipping to `degraded` (default {@link HEALTH_DEGRADE_CONSECUTIVE_FAILURES}, min 1).
 * The initial bit is `ok` (a freshly-assembled live client is assumed reachable until proven otherwise,
 * matching the pre-existing probe posture).
 */
export function createHealthBitTracker(degradeAfter: number = HEALTH_DEGRADE_CONSECUTIVE_FAILURES): HealthBitTracker {
	const threshold = Math.max(1, Math.trunc(degradeAfter));
	let consecutiveFailures = 0;
	let bit: PipelineStatus = "ok";
	return {
		record(ok: boolean): PipelineStatus {
			if (ok) {
				consecutiveFailures = 0;
				bit = "ok";
				return bit;
			}
			consecutiveFailures += 1;
			if (consecutiveFailures >= threshold) bit = "degraded";
			return bit;
		},
		current(): PipelineStatus {
			return bit;
		},
	};
}

/**
 * A per-subsystem coarse state (PRD-029). `ok` is the healthy state; the down state is
 * named per subsystem in {@link HealthReasons}. Kept as a closed enum so a reason can
 * never carry a free-form (secret-bearing) string.
 */
export type SubsystemState = "ok" | "degraded";

/**
 * The Portkey gateway health reason (PRD-063b / b-AC-7). A closed enum, mode-gated like the
 * other reasons, carrying NO secret (the values are fixed literals — no key, config id, or URL):
 *   - `off`          — the `portkey.enabled` toggle is off; the per-provider path is in force.
 *   - `ok`           — Portkey is on, `PORTKEY_API_KEY` is present, the Portkey path is built.
 *   - `unconfigured` — Portkey is on but `PORTKEY_API_KEY` is absent (fail-closed, b-AC-4).
 *   - `no_model`     — Portkey is on (+ a config id) but `activeModel` is missing/empty
 *                      (ISS-005 fail-closed): NO Portkey target is built — the daemon must never
 *                      POST `model: ""` to the gateway — and this state names WHY. ADDITIVE to
 *                      the closed enum (an older consumer that only special-cases
 *                      `unconfigured`/`unreachable` simply renders it as a non-degraded string).
 *   - `unreachable`  — an ACTUAL observed runtime failure: a Portkey call could not connect /
 *                      was auth-rejected. Derived ONLY from a cached last-failure signal updated
 *                      when a real call fails — NEVER a synchronous `/health` network probe, and
 *                      never fabricated (b-AC-7). The observed HTTP status code travels in the
 *                      ADDITIVE sibling {@link HealthReasons.portkeyUnreachableStatus} (so an
 *                      auth-rejection 401 is distinguishable from a bad-request 400 or a 503).
 */
export type PortkeyHealth = "off" | "ok" | "unconfigured" | "no_model" | "unreachable";

/**
 * The fine-grained embeddings health (PRD-025 honesty). A closed enum, carrying NO secret:
 *   - `off`     — embeddings are disabled (opted out / never enabled); recall is lexical by design.
 *   - `warming` — enabled and the embed child is coming up / downloading + loading the model; recall
 *                 is lexical MEANWHILE (degraded), and this flips to `on` once the model is warm.
 *   - `on`      — enabled AND the model is warm: semantic recall is actually working.
 *   - `failed`  — enabled but the embed child cannot serve (warmup threw, or the crash-restart budget
 *                 was exhausted). Actionable, and honestly distinct from an indefinite `warming`.
 *
 * This is the HONEST successor to the coarse two-state `embeddings` reason (which reports only
 * enabled-vs-disabled, so it reads `on` even while the model is still downloading or has failed to
 * load). It is exposed ADDITIVELY as `HealthReasons.embeddingsState` so the coarse field's contract is
 * unchanged; the Hive dashboard prefers `embeddingsState` when present.
 */
export type EmbeddingsHealth = "off" | "warming" | "on" | "failed";

/** PRD-073b: the machine-readable dormancy reason codes surfaced on the health detail. */
export const CAPTURE_DORMANT_NO_PROJECT = "capture_dormant_no_project" as const;
/** PRD-073b: the machine-readable capture-blocked-on-tenancy reason code. */
export const CAPTURE_BLOCKED_TENANCY_UNCONFIRMED = "capture_blocked_tenancy_unconfirmed" as const;
/** PRD-073b: the human-readable guidance for the dormant-no-project reason (parent AC-3). */
export const NO_ACTIVE_PROJECT_GUIDANCE = "no active project; bind one in the Hive dashboard" as const;
/** PRD-073b: the human-readable guidance for the tenancy-unconfirmed reason. */
export const TENANCY_UNCONFIRMED_GUIDANCE =
	"tenancy not confirmed; choose an org and workspace in the Hive dashboard" as const;

/**
 * The per-subsystem reasons behind a `/health` status (AC-2). Each field NAMES a
 * subsystem and its coarse state — never a bare `degraded` — so an operator sees WHY
 * the daemon is degraded (storage unreachable? embeddings off? a table missing?).
 * Carries NO secret (D-5): every value is a fixed string literal.
 */
export interface HealthReasons {
	/** Storage reachability, from the `SELECT 1` probe bit: `reachable` when the bit is `ok`. */
	readonly storage: "reachable" | "unreachable";
	/** The embed seam at assembly: `on` when the real embedder is wired, `off` for the no-op. */
	readonly embeddings: "on" | "off";
	/**
	 * The HONEST fine-grained embeddings state (PRD-025 honesty). ADDITIVE alongside the coarse
	 * `embeddings` field — present when the builder is given the live warm/failed signals (the daemon
	 * composition root), so an operator sees `warming`/`failed` rather than a `on` that merely means
	 * "enabled". Absent only in the degenerate case where a caller passes neither signal AND the coarse
	 * field is enough. Carries NO secret (a fixed literal). See {@link EmbeddingsHealth}.
	 */
	readonly embeddingsState?: EmbeddingsHealth;
	/** A required table's presence (best-effort): `ok` unless a required table is known-missing. */
	readonly schema: "ok" | "missing_table";
	/** The Portkey gateway state (PRD-063b / b-AC-7 / ISS-005): `off` | `ok` | `unconfigured` | `no_model` | `unreachable`. */
	readonly portkey: PortkeyHealth;
	/**
	 * ISS-005 (honest gateway status): the HTTP status code of the LAST observed Portkey failure,
	 * present ONLY while `portkey === "unreachable"`. Lets an operator distinguish
	 * `unreachable(401)` (bad key) from `unreachable(400)` (bad request) or `unreachable(503)`
	 * (network). ADDITIVE — the `portkey` literal is unchanged, so existing consumers that match
	 * on `"unreachable"` keep working. A bare integer status code, never a body/key (no secret).
	 */
	readonly portkeyUnreachableStatus?: number;
	/** Capture persistence observability: events acked but not durably written since boot. */
	readonly capture?: {
		/** Events acked to the hook but lost on flush/batch-insert since boot (PRD-062c). */
		readonly droppedEvents: number;
		/**
		 * PRD-073b (b-AC-3.1): captures GATED by the dormancy ladder since boot, partitioned by reason
		 * (`no_bound_project` / `tenancy_unconfirmed`). Present only when the composition root wires the
		 * gated-captures counter; omitted on a bare `createDaemon`.
		 */
		readonly gated?: {
			readonly no_bound_project: number;
			readonly tenancy_unconfirmed: number;
		};
	};
	/**
	 * PRD-073b: present WHILE zero folder bindings exist (capture is dormant — parent AC-3). Carries
	 * the machine-readable code + the "bind one in the Hive dashboard" guidance. Absent once any
	 * project is bound (the next read clears it — AC-073b.1.1).
	 */
	readonly captureDormant?: {
		readonly code: typeof CAPTURE_DORMANT_NO_PROJECT;
		readonly guidance: string;
	};
	/**
	 * PRD-073b: present WHILE tenancy is unconfirmed (capture is blocked — AC-073b.1.2). Carries the
	 * machine-readable code + guidance. Absent once tenancy is confirmed (the next read clears it).
	 */
	readonly captureTenancyUnconfirmed?: {
		readonly code: typeof CAPTURE_BLOCKED_TENANCY_UNCONFIRMED;
		readonly guidance: string;
	};
	/**
	 * PRD-079a/079b: the durable capture retry outbox backlog — `pending` ACTIVE queued rows awaiting a
	 * durable re-append (after a DeepLake degraded-window append failure) + the `retrying` subset that has
	 * already failed at least one drain attempt (`attempts > 0`) + the `deadLettered` terminal count (rows
	 * that hit `maxAttempts` or exceeded `maxAgeMs` and were retained but retired — b-AC-2). The glanceable
	 * "is a degraded window backing up captures, is it draining on recovery, and is anything giving up?"
	 * signal: `pending > 0` during a bad window, `pending → 0` once the backend recovers, `deadLettered > 0`
	 * once a row exhausts its bound. Present only when the composition root wires the outbox; omitted on a
	 * bare `createDaemon`. Carries NO secret — three counts.
	 */
	readonly captureOutbox?: {
		readonly pending: number;
		readonly retrying: number;
		readonly deadLettered: number;
	};
	/**
	 * PRD-080a/080b: the durable controlled-write outbox backlog — `pending` ACTIVE queued rows awaiting a
	 * durable re-commit (after a DeepLake degraded-window commit failure) + the `retrying` subset that has
	 * already failed at least one drain attempt (`attempts > 0`) + the `deadLettered` terminal count (rows
	 * that hit `maxAttempts` or exceeded `maxAgeMs` and were retained but retired — b-AC-2). The glanceable
	 * "is a degraded window backing up distilled memories, is it draining on recovery, and is anything giving
	 * up?" signal: `pending > 0` during a bad window, `pending → 0` once the backend recovers, `deadLettered
	 * > 0` once a row exhausts its bound. Present only when the composition root wires the memory outbox;
	 * omitted on a bare `createDaemon`. Carries NO secret — three counts.
	 */
	readonly memoryOutbox?: {
		readonly pending: number;
		readonly retrying: number;
		readonly deadLettered: number;
	};
	/**
	 * Memory-formation observability: memories the controlled-write stage actually committed since boot.
	 * The glanceable "is this daemon forming memories?" signal — it exists BECAUSE the recurring storage
	 * probe is disabled in local-queue mode (PRD-066 idle-cost boundary), so `storage: reachable` no
	 * longer implies writes are landing. `committedSinceBoot: 0` on a busy daemon is the loud symptom of
	 * a stalled pipeline. Present only when the composition root wires the tracker. Carries NO secret —
	 * a count, an ISO timestamp, and a closed-set action word.
	 */
	readonly memoryFormation?: MemoryFormationSnapshot;
	/**
	 * Which queue backs the memory pipeline. `local` is the healthy default — the transactional
	 * daemon-local SQLite queue. `shared` means pipeline jobs route to the DeepLake `memory_jobs` queue,
	 * which is UNRELIABLE under read-after-write lag (version collisions re-lease completed jobs, so the
	 * pipeline may never drain and memories may not form). `shared` is the loud, glanceable signal that a
	 * daemon is in the degraded coordination mode — set `HONEYCOMB_LOCAL_QUEUE_ENABLED=true` (the default)
	 * to fix it. Present only when the composition root wires the signal. A closed enum — no secret.
	 */
	readonly memoryQueue?: "local" | "shared";
	/**
	 * Memory-formation FEATURE gating — the two signals the dashboard's future "Memory Formation"
	 * control reads to decide show/hide + on/off, carrying NO secret (both are fixed enums):
	 *   - `enabled`  — is the memory pipeline's master switch ON right now (vault-first `memory.enabled`,
	 *                  else the `HONEYCOMB_PIPELINE_ENABLED` env)? The toggle's current state.
	 *   - `provider` — is a REAL inference model provider configured (the assembled ModelClient is
	 *                  non-noop: a Portkey key / `agent.yaml` inference block / provider env resolved)?
	 *                  `configured` → the dashboard may offer the memory-enable action; `unconfigured`
	 *                  → the control is gated (memory formation cannot extract without a provider).
	 * Present only when the composition root wires the pipeline worker (which computes both at boot).
	 * `provider` is a BOOLEAN-equivalent enum, never a key/name/URL — the no-secret health posture.
	 */
	readonly memory?: {
		/** Whether the pipeline master switch is on (vault-first `memory.enabled`, else env). */
		readonly enabled: boolean;
		/** Whether a real model provider is configured (the ModelClient is non-noop). */
		readonly provider: "configured" | "unconfigured";
	};
}

/**
 * The structured `/health` detail (AC-2 / D-3). The coarse `status` bit ALWAYS reports;
 * `reasons` is the additive per-subsystem block. `reasons` is OPTIONAL because the
 * mode-gated public body omits it (team/hybrid public `/health` returns `{ status }`
 * only — AC-3); the full detail (with `reasons`) is exposed in `local` `/health` and on
 * the protected `/api/diagnostics/health` surface.
 */
export interface HealthDetail {
	/** The coarse pipeline status (unchanged from the pre-029 bit). */
	readonly status: PipelineStatus;
	/** The per-subsystem reasons; present in local + protected detail, absent on public team/hybrid. */
	readonly reasons?: HealthReasons;
}

/** The inputs the health-detail builder reads — all already-cached daemon state (D-4). */
export interface HealthDetailInputs {
	/** The coarse pipeline bit the `refreshHealth` `SELECT 1` probe maintains. */
	readonly status: PipelineStatus;
	/** Whether the REAL embedder is wired at assembly (the embed-seam state, ledger D-4). */
	readonly embeddingsEnabled: boolean;
	/**
	 * PRD-025 honesty: whether the embed model has finished WARMING (semantic actually working). When
	 * supplied (a real boolean), the builder computes `embeddingsState`: `true` → `on`, `false` →
	 * `warming` (unless `embeddingsFailed`). Omitted (legacy callers) → `embeddingsState` mirrors the
	 * coarse `embeddings` field, preserving pre-honesty behavior.
	 */
	readonly embeddingsWarm?: boolean;
	/**
	 * PRD-025 honesty: whether the embed child cannot serve (warmup threw, or the crash-restart budget
	 * was exhausted). When `true` and embeddings are enabled → `embeddingsState: "failed"`. Omitted →
	 * not failed.
	 */
	readonly embeddingsFailed?: boolean;
	/**
	 * Whether a REQUIRED table is known-missing (best-effort). Defaults to `false`
	 * (→ `schema: "ok"`) — the conservative posture when there is no cheap signal at the
	 * health seam. A caller with a real known-missing signal passes `true`.
	 */
	readonly schemaMissingTable?: boolean;
	/**
	 * The Portkey gateway state (PRD-063b / b-AC-7). `off`/`ok`/`unconfigured` are derived from
	 * config AT ASSEMBLY (the factory's {@link PortkeyStatus}); `unreachable` is supplied by a
	 * caller that holds a cached LAST-FAILURE signal (a real Portkey call failed to connect). The
	 * builder reads this verbatim — it performs NO probe. Defaults to `off` (the conservative
	 * "Portkey not in force" posture) so the pre-063b builder behavior is preserved when omitted.
	 */
	readonly portkey?: PortkeyHealth;
	/**
	 * ISS-005: the HTTP status code of the last observed Portkey failure (the argument
	 * `recordPortkeyUnreachable` received). Surfaced as `reasons.portkeyUnreachableStatus` ONLY
	 * when `portkey` is `unreachable`; ignored otherwise. Additive — omitted by legacy callers.
	 */
	readonly portkeyUnreachableStatus?: number;
	/**
	 * Capture events acked to the hook but lost on flush/batch-insert since boot. Omitted when the
	 * composition root does not wire the counter (bare `createDaemon` / pre-C-4 posture).
	 */
	readonly captureDroppedEvents?: number;
	/**
	 * PRD-073b (b-AC-3.1): the per-reason gated-captures totals since boot. Omitted when the
	 * composition root does not wire the gated-captures counter.
	 */
	readonly captureGated?: {
		readonly no_bound_project: number;
		readonly tenancy_unconfirmed: number;
	};
	/**
	 * PRD-073b (AC-073b.1.1 / parent AC-3): true WHILE zero folder bindings exist → the health detail
	 * carries the `capture_dormant_no_project` reason. Read live per health call so binding a project
	 * clears it on the next read. Defaults `false` (no dormancy reason) when the composition root does
	 * not wire the probe.
	 */
	readonly captureDormantNoProject?: boolean;
	/**
	 * PRD-073b (AC-073b.1.2): true WHILE tenancy is unconfirmed → the detail carries the
	 * `capture_blocked_tenancy_unconfirmed` reason. Read live so confirming clears it. Defaults `false`.
	 */
	readonly captureTenancyUnconfirmed?: boolean;
	/**
	 * PRD-079a/079b: the capture retry outbox backlog (`{ pending, retrying, deadLettered }`). Omitted
	 * when the composition root does not wire the outbox → the `captureOutbox` reason is absent. Present →
	 * surfaced verbatim (normalized to non-negative integers) as {@link HealthReasons.captureOutbox}.
	 * `deadLettered` is optional on the INPUT (a legacy caller passing only `{ pending, retrying }` still
	 * type-checks; it normalizes to 0) but is ALWAYS emitted on the output reason (b-AC-2).
	 */
	readonly captureOutbox?: {
		readonly pending: number;
		readonly retrying: number;
		readonly deadLettered?: number;
	};
	/**
	 * PRD-080a/080b: the controlled-write retry outbox backlog (`{ pending, retrying, deadLettered }`).
	 * Omitted when the composition root does not wire the outbox → the `memoryOutbox` reason is absent.
	 * Present → surfaced verbatim (normalized to non-negative integers) as {@link HealthReasons.memoryOutbox}.
	 * `deadLettered` is optional on the INPUT (a legacy caller passing only `{ pending, retrying }` still
	 * type-checks; it normalizes to 0) but is ALWAYS emitted on the output reason (b-AC-2).
	 */
	readonly memoryOutbox?: {
		readonly pending: number;
		readonly retrying: number;
		readonly deadLettered?: number;
	};
	/**
	 * Memories committed by the controlled-write stage since boot (the in-process
	 * {@link import("./pipeline/memory-formation.js").MemoryFormationSnapshot}). Omitted when the
	 * composition root does not wire the tracker (bare `createDaemon` / the deterministic unit suite);
	 * present → surfaced verbatim as `reasons.memoryFormation`.
	 */
	readonly memoryFormation?: MemoryFormationSnapshot;
	/**
	 * Which queue backs the memory pipeline (`local` healthy default / `shared` degraded). Omitted when
	 * the composition root does not wire it → the `memoryQueue` reason is absent. See {@link HealthReasons.memoryQueue}.
	 */
	readonly memoryQueue?: "local" | "shared";
	/**
	 * The memory-formation feature-gating signal (this PRD). Omitted when the composition root does not
	 * wire the pipeline worker → the `memory` reason is absent. When present, surfaced verbatim as
	 * {@link HealthReasons.memory}. See that field for the dashboard's use. No secret (two enums).
	 */
	readonly memory?: {
		/** Whether the pipeline master switch is on (vault-first `memory.enabled`, else env). */
		readonly enabled: boolean;
		/** Whether a real model provider is configured (the ModelClient is non-noop). */
		readonly providerConfigured: boolean;
	};
}

/**
 * Build the FULL {@link HealthDetail} (with `reasons`) from the already-cached daemon
 * state (AC-2). PURE — no probe, no I/O, no clock (D-4): it maps the cached bits onto
 * the named per-subsystem reasons. `storage` is `reachable` iff the coarse bit is `ok`
 * (a `degraded` OR `unconfigured` bit both mean "storage not confirmed reachable").
 *
 * This is the function AC-2 drives directly: a fake where `SELECT 1` returns non-ok →
 * `status: "degraded"` here → `reasons.storage === "unreachable"`, while the coarse
 * `status` still reports. Embeddings off → `reasons.embeddings === "off"`.
 */
export function buildHealthDetail(inputs: HealthDetailInputs): HealthDetail {
	// PRD-062c + PRD-073b: the capture observability sub-block — dropped events (062c) plus the
	// per-reason gated totals (073b). Present when EITHER counter is wired.
	const capture =
		inputs.captureDroppedEvents !== undefined || inputs.captureGated !== undefined
			? {
					droppedEvents: Math.max(0, Math.trunc(inputs.captureDroppedEvents ?? 0)),
					...(inputs.captureGated !== undefined
						? {
								gated: {
									no_bound_project: Math.max(0, Math.trunc(inputs.captureGated.no_bound_project)),
									tenancy_unconfirmed: Math.max(0, Math.trunc(inputs.captureGated.tenancy_unconfirmed)),
								},
							}
						: {}),
				}
			: undefined;
	// PRD-025 honesty: the fine-grained embeddings state, from the live warm/failed signals when the
	// composition root supplies them. Legacy callers (no warm signal) → mirror the coarse enabled/disabled
	// field, so the pre-honesty behavior is preserved verbatim.
	const embeddingsState: EmbeddingsHealth = !inputs.embeddingsEnabled
		? "off"
		: inputs.embeddingsFailed === true
			? "failed"
			: inputs.embeddingsWarm === true
				? "on"
				: inputs.embeddingsWarm === false
					? "warming"
					: "on";
	const reasons: HealthReasons = {
		storage: inputs.status === "ok" ? "reachable" : "unreachable",
		embeddings: inputs.embeddingsEnabled ? "on" : "off",
		embeddingsState,
		schema: inputs.schemaMissingTable === true ? "missing_table" : "ok",
		// PRD-063b / b-AC-7: read the supplied Portkey state verbatim (no probe). Omitted → `off`.
		portkey: inputs.portkey ?? "off",
		// ISS-005: the last observed failure's HTTP status — present ONLY while `unreachable`, so a
		// recovered/off gateway never carries a stale code. Normalized to a non-negative integer.
		...(inputs.portkey === "unreachable" && inputs.portkeyUnreachableStatus !== undefined
			? { portkeyUnreachableStatus: nonNegativeInt(inputs.portkeyUnreachableStatus) }
			: {}),
		...(capture !== undefined ? { capture } : {}),
		// PRD-073b: the dormancy reasons — present ONLY while their condition holds (parent AC-3).
		...(inputs.captureDormantNoProject === true
			? { captureDormant: { code: CAPTURE_DORMANT_NO_PROJECT, guidance: NO_ACTIVE_PROJECT_GUIDANCE } }
			: {}),
		...(inputs.captureTenancyUnconfirmed === true
			? {
					captureTenancyUnconfirmed: {
						code: CAPTURE_BLOCKED_TENANCY_UNCONFIRMED,
						guidance: TENANCY_UNCONFIRMED_GUIDANCE,
					},
				}
			: {}),
		// Memory-formation signal — present only when the composition root wires the tracker. Normalized
		// defensively (non-negative integer count) and surfaced verbatim otherwise.
		...(inputs.memoryFormation !== undefined
			? {
					memoryFormation: {
						committedSinceBoot: Math.max(0, Math.trunc(inputs.memoryFormation.committedSinceBoot)),
						...(inputs.memoryFormation.lastCommittedAt !== undefined
							? { lastCommittedAt: inputs.memoryFormation.lastCommittedAt }
							: {}),
						...(inputs.memoryFormation.lastAction !== undefined
							? { lastAction: inputs.memoryFormation.lastAction }
							: {}),
						// ISS-005 (extraction failure visibility): swallowed extraction model errors since
						// boot, ALWAYS emitted beside committedSinceBoot (a legacy input without it
						// normalizes to 0) so "jobs done, zero memories" is diagnosable at a glance. The
						// last-error string is the stage's capped, key-free reason (a transport status
						// line, never a body/credential) + its timestamp — passthrough when present.
						extractionErrorsSinceBoot: nonNegativeInt(inputs.memoryFormation.extractionErrorsSinceBoot ?? 0),
						...(inputs.memoryFormation.lastExtractionError !== undefined
							? { lastExtractionError: inputs.memoryFormation.lastExtractionError }
							: {}),
						...(inputs.memoryFormation.lastExtractionErrorAt !== undefined
							? { lastExtractionErrorAt: inputs.memoryFormation.lastExtractionErrorAt }
							: {}),
					},
				}
			: {}),
		// PRD-079a: the capture retry outbox backlog — present only when the outbox is wired. Normalized to
		// non-negative integers (a negative/NaN/float input is clamped, so /health never carries a fractional,
		// negative, or `null`-serializing count); carries no secret. `pending > 0` marks a degraded-window backlog.
		...(inputs.captureOutbox !== undefined
			? {
					captureOutbox: {
						pending: nonNegativeInt(inputs.captureOutbox.pending),
						retrying: nonNegativeInt(inputs.captureOutbox.retrying),
						// PRD-079b (b-AC-2): the terminal dead-letter count, always emitted (a legacy input without
						// it normalizes to 0), same non-negative-int normalization as the other two counts.
						deadLettered: nonNegativeInt(inputs.captureOutbox.deadLettered ?? 0),
					},
				}
			: {}),
		// PRD-080a/080b: the controlled-write retry outbox backlog — present only when the outbox is wired.
		// Same non-negative-int normalization as captureOutbox; carries no secret (three counts). `pending > 0`
		// marks a degraded-window backlog of distilled memories awaiting a durable re-commit; `deadLettered > 0`
		// once a row exhausts its bound (b-AC-2, always emitted — a legacy input without it normalizes to 0).
		...(inputs.memoryOutbox !== undefined
			? {
					memoryOutbox: {
						pending: nonNegativeInt(inputs.memoryOutbox.pending),
						retrying: nonNegativeInt(inputs.memoryOutbox.retrying),
						deadLettered: nonNegativeInt(inputs.memoryOutbox.deadLettered ?? 0),
					},
				}
			: {}),
		// The pipeline's queue backend — present only when wired. `shared` is the degraded-coordination signal.
		...(inputs.memoryQueue !== undefined ? { memoryQueue: inputs.memoryQueue } : {}),
		// The memory-formation feature-gating signal — present only when the pipeline worker is wired.
		// `provider` is the closed enum the dashboard gates the "Memory Formation" control on. No secret.
		...(inputs.memory !== undefined
			? {
					memory: {
						enabled: inputs.memory.enabled === true,
						provider: inputs.memory.providerConfigured === true ? "configured" : "unconfigured",
					},
				}
			: {}),
	};
	return { status: inputs.status, reasons };
}

/**
 * Clamp a count to a non-negative integer for the `/health` wire (PRD-079a). A non-finite input
 * (NaN/±Infinity) coerces to 0 — `Math.max(0, Math.trunc(NaN))` is itself `NaN` (which would then
 * serialize to `null`), so the finiteness guard is load-bearing, not cosmetic.
 */
function nonNegativeInt(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Strip `reasons` to the PUBLIC-by-mode body (AC-3 / D-2). In `local` mode the full
 * detail (with `reasons`) is returned — it is the dogfood operator's own loopback
 * daemon. In `team`/`hybrid` the PUBLIC `/health` returns the coarse bit ONLY, so an
 * unauthenticated remote learns up/down but NOT the internal subsystem topology; the
 * full `reasons` live on the PROTECTED `/api/diagnostics/health` surface instead.
 *
 * Keeping the gate as this one named call makes the security-load-bearing decision
 * (no topology leak to an unauthenticated remote) explicit and testable in one place.
 */
export function publicHealthDetail(detail: HealthDetail, mode: string): HealthDetail {
	if (mode === "local") return detail;
	// team / hybrid (and any non-local mode): coarse bit only — drop the reasons block.
	return { status: detail.status };
}
