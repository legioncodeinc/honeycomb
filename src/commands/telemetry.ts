/**
 * `honeycomb telemetry --show` — the glass-box adoption-telemetry verb (PRD-050e e-AC-8).
 *
 * THE TRUST MOVE: render, in plaintext, EXACTLY what this machine has phoned home and EXACTLY what it
 * would send next — sourced from the SAME local `telemetry.sent` log + the SAME allow-listed-payload
 * builder the egress chokepoint uses ({@link buildGlassBoxView} / {@link renderGlassBoxText}). The set
 * the user SEES is provably the set that EGRESSES; there is no second code path that could disagree.
 *
 * ── A `local` verb — never DeepLake, never the daemon ────────────────────────
 * It reads ONLY the machine-local onboarding file (`~/.deeplake/onboarding.json`) and the build-injected
 * ref/version. No storage, no network: this is a glass-box READ of what telemetry would do, not a send.
 * Routed under the `local` class in the dispatcher (mirrors `dashboard`/`status`).
 *
 * ── `--show` (the only subcommand) ───────────────────────────────────────────
 * `honeycomb telemetry --show` (or bare `honeycomb telemetry`) prints the view. Any other tail prints a
 * one-line usage hint and exits 0 (a glass-box verb never errors a flow). The `dir` override threads the
 * onboarding lookup at a temp HOME under test.
 */

import { type CommandResult, type OutputSink } from "./contracts.js";
import { redactLogSecrets } from "@legioncodeinc/cli-kit";
import { type GlassBoxDeps, buildGlassBoxView, renderGlassBoxText } from "../daemon/runtime/telemetry/index.js";
import { DEFAULT_REF, loadOnboarding } from "../daemon/runtime/onboarding/index.js";
import { HONEYCOMB_VERSION } from "../shared/constants.js";

/** The deps the `telemetry` verb runs against — the onboarding `dir` + env override + the load seam. */
export interface TelemetryVerbDeps {
	/** Override the onboarding dir (tests point this at a temp HOME). Defaults to the real `~/.deeplake`. */
	readonly dir?: string;
	/** The env the opt-out gate reads (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). */
	readonly out?: OutputSink;
	/** Human-readable usage-error sink (defaults to `console.error`). */
	readonly err?: OutputSink;
	/** Override the onboarding loader (tests). Defaults to the shared store. */
	readonly loadOnboarding?: GlassBoxDeps["loadOnboarding"];
}

/**
 * Resolve the effective ref the previewed payloads carry: the machine-local `onboarding.ref` if set,
 * else the build-injected {@link DEFAULT_REF}. This mirrors the ref the emit sites carry, so the
 * "would be sent next" preview shows the SAME `ref` the real event would (e-AC-8 fidelity).
 */
function resolveRef(dir: string | undefined, load: GlassBoxDeps["loadOnboarding"]): string {
	const state = (load ?? loadOnboarding)(dir);
	return state.ref.trim().length > 0 ? state.ref : DEFAULT_REF;
}

/**
 * Run `honeycomb telemetry --show` (e-AC-8). Builds the {@link buildGlassBoxView} from the local
 * onboarding state and renders it as plaintext through {@link renderGlassBoxText} — the displayed set is
 * the egress set by construction. Bare `honeycomb telemetry` defaults to `--show`. Always exits 0 (a
 * glass-box read never fails a flow).
 */
export function runTelemetryCommand(
	argv: readonly string[],
	deps: TelemetryVerbDeps = {},
	json = false,
): CommandResult {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const err: OutputSink = deps.err ?? ((line: string): void => console.error(line));

	// Only BARE `telemetry` or a lone `telemetry --show` render the glass box. Anything else — an unknown
	// subcommand (`telemetry foo`), a stray flag (`telemetry --bogus`), or extra tail after `--show`
	// (`telemetry foo --show`) — falls to the usage hint rather than being silently accepted.
	const wantsShow = argv.length === 0 || (argv.length === 1 && argv[0] === "--show");
	if (!wantsShow) {
		const message = "telemetry: expected no arguments or --show.";
		if (json) out(JSON.stringify({ product: "honeycomb", command: "telemetry", ok: false, message }));
		else err(`${message}\nUsage: honeycomb telemetry [--show]`);
		return { exitCode: 2 };
	}

	const glassBoxDeps: GlassBoxDeps = {
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
		...(deps.loadOnboarding !== undefined ? { loadOnboarding: deps.loadOnboarding } : {}),
	};
	let view: ReturnType<typeof buildGlassBoxView>;
	try {
		view = buildGlassBoxView(
			{ ref: resolveRef(deps.dir, deps.loadOnboarding), version: HONEYCOMB_VERSION },
			glassBoxDeps,
		);
	} catch {
		const message = "Honeycomb telemetry state could not be inspected.";
		if (json) out(JSON.stringify({ product: "honeycomb", command: "telemetry", ok: false, message }));
		else err(message);
		return { exitCode: 1 };
	}
	if (json) {
		out(
			JSON.stringify({
				product: "honeycomb",
				command: "telemetry",
				ok: true,
				message: "Honeycomb telemetry state read.",
				state: view.optedOut ? "opted-out" : "enabled",
				controllingSetting: view.optedOut
					? "HONEYCOMB_TELEMETRY or DO_NOT_TRACK"
					: "default enabled; Tier-2 remains opt-in",
				destination: view.optedOut ? "disabled" : "hosted",
				queue: { pending: view.pending.length },
				lastSuccessfulSend: view.sent.at(-1)?.at,
				optOutInstruction: "Set HONEYCOMB_TELEMETRY=0 or DO_NOT_TRACK=1",
			}),
		);
	} else {
		// The onboarding ledger is local but mutable; strip terminal controls and credential-shaped
		// values before rendering it into a trusted terminal.
		out(redactLogSecrets(renderGlassBoxText(view)));
	}
	return { exitCode: 0 };
}
