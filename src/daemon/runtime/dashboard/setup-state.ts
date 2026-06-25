/**
 * The pre-auth guided-setup STATE read — PRD-050b (b-AC-2 / b-AC-6).
 *
 * `GET /setup/state` is the loopback, local-mode-only read the dashboard's guided-setup shell
 * polls to decide WHICH setup state to render (fresh-install vs has-prior-tool vs already-linked)
 * and to drive the live pre-auth → authenticated transition (b-AC-3) without a restart. It sits
 * BESIDE {@link import("./host.js").mountDashboardHost} + {@link import("./setup-login.js").mountSetupLogin}
 * on the UNPROTECTED root group, so the composition root fires it under the SAME `mode === "local"`
 * gate (security F-1): in team/hybrid the route is never mounted (b-AC-4).
 *
 * ── The response contract (b-AC-2) — KEEP EXTENSIBLE (050d extends it) ───────
 * The body is install/onboarding METADATA only — it carries NO token, NO secret, NO PII (the
 * onboarding file holds none, and we never read the credential VALUE here, only its PRESENCE):
 *
 *   {
 *     credentials: { deeplake: boolean, honeycomb: boolean, hivemind: boolean },
 *     phase: OnboardingState["phase"],
 *     priorTool: { hivemind: "absent" | "present" | "migrated" },
 *     firstTimeSetupComplete: boolean,
 *     authenticated: boolean,          // derived: a VALID credential loads (not the onboarding hint)
 *     warmup: { enabled, live, warm }  // the embeddings warmup signal (b-AC-5, observability)
 *   }
 *
 * NOTE (050d): this sub-PRD EXTENDS the prior-tool / migration fields additively — it adds a
 * `migration` block (the durable crash-recovery marker, d-AC-7) and DERIVES `priorTool.hivemind`
 * from the `~/.hivemind` directory presence when the onboarding file has not yet recorded a
 * migration (d-AC-1). The shape stays a flat, additive object so these fields land WITHOUT breaking
 * the 050b contract — clients read named fields and tolerate unknown ones.
 *
 * ── Phase is DERIVED, not trusted-as-truth (the parent's stale-state guard) ──
 * `authenticated` is computed from whether a VALID credential loads ({@link loadCredentials} returns
 * non-null), NEVER from the onboarding file. The onboarding `phase` is a HINT for which wizard copy
 * to show; it can disagree with the credential (a half-written file), so it never decides auth. This
 * is what lets the dashboard flip from the guided-setup state to the authenticated state the instant
 * the credential lands, even if the onboarding file still says `"linking"`.
 *
 * ── Fail-soft on a missing/malformed onboarding file (b-AC-2) ────────────────
 * {@link loadOnboarding} already returns a fully-defaulted fresh-install state on a missing OR
 * malformed (zod-rejected) file — never a throw — so a corrupt `onboarding.json` reports a clean
 * fresh-install state here rather than a 500. The credential-presence probes are `existsSync` on the
 * three known dirs (no parse, no read of contents), so a malformed credentials file still reports
 * `deeplake: true` (the file is present) while `authenticated` honestly reports `false`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context, Hono } from "hono";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import type { EmbedSupervisor } from "../services/embed-supervisor.js";
import { CREDENTIALS_DIR_NAME, LEGACY_CREDENTIALS_DIR_NAME, loadCredentials } from "../auth/credentials-store.js";
import { type OnboardingState, loadOnboarding } from "../onboarding/index.js";

/** The loopback route the guided-setup shell GETs its state from (PRD-050b). */
export const SETUP_STATE_PATH = "/setup/state" as const;

/** The root route group the setup-state read attaches to (already mounted, UNPROTECTED, in `server.ts`). */
export const SETUP_STATE_GROUP = "/" as const;

/**
 * The SHARED Hivemind credentials directory name under the user's home. Hivemind and Honeycomb
 * share `~/.deeplake` (the credential file), but a LEGACY Hivemind install may still have a
 * `~/.hivemind` directory — its presence is a prior-tool signal 050d's migration path keys off.
 * Defined here (additively) so 050b can REPORT it without depending on 050d.
 */
export const HIVEMIND_DIR_NAME = ".hivemind" as const;

/**
 * The per-tool credential/state directory presences (b-AC-2). Each is a plain `existsSync` on the
 * known home-relative dir — NO file is parsed or read, so a malformed credentials file still reports
 * its directory as present (the honest "the dir exists" signal, distinct from `authenticated`).
 */
export interface SetupCredentialsPresence {
	/** `~/.deeplake` present (the shared Honeycomb+Hivemind credential dir). */
	readonly deeplake: boolean;
	/** `~/.honeycomb` present (the legacy Honeycomb credential/runtime dir). */
	readonly honeycomb: boolean;
	/** `~/.hivemind` present (a legacy Hivemind install — a prior-tool signal for 050d). */
	readonly hivemind: boolean;
}

/**
 * The embeddings warmup signal (b-AC-5, observability). The dashboard + login NEVER wait on the
 * model; this reports — without blocking — whether the warmup is enabled, the child is live, and the
 * model has finished warming. Until `warm` is true, recall degrades to the lexical fallback (the
 * supervisor backgrounds the warm wait; this is a pure read of its already-tracked state).
 */
export interface SetupWarmupState {
	/** True when embeddings are enabled (NOT explicitly opted out via `HONEYCOMB_EMBEDDINGS=false`/`0`). */
	readonly enabled: boolean;
	/** True once the embed child has answered `/health` (liveness) — it is up but maybe not warm. */
	readonly live: boolean;
	/** True once the model finished warming; until then recall is lexical-fallback (never a hang). */
	readonly warm: boolean;
}

/**
 * The `GET /setup/state` body (b-AC-2). Install/onboarding metadata ONLY — no token, no secret, no
 * PII. `authenticated` is DERIVED from a valid credential load (the source of truth for auth),
 * while `phase`/`priorTool`/`firstTimeSetupComplete` are the onboarding HINTS for the wizard copy.
 * Kept a flat, additive shape so 050d extends it without a breaking change.
 */
export interface SetupStateBody {
	/** Per-tool directory presence (the three known credential/state dirs). */
	readonly credentials: SetupCredentialsPresence;
	/** The onboarding lifecycle phase (a HINT for the wizard copy, never the auth source of truth). */
	readonly phase: OnboardingState["phase"];
	/**
	 * Prior-tool detection (d-AC-1). DERIVED: the onboarding file's recorded value wins (a completed
	 * migration reports `"migrated"`; an in-flight one keeps whatever was stamped), but when the file
	 * still says `"absent"` AND `~/.hivemind` exists on disk, this reports `"present"` so the dashboard
	 * renders the coexistence-warning wizard rather than the plain first-time state. A `"migrated"` /
	 * `"present"` already-recorded value is honored verbatim (never downgraded by the dir probe).
	 */
	readonly priorTool: OnboardingState["priorTool"];
	/** True once the first-time guided setup has completed (the onboarding flag). */
	readonly firstTimeSetupComplete: boolean;
	/** DERIVED: a VALID credential loads. THIS — not `phase` — decides authenticated vs guided-setup. */
	readonly authenticated: boolean;
	/** The embeddings warmup signal (b-AC-5) — observable, never blocking. */
	readonly warmup: SetupWarmupState;
	/**
	 * The Hivemind→Honeycomb migration marker (d-AC-7), present ONLY while a migration is in flight or
	 * has reached a terminal state. A NON-TERMINAL phase (`backup`/`uninstall`/`link`) means a migration
	 * was interrupted — the dashboard offers RESUME or ROLL BACK rather than presenting a clean state.
	 * Absent on a machine that never migrated. Reported verbatim from the onboarding marker (no secret).
	 */
	readonly migration?: OnboardingState["migration"];
}

/** Deps for {@link mountSetupStateApi} / {@link resolveSetupState}. Everything injected for testability. */
export interface SetupStateApiDeps {
	/**
	 * The home directory override (tests point this at a temp HOME so the three dir probes + the
	 * onboarding/credentials reads never touch the real `~`). Absent → the real {@link homedir}.
	 */
	readonly homeDir?: string;
	/**
	 * The credentials directory override threaded into {@link loadCredentials} (tests). When set it is
	 * the `~/.deeplake`-equivalent the credential VALIDITY read uses; absent → the real shared dir.
	 */
	readonly credentialsDir?: string;
	/**
	 * The onboarding directory override threaded into {@link loadOnboarding} (tests). Absent → the
	 * real `~/.deeplake`.
	 */
	readonly onboardingDir?: string;
	/** The env the `HONEYCOMB_TOKEN` rule reads (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The embed supervisor whose warmup state is reported (b-AC-5). Absent → a disabled/zeroed warmup
	 * signal (the assembly threads the daemon's real supervisor; a test injects a fake or omits it).
	 */
	readonly embed?: EmbedSupervisor;
}

/** Probe the three known credential/state directories under the (possibly overridden) home. */
function probeCredentialDirs(home: string): SetupCredentialsPresence {
	return {
		deeplake: existsSync(join(home, CREDENTIALS_DIR_NAME)),
		honeycomb: existsSync(join(home, LEGACY_CREDENTIALS_DIR_NAME)),
		hivemind: existsSync(join(home, HIVEMIND_DIR_NAME)),
	};
}

/** Read the embed supervisor's already-tracked warmup state, or a disabled/zeroed signal when absent. */
function resolveWarmup(embed: EmbedSupervisor | undefined): SetupWarmupState {
	if (embed === undefined) return { enabled: false, live: false, warm: false };
	return { enabled: !embed.disabled, live: embed.live, warm: embed.warm };
}

/**
 * Derive the prior-tool flag (d-AC-1). The onboarding file's RECORDED value is authoritative when it is
 * anything other than `"absent"` (a completed migration's `"migrated"` or an explicitly-stamped
 * `"present"` is honored verbatim — the dir probe never downgrades it). When the file still reads
 * `"absent"` but a `~/.hivemind` directory exists on disk, we report `"present"` so the dashboard renders
 * the coexistence-warning wizard. This is the "folder present + not ours → likely Hivemind" interpretation
 * the PRD adds on top of 050b's raw dir probe — pure (a single `existsSync`), no write, no side effect.
 */
function derivePriorTool(
	recorded: OnboardingState["priorTool"],
	hivemindDirPresent: boolean,
): OnboardingState["priorTool"] {
	if (recorded.hivemind !== "absent") return recorded;
	return hivemindDirPresent ? { hivemind: "present" } : recorded;
}

/**
 * Resolve the {@link SetupStateBody} from the onboarding file + the credential presence + the
 * embed warmup state (b-AC-2). Pure-ish: its only IO is `existsSync` on three dirs plus the two
 * fail-soft loaders (neither throws), so this never throws.
 *
 * `authenticated` is `loadCredentials(...) !== null` — a VALID credential (token + org present)
 * resolves — NOT the onboarding `phase`. A missing/malformed credential reads `authenticated:false`
 * even if the `~/.deeplake` directory exists (the dir-presence and the credential-validity signals
 * are reported INDEPENDENTLY, by design).
 */
export function resolveSetupState(deps: SetupStateApiDeps = {}): SetupStateBody {
	const home = deps.homeDir ?? homedir();
	const env = deps.env ?? process.env;

	// Onboarding HINTS (fail-soft → fresh-install defaults on a missing/malformed file, b-AC-2).
	const onboarding = loadOnboarding(deps.onboardingDir);

	// AUTH SOURCE OF TRUTH: a valid credential loads. `loadCredentials` returns null on a
	// missing/malformed file (never throws) and applies the `HONEYCOMB_TOKEN` env rule.
	const authenticated = loadCredentials(deps.credentialsDir, env) !== null;

	const credentials = probeCredentialDirs(home);
	// d-AC-1: the prior-tool flag is DERIVED — the onboarding record wins, but an `absent` record with a
	// `~/.hivemind` dir present reads `present` so the coexistence-warning wizard renders.
	const priorTool = derivePriorTool(onboarding.priorTool, credentials.hivemind);

	return {
		credentials,
		phase: onboarding.phase,
		priorTool,
		firstTimeSetupComplete: onboarding.firstTimeSetupComplete,
		authenticated,
		warmup: resolveWarmup(deps.embed),
		// d-AC-7: surface the durable migration marker verbatim (present only when a migration is in
		// flight or terminal). A non-terminal phase drives the dashboard's resume/rollback affordance.
		...(onboarding.migration !== undefined ? { migration: onboarding.migration } : {}),
	};
}

/**
 * Mount `GET /setup/state` onto a route group (PRD-050b). GATED to `local` mode: a non-local request
 * yields a clean 404 (`{ error: "not_found" }`) — the guided-setup surface is a local-mode loopback
 * surface only (b-AC-4), so there is no team/hybrid setup state to serve. Mirrors the local-mode
 * gate `mountAuthStatusGroup` / `mountDashboardHost` / `mountSetupLogin` use.
 */
export function mountSetupStateGroup(group: Hono, mode: DeploymentMode, deps: SetupStateApiDeps = {}): void {
	group.get(SETUP_STATE_PATH, (c: Context) => {
		// b-AC-4: the setup endpoints are unreachable outside local mode. A 404 (not a redacted 200)
		// makes the route INDISTINGUISHABLE from an unmounted path to a team/hybrid caller.
		if (mode !== "local") return c.json({ error: "not_found" }, 404);
		return c.json(resolveSetupState(deps));
	});
}

/**
 * Attach the `GET /setup/state` route onto the daemon's already-mounted root group (PRD-050b). Call
 * ONCE after `createDaemon(...)`; the composition root fires it LOCAL-MODE ONLY (mirroring
 * `mountSetupLogin` / `mountDashboardHost`). If the root group is not mounted the attach is a no-op.
 *
 * The daemon's real embed supervisor is threaded in for the warmup signal (b-AC-5); a test injects a
 * fake supervisor (or omits it) and a temp HOME via {@link SetupStateApiDeps}.
 */
export function mountSetupStateApi(daemon: Daemon, deps: SetupStateApiDeps = {}): void {
	const group = daemon.group(SETUP_STATE_GROUP);
	if (group === undefined) return;
	mountSetupStateGroup(group, daemon.config.mode, deps);
}
