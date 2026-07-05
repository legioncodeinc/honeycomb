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
 *   - `unreachable`  — an ACTUAL observed runtime failure: a Portkey call could not connect /
 *                      was auth-rejected. Derived ONLY from a cached last-failure signal updated
 *                      when a real call fails — NEVER a synchronous `/health` network probe, and
 *                      never fabricated (b-AC-7).
 */
export type PortkeyHealth = "off" | "ok" | "unconfigured" | "unreachable";

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
	/**
	 * The embed seam state: `off` when embeddings are disabled/no-op, `warming` when ENABLED but the
	 * child embedder has not warmed yet (or crash-looped) — a state in which recall silently falls back
	 * to BM25 — and `on` only when the embedder is enabled AND warm. Reported LIVE per `/health` call so
	 * a stuck/failed embed daemon shows `warming` instead of a misleading `on`.
	 */
	readonly embeddings: "on" | "off" | "warming";
	/** A required table's presence (best-effort): `ok` unless a required table is known-missing. */
	readonly schema: "ok" | "missing_table";
	/** The Portkey gateway state (PRD-063b / b-AC-7): `off` | `ok` | `unconfigured` | `unreachable`. */
	readonly portkey: PortkeyHealth;
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
	 * Whether the wired embedder has WARMED (the child answered + loaded its model). Optional +
	 * backward-compatible: when omitted (an injected-embed test / no supervisor), an enabled embedder
	 * reports `on` as before; when explicitly `false`, an enabled-but-unwarmed embedder reports `warming`.
	 */
	readonly embeddingsWarm?: boolean;
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
	const reasons: HealthReasons = {
		storage: inputs.status === "ok" ? "reachable" : "unreachable",
		embeddings: !inputs.embeddingsEnabled ? "off" : inputs.embeddingsWarm === false ? "warming" : "on",
		schema: inputs.schemaMissingTable === true ? "missing_table" : "ok",
		// PRD-063b / b-AC-7: read the supplied Portkey state verbatim (no probe). Omitted → `off`.
		portkey: inputs.portkey ?? "off",
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
	};
	return { status: inputs.status, reasons };
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
