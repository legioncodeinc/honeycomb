/**
 * The glass-box telemetry view — PRD-050e (e-AC-8). The decisive trust move for a memory tool: render,
 * in plaintext, EXACTLY what has left the machine and EXACTLY what would leave next, sourced from the
 * SAME local `telemetry.sent` log + the SAME {@link buildAllowedProperties} the egress chokepoint uses —
 * so the displayed set is PROVABLY the egress set (no second code path can disagree).
 *
 * ── Why this composes a DATA SOURCE, not just a string ───────────────────────
 * `buildGlassBoxView(...)` returns a structured {@link GlassBoxView}: the `sent` records (what HAS been
 * sent) and the `pending` allow-listed payloads (what WOULD be sent next — the un-reported Tier-1 events
 * built through the chokepoint's own builder). `renderGlassBoxText(...)` formats that view as plaintext for
 * `honeycomb telemetry --show`; a later dashboard panel reads the SAME {@link GlassBoxView} (e-AC-8's "and a
 * dashboard panel can read later"). One source, two renderers — they cannot drift.
 *
 * ── Sourced from the SAME builder (the proof) ────────────────────────────────
 * The "would be sent next" rows are produced by {@link buildAllowedProperties} — the identical function
 * `emitTelemetry` calls — so a field that would NOT egress cannot appear here, and a field that WOULD
 * egress cannot be hidden here. That identity is what makes "here is literally everything we phone home"
 * a guarantee rather than a claim.
 */

import {
	type AllowedProperties,
	type TelemetryTier,
	buildAllowedProperties,
	isOptedOut,
	tierForEvent,
} from "./emit.js";
import {
	type OnboardingState,
	type TelemetryEventName,
	type TelemetrySentRecord,
	isReported,
	loadOnboarding,
} from "../onboarding/index.js";

/** The Tier-1 lifecycle events whose "would be sent next" payloads the glass-box previews when un-reported. */
const PREVIEWABLE_TIER1: readonly TelemetryEventName[] = [
	"honeycomb_installed",
	"honeycomb_first_link",
	"honeycomb_hivemind_upgrade",
];

/** One "would be sent next" row — the event + the EXACT allow-listed payload the chokepoint would build. */
export interface PendingTelemetryRow {
	/** The event that would be sent on its next lifecycle trigger. */
	readonly event: TelemetryEventName;
	/** The consent tier the event rides. */
	readonly tier: TelemetryTier;
	/** The allow-listed payload — built through {@link buildAllowedProperties}, identical to egress. */
	readonly properties: AllowedProperties;
}

/**
 * The structured glass-box view (e-AC-8) — the SINGLE data source both the CLI text and a future dashboard
 * panel render. `sent` is what HAS left the machine (the append-only audit log); `pending` is what WOULD
 * leave next (the un-reported Tier-1 events' allow-listed payloads). `optedOut`/`optInTier2` surface the
 * consent state so the view can explain WHY a row is or isn't pending.
 */
export interface GlassBoxView {
	/** True when an opt-out env var is set — nothing would be sent regardless of `pending`. */
	readonly optedOut: boolean;
	/** The Tier-2 consent flag (Tier-2 rows are only ever pending when this is true). */
	readonly optInTier2: boolean;
	/** The anonymized distinct_id (the random installId) every event would carry (e-AC-6). */
	readonly distinctId: string;
	/** What HAS been sent — the append-only glass-box log, verbatim. */
	readonly sent: readonly TelemetrySentRecord[];
	/** What WOULD be sent next — the un-reported lifecycle events' allow-listed payloads. */
	readonly pending: readonly PendingTelemetryRow[];
}

/** Inputs for {@link buildGlassBoxView} — the effective ref + build version that the payloads carry. */
export interface GlassBoxInputs {
	/** The effective referral code the previewed payloads carry (mirrors the emit `ref`). */
	readonly ref: string;
	/** The build version the previewed payloads carry. */
	readonly version: string;
	/** The harness/source enum, when known. */
	readonly sourceTool?: string;
}

/** Injectable deps for {@link buildGlassBoxView} (load + opt-out env + dir override) — all defaulted. */
export interface GlassBoxDeps {
	readonly loadOnboarding?: (dir?: string) => OnboardingState;
	readonly dir?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the {@link GlassBoxView} (e-AC-8). Reads the onboarding `telemetry.sent` log for what HAS been
 * sent, then computes `pending` = the Tier-1 lifecycle events NOT yet in the `reported` ledger, each with
 * the allow-listed payload {@link buildAllowedProperties} would produce — so `displayed ≡ egress`. A
 * Tier-2 event is previewed as pending ONLY when `optInTier2` is set (mirroring the emit gate); under
 * opt-out NOTHING is pending. Pure beyond the injected `loadOnboarding`.
 */
export function buildGlassBoxView(inputs: GlassBoxInputs, deps: GlassBoxDeps = {}): GlassBoxView {
	const load = deps.loadOnboarding ?? loadOnboarding;
	const env = deps.env ?? process.env;
	const state = load(deps.dir);
	const optedOut = isOptedOut(env);

	const pending: PendingTelemetryRow[] = [];
	if (!optedOut) {
		for (const event of PREVIEWABLE_TIER1) {
			if (isReported(state, event)) continue; // already sent → it lives in `sent`, not `pending`.
			const tier = tierForEvent(event);
			// Tier-2 rows only preview when consented (mirrors emitTelemetry's gate). The three named
			// lifecycle events are all Tier-1, so this is a forward-compatible guard for future Tier-2 names.
			if (tier === "tier2" && state.telemetry.optInTier2 !== true) continue;
			const properties = buildAllowedProperties({
				ref: inputs.ref,
				tier,
				version: inputs.version,
				...(inputs.sourceTool !== undefined ? { sourceTool: inputs.sourceTool } : {}),
			});
			pending.push({ event, tier, properties });
		}
	}

	return {
		optedOut,
		optInTier2: state.telemetry.optInTier2,
		distinctId: state.installId,
		sent: state.telemetry.sent,
		pending,
	};
}

/** Format one allow-listed payload as a compact, sorted `key=value` line (deterministic ordering). */
function formatProps(properties: AllowedProperties): string {
	const pairs = Object.entries(properties)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${String(v)}`);
	return pairs.length > 0 ? pairs.join(" ") : "(no properties)";
}

/**
 * Render the {@link GlassBoxView} as plaintext for `honeycomb telemetry --show` (e-AC-8). Prints the
 * anonymized distinct_id, the consent state, the SENT log (what HAS left the machine), and the PENDING
 * rows (what WOULD leave next) — every payload via {@link formatProps}, so a reader sees the exact bytes.
 * No secret, no content: by construction the only fields present are allow-listed.
 */
export function renderGlassBoxText(view: GlassBoxView): string {
	const lines: string[] = [];
	lines.push("Honeycomb telemetry — glass box (everything this machine has phoned home, and what it would send next).");
	lines.push("");
	lines.push(`anonymized id (distinct_id): ${view.distinctId}`);
	lines.push(`Tier-2 usage telemetry: ${view.optInTier2 ? "opted IN" : "off (opt-in)"}`);
	if (view.optedOut) {
		lines.push("status: OPTED OUT (HONEYCOMB_TELEMETRY=0 or DO_NOT_TRACK set) — nothing is sent.");
	}
	lines.push("");

	lines.push(`ALREADY SENT (${view.sent.length}):`);
	if (view.sent.length === 0) {
		lines.push("  (nothing has been sent from this machine)");
	} else {
		for (const record of view.sent) {
			lines.push(`  • ${record.event} @ ${record.at}`);
			lines.push(`      ${formatProps(record.properties as AllowedProperties)}`);
		}
	}
	lines.push("");

	lines.push(`WOULD SEND NEXT (${view.pending.length}):`);
	if (view.pending.length === 0) {
		lines.push(view.optedOut ? "  (opted out — nothing would be sent)" : "  (every lifecycle event has already been reported)");
	} else {
		for (const row of view.pending) {
			lines.push(`  • ${row.event} [${row.tier}]`);
			lines.push(`      ${formatProps(row.properties)}`);
		}
	}
	lines.push("");
	lines.push("To disable all telemetry: set HONEYCOMB_TELEMETRY=0 or DO_NOT_TRACK=1.");
	return lines.join("\n");
}
