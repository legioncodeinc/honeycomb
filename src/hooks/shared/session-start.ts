/**
 * Session-start core — PRD-019b Wave 2 (FR-3 / b-AC-3).
 *
 * Session-start runs, in order (FR-3): load credentials (prompt login or continue
 * read-only by harness policy), `healDriftedOrgToken`, `autoUpdate`, ensure the
 * `memory` and `sessions` tables, write a placeholder summary row, render the
 * rules/goals context block, `autoPullSkills`, spawn the graph-pull worker, and
 * return `additionalContext`. Steps 4 and 5 (table-ensure + placeholder) are gated
 * on `HONEYCOMB_CAPTURE !== "false"` — REUSE `src/shared/capture-gate.ts`, never
 * re-implement the gate here.
 *
 * THIN CLIENT: every storage-touching step (table-ensure, placeholder, context)
 * is a daemon call through the injected seams ({@link HookCoreDeps.daemon} for the
 * context block; {@link SessionStartSeams} for ensure/placeholder, whose real impls
 * POST to the daemon); this module opens NO DeepLake and builds NO SQL (b-AC-2 / D-2).
 *
 * The heal/update/pull steps already exist from prior PRDs — session-start CALLS
 * them through {@link SessionStartSeams}, it does NOT reimplement them. Every step is
 * FAIL-SOFT: a step that throws is absorbed (FR-10) so a heal/update/pull failure
 * never breaks session-start; the lifecycle still returns its `additionalContext`.
 */

import { shouldCapture } from "../../shared/capture-gate.js";
import {
	createNoopSessionStartSeams,
	type HookCredential,
	type HookInput,
	type HookResult,
	type HookSessionMeta,
	type OnboardingNoticeGate,
	type SessionStartDeps,
	type SessionStartSeams,
} from "./contracts.js";
import { hasBoundProjectOnDisk, resolveScopeFromDisk } from "./project-resolver.js";

/**
 * The single, quiet "bind a project to start" notice (PRD-059a a-AC-2 / IRD-123). Rendered ONCE per
 * session at session-start (the session-start seam, NOT per turn) when the workspace has bound no
 * project yet, so a brand-new user learns capture is paused until they pick a folder. Plain prose, no
 * secret, no path — the actionable next step (the dashboard "Pick a folder to start" CTA or the CLI
 * `honeycomb project bind`).
 */
export const BIND_PROJECT_NOTICE =
	"Honeycomb is paused: no project is bound to this workspace yet, so nothing is being captured. " +
	'Bind a folder to start: open the Honeycomb dashboard and pick a folder, or run "honeycomb project bind" in the folder you want Honeycomb to remember.';

/**
 * The PRD-073b cwd-specific variant of {@link BIND_PROJECT_NOTICE}. Rendered once per session when
 * THIS session's cwd is unbound (the per-session gate, inbox opt-in off) even though the workspace
 * already has OTHER bound projects, so the user learns capture is paused FOR THIS FOLDER specifically.
 * Plain prose, no secret, no path.
 */
export const BIND_PROJECT_CWD_NOTICE =
	"Honeycomb is paused for this folder: it is not bound to a project, so nothing is being captured here. " +
	'Bind it to start: open the Honeycomb dashboard and pick this folder, or run "honeycomb project bind" in it.';

/** The env flag the per-session notice gate reads to suppress itself when the inbox opt-in is ON. */
const INBOX_CAPTURE_ENV_KEY = "HONEYCOMB_INBOX_CAPTURE" as const;

/**
 * The one-shot, per-session recall-awareness notice (PRD-075c c-AC-1). The `PreToolUse` recall
 * surface (075a/075b) is model-commanded, not always-on: a capability the model does not know
 * about goes unused, so this notice names the `honeycomb recall "<query>"` command explicitly.
 * A CONSTANT, not a rendered call: it cannot throw, and it is appended UNCONDITIONALLY to every
 * session-start's `additionalContext` (c-AC-2, c-AC-3) alongside the existing notice/context/prime
 * blocks, never replacing them. Terse and imperative on purpose: it competes for attention and
 * decays as the turn's context grows.
 */
export const RECALL_AWARENESS_NOTICE =
	"Memory recall is available on demand: you have a searchable memory of past sessions. " +
	'To recall it mid task, run honeycomb recall "<what you are looking for>": the result comes ' +
	"back as the command's output. Reach for it before asking the user to re-explain prior " +
	"context, decisions, or where something lives. It costs nothing on turns you do not use it.";

/**
 * The default production {@link OnboardingNoticeGate}: read the thin-client `~/.deeplake/projects.json`
 * cache and report whether the active workspace has ≥1 locally-bound project, with NO DeepLake call
 * (a-AC-3). FAIL-SOFT: a throw reads as "has a bound project" (notice SUPPRESSED) so the notice never
 * appears spuriously and never breaks session-start. `dir` overrides the cache directory (tests).
 */
export function createOnboardingNoticeGate(dir?: string): OnboardingNoticeGate {
	return {
		hasBoundProject(_meta: HookSessionMeta, credential: HookCredential | undefined): boolean {
			// The notice is for a LOGGED-IN user who has not yet bound a project — `honeycomb login`
			// precedes "bind a project to start". When no credential/token is resolved (not logged in),
			// report "bound" so NO notice appears (login, not bind, is the next step). This also keeps a
			// not-logged-in / hermetic test from seeing the notice via the real `~/.deeplake` read.
			if (credential === undefined || credential.token === undefined || credential.token.length === 0) {
				return true;
			}
			try {
				return hasBoundProjectOnDisk({
					...(credential.workspace !== undefined ? { workspace: credential.workspace } : {}),
					...(dir !== undefined ? { dir } : {}),
				});
			} catch {
				// Fail-soft: never show the notice (or break session-start) because the local read hiccuped.
				return true;
			}
		},
	};
}

/**
 * The PRD-073b PER-SESSION bind-notice gate: the default production notice gate. Unlike the 059a
 * workspace-level {@link createOnboardingNoticeGate}, this resolves THIS session's cwd and shows a
 * notice whenever the cwd is unbound (inbox opt-in off) even after other projects are bound — so a
 * session in an unbound folder is never silently dormant. Reads the thin-client
 * `~/.deeplake/projects.json` cache with NO DeepLake call (a-AC-3) and is FAIL-SOFT (a throw shows
 * nothing). `dir` overrides the cache directory; `env` overrides the inbox-flag source (tests).
 */
export function createSessionBindNoticeGate(
	opts: { readonly dir?: string; readonly env?: NodeJS.ProcessEnv } = {},
): OnboardingNoticeGate {
	const dir = opts.dir;
	const env = opts.env ?? process.env;
	// INTENTIONAL duplication of the daemon's `resolveInboxCaptureEnabled` truthy set ("true"/"1"): the
	// hooks tier must not import daemon runtime modules (thin-client tier direction), so the parse is
	// mirrored here; if the daemon's BoolFlag set ever widens, hoist the shared parse into `src/shared`.
	const inboxOn =
		(env[INBOX_CAPTURE_ENV_KEY] ?? "").trim() === "true" || (env[INBOX_CAPTURE_ENV_KEY] ?? "").trim() === "1";
	return {
		hasBoundProject(meta: HookSessionMeta, credential: HookCredential | undefined): boolean {
			return resolveNotice(meta, credential, dir, inboxOn) === null;
		},
		noticeText(meta: HookSessionMeta, credential: HookCredential | undefined): string | null {
			return resolveNotice(meta, credential, dir, inboxOn);
		},
	};
}

/**
 * The per-session notice decision (PRD-073b). Returns the notice TEXT to show, or `null` to show
 * nothing. Suppressed when: not logged in (login precedes bind), the inbox opt-in is ON (unbound
 * folders are inboxed, not dormant), or THIS cwd resolves to a bound project. Otherwise shows the
 * cwd-specific copy when the workspace has OTHER bound projects, else the workspace-level copy (a
 * genuinely fresh install). FAIL-SOFT: any throw returns `null` (never break session-start).
 */
function resolveNotice(
	meta: HookSessionMeta,
	credential: HookCredential | undefined,
	dir: string | undefined,
	inboxOn: boolean,
): string | null {
	if (credential === undefined || credential.token === undefined || credential.token.length === 0) return null;
	if (inboxOn) return null;
	try {
		const cwd = meta.cwd;
		if (cwd !== undefined && cwd.trim().length > 0) {
			const resolved = resolveScopeFromDisk({
				cwd,
				...(credential.org !== undefined ? { org: credential.org } : {}),
				...(credential.workspace !== undefined ? { workspace: credential.workspace } : {}),
				...(dir !== undefined ? { dir } : {}),
			});
			if (resolved.bound) return null; // this session is captured — no notice.
		}
		const workspaceHasBinding = hasBoundProjectOnDisk({
			...(credential.workspace !== undefined ? { workspace: credential.workspace } : {}),
			...(dir !== undefined ? { dir } : {}),
		});
		return workspaceHasBinding ? BIND_PROJECT_CWD_NOTICE : BIND_PROJECT_NOTICE;
	} catch {
		return null;
	}
}

/**
 * Run the session-start lifecycle (FR-3 / b-AC-3). Returns the {@link HookResult}
 * carrying the rendered `additionalContext` block; the shim routes it through its
 * harness's context channel (019c).
 *
 * Order (FR-3): credentials → heal → autoUpdate → [gated] ensureTables →
 * [gated] placeholder → render context → autoPullSkills → spawn graph-pull →
 * return `additionalContext`. The two gated steps run ONLY when the capture gate
 * says capture (`HONEYCOMB_CAPTURE !== "false"`); when capture is off, the tables
 * are not ensured and no placeholder row is written, but the context block STILL
 * renders (read-only) and is returned — recall is never disabled by the gate.
 */
export async function runSessionStart(input: HookInput, deps: SessionStartDeps): Promise<HookResult> {
	const seams: SessionStartSeams = deps.seams ?? createNoopSessionStartSeams();
	const meta = input.meta;

	// Step 1: load credentials (presence decides login-vs-read-only; never logged).
	const credential = await safe(() => deps.credentials.read(), undefined);

	// Step 2: reconcile a drifted org token. Fail-soft.
	await safeVoid(() => seams.healDriftedOrgToken(credential));

	// Step 3: self-update if a newer plugin exists. Fail-soft.
	await safeVoid(() => seams.autoUpdate());

	// Steps 4 + 5: table-ensure + placeholder — GATED on the capture gate (FR-3). The
	// gate is the pure `shouldCapture`; we only consult `captureFlag` here (plugin /
	// entrypoint / recursion are capture-path concerns). When capture is off, neither
	// step runs and NO `sessions`/`memory` write happens.
	const captureOn = shouldCapture({ captureFlag: deps.captureEnv?.captureFlag }).capture;
	if (captureOn) {
		await safeVoid(() => seams.ensureTables(meta));
		await safeVoid(() => seams.writePlaceholderSummary(meta));
	}

	// Step 6: render the rules/goals context block (READ-ONLY, fail-soft — the
	// renderer absorbs its own errors and returns "" on failure, FR-10).
	const contextBlock = await safe(() => deps.context.render({ meta, runtimePath: input.runtimePath, credential }), "");

	// Step 6.5 (PRD-046d / d-AC-1..5): fetch the session-start memory prime ONCE
	// (d-AC-3 — this is the session-start branch; per-turn capture never primes) and
	// append it to the context block. READ-ONLY + fail-soft: the renderer absorbs its
	// own errors and a cold (`empty:true`) repo yields "", so an unreachable daemon or
	// an empty scope contributes NOTHING and never blocks/errors session-start (d-AC-4).
	// The hook does NO assembly — it injects 046c's already-bounded digest verbatim
	// (d-AC-5). When no prime seam is wired, this is a no-op (prior behaviour unchanged).
	const primeBlock =
		deps.prime !== undefined
			? await safe(
					() =>
						(deps.prime as NonNullable<typeof deps.prime>).render({ meta, runtimePath: input.runtimePath, credential }),
					"",
				)
			: "";

	// PRD-059a / IRD-123 (a-AC-2): the once-per-session "bind a project to start" notice. When the
	// onboarding-notice gate is wired AND the workspace has bound no project yet, prepend the single
	// notice so a brand-new user learns capture is paused until they pick a folder. This runs at
	// SESSION-START only (not per turn). FAIL-SOFT: the gate's own try/catch absorbs a read error
	// (no notice), and the whole step is wrapped so it can never break session-start.
	const noticeBlock = await safe(
		() => Promise.resolve(renderOnboardingNotice(deps.onboardingNotice, meta, credential)),
		"",
	);

	// The injected `additionalContext` composes the first-run notice, the rendered rules/goals
	// block, the prime digest, and the recall-awareness notice (PRD-075c c-AC-1/c-AC-2), joined
	// when present so none is lost. Any block alone is returned as-is; all empty (INCLUDING the
	// recall notice, hypothetically) omits `additionalContext` entirely (c-AC-3). The first-run
	// notice leads so it is the first thing the user sees; the recall-awareness notice trails as
	// a standing reminder, appended after the situational content, never replacing it.
	const additionalContext = joinBlocks(noticeBlock, contextBlock, primeBlock, RECALL_AWARENESS_NOTICE);

	// Steps 7, 7b, 8: side-effecting hygiene pulls (skills, assets, graph). These do NOT touch
	// `additionalContext` — they are background hygiene, not recall. Measured on a warm daemon
	// the skills pull alone takes ~5s (its own loopback POST budget) and the assets pull ~3s.
	//
	// TWO EXECUTION MODES:
	//
	// 1. OFF-PROCESS (preferred when `deps.spawnHygieneChild` is supplied — the harness shim
	//    implements `HarnessShim.spawnHygieneChild`). Call the shim's spawn, which forks a
	//    DETACHED + `unref()`'d child to run the three pulls in its OWN process. The parent
	//    does NO hygiene I/O, so its event loop empties and Node exits naturally in
	//    milliseconds after the response is written. This is the latency-budget fix: the
	//    parent's wall clock is bounded by the prime fetch (~1-2s), not by the pulls (~8s).
	//    (See `HarnessShim.spawnHygieneChild` for why `process.exit(0)` is NOT a viable
	//    alternative — Windows libuv assertion when sockets are mid-flight.)
	//
	// 2. IN-PROCESS (the fallback, the prior behavior). Run the three seams WITHOUT awaiting
	//    via `backgroundPull`. NOTE: this detaches the await but NOT the underlying fetch I/O —
	//    the pending loopback sockets keep the Node event loop alive until they settle. This is
	//    acceptable for non-hook callers (a long-running daemon importing this module) where the
	//    loop draining on its own schedule is fine; it is NOT acceptable for a hook binary whose
	//    wall clock Claude Code is timing. Harnesses that ship a hygiene child opt into mode 1.
	//
	// Both modes are fail-soft (a rejection or sync throw never propagates) and idempotent (the
	// seams are bounded by their own budgets; a duplicate fire on a re-invocation is a no-op).
	if (deps.spawnHygieneChild !== undefined) {
		try {
			deps.spawnHygieneChild(meta);
		} catch {
			// Best-effort: a spawn failure never breaks the session (the next session-start tries again).
		}
	} else {
		void backgroundPull(() => seams.autoPullSkills(credential));
		void backgroundPull(() => seams.autoPullAssets(credential));
		void backgroundPull(() => seams.spawnGraphPull(meta));
	}

	// Step 9: return the rendered block; the shim chooses the channel (c-AC-5).
	return additionalContext === "" ? { ok: true } : { ok: true, additionalContext };
}

/**
 * Run a session-start side-effect without awaiting it, swallowing any rejection OR synchronous
 * throw so a late failure (after the response has been returned) can never become an unhandled
 * rejection and crash the hook process, and a partial seam object missing the method (or a
 * method that throws synchronously before returning a promise) is tolerated the same as an
 * async rejection.
 *
 * NOTE on process-lifetime: this detaches the await, NOT the underlying I/O. The fetch/file
 * work inside a seam keeps the Node event loop alive until it settles. This is fine for a
 * long-running caller (a daemon) but NOT for a hook binary whose wall clock is timed by the
 * host — harnesses that need the parent to exit promptly opt into `spawnHygieneChild`
 * (the off-process mode) so the parent never runs these seams at all.
 */
function backgroundPull(fn: () => Promise<void>): Promise<void> {
	try {
		return Promise.resolve(fn()).catch(() => {
			// Fail-soft: a background pull failure (async rejection) is swallowed.
		});
	} catch {
		// Fail-soft: a synchronous throw from `fn` (e.g. a missing seam method) is swallowed.
		return Promise.resolve();
	}
}

/**
 * Join any number of `additionalContext` blocks into one payload (PRD-075c c-AC-1/c-AC-2:
 * generalized from the original 2-block notice/prime join to compose the first-run notice, the
 * rules/goals context, the 046d prime digest, and the recall-awareness notice). Empty blocks are
 * dropped; the remaining blocks are separated by a blank line so each stays legible to the model.
 * A single non-empty block is returned as-is; all-empty (or all-empty-including-the-would-be-notice
 * slot, c-AC-3) returns `""` so the caller omits `additionalContext` entirely. Pure, exported for
 * direct unit coverage of the omit/single/multi-block composition rules.
 */
export function joinBlocks(...blocks: readonly string[]): string {
	return blocks.filter((block) => block !== "").join("\n\n");
}

/**
 * Render the first-run "bind a project to start" notice (PRD-059a a-AC-2 / IRD-123), or `""` when it
 * should not show. Returns the notice ONLY when the gate is wired AND reports no bound project (the
 * zero-projects first-run state). When the gate is absent (a unit-constructed session-start) or the
 * workspace already has a bound project, returns `""` so no notice appears. The gate itself is
 * fail-soft; this wrapper additionally guards so a throw yields `""` (never break session-start).
 */
function renderOnboardingNotice(
	gate: OnboardingNoticeGate | undefined,
	meta: HookSessionMeta,
	credential: HookCredential | undefined,
): string {
	if (gate === undefined) return "";
	try {
		// PRD-073b: prefer the per-session `noticeText` (cwd-specific copy) when the gate provides it;
		// fall back to the 059a boolean path + the workspace-level notice for a `hasBoundProject`-only gate.
		if (gate.noticeText !== undefined) {
			return gate.noticeText(meta, credential) ?? "";
		}
		return gate.hasBoundProject(meta, credential) ? "" : BIND_PROJECT_NOTICE;
	} catch {
		return "";
	}
}

/** Run a producing step, returning `fallback` if it throws (fail-soft, FR-10). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await fn();
	} catch {
		return fallback;
	}
}

/** Run a side-effecting step, absorbing any throw (fail-soft, FR-10). */
async function safeVoid(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch {
		// A heal/update/ensure/pull/spawn failure never breaks session-start.
	}
}
