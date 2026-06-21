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
 * A per-subsystem coarse state (PRD-029). `ok` is the healthy state; the down state is
 * named per subsystem in {@link HealthReasons}. Kept as a closed enum so a reason can
 * never carry a free-form (secret-bearing) string.
 */
export type SubsystemState = "ok" | "degraded";

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
	/** A required table's presence (best-effort): `ok` unless a required table is known-missing. */
	readonly schema: "ok" | "missing_table";
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
	 * Whether a REQUIRED table is known-missing (best-effort). Defaults to `false`
	 * (→ `schema: "ok"`) — the conservative posture when there is no cheap signal at the
	 * health seam. A caller with a real known-missing signal passes `true`.
	 */
	readonly schemaMissingTable?: boolean;
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
	const reasons: HealthReasons = {
		storage: inputs.status === "ok" ? "reachable" : "unreachable",
		embeddings: inputs.embeddingsEnabled ? "on" : "off",
		schema: inputs.schemaMissingTable === true ? "missing_table" : "ok",
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
