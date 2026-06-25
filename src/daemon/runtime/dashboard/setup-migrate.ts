/**
 * The Hivemind→Honeycomb migration route — PRD-050d (d-AC-3 .. d-AC-7).
 *
 * `POST /setup/migrate-from-hivemind` is the "Proceed with Honeycomb" button handler the coexistence
 * -warning wizard (050b/050d shell) calls. It runs ONE guarded, crash-recoverable transaction in the
 * daemon and advances a DURABLE `migration.phase` marker through each destructive step so a daemon
 * crash mid-migration is recoverable (d-AC-7):
 *
 *   write marker `backup`   → back up `~/.hivemind` (timestamped, INSURANCE)
 *   write marker `uninstall`→ uninstall Hivemind idempotently (npm -g remove + remove `~/.hivemind`)
 *   write marker `link`     → verify-and-ADOPT the shared credential via `GET /me` (d-AC-4), or — when
 *                             no valid credential exists — report `needsLogin` so the page runs the 050c
 *                             `--ref mario` device flow (NO redundant device flow when one is valid)
 *   write marker `done`     → stamp `priorTool.hivemind:"migrated"` + `phase:"migrated"` and emit the
 *                             `honeycomb_hivemind_upgrade` telemetry event (d-AC-6) — success only.
 *
 * ── Operator decision: SILENT-ADOPT (Path A = "assume NO", do NOT re-litigate) ───────────────
 * Activeloop does NOT attribute an already-registered account on first touch, so a VALID existing
 * `~/.deeplake/credentials.json` is ADOPTED after a `GET /me` check — NO redundant device flow. Only a
 * missing/invalid/expired credential falls to the 050c `--ref mario` flow (the page POSTs `/setup/login`
 * after a `needsLogin:true` response). Backup is INSURANCE only; the only restore path in scope is the
 * d-AC-7 crash-recovery ROLLBACK below — there is no "undo Hivemind" product UI.
 *
 * ── Safe failure (d-AC-5) ────────────────────────────────────────────────────────────────────
 * A failed/partial uninstall returns a plain-language message + the backup location (200 with
 * `ok:false`, never a raw stack), leaves the marker at its non-terminal phase, and NEVER deletes the
 * shared credential or bricks the daemon (the route is a thin handler; the daemon keeps serving). The
 * page surfaces the message + the backup path and offers resume/rollback.
 *
 * ── Crash recovery (d-AC-7) ──────────────────────────────────────────────────────────────────
 * Because each phase is persisted BEFORE its step, a restart reads a NON-TERMINAL `migration.phase`
 * from `/setup/state` and the dashboard offers RESUME (re-POST this route — every step is idempotent)
 * or ROLL BACK (`POST /setup/migrate-from-hivemind/rollback`, which restores the backup + stamps
 * `migration.phase:"rolled_back"`). A half-migrated machine is NEVER presented as cleanly done/reverted.
 *
 * ── LOCAL-MODE ONLY (mirrors `mountSetupLogin`) ──────────────────────────────────────────────
 * Sits beside the dashboard host + setup-login + setup-state on the UNPROTECTED root group, so the
 * composition root fires it LOCAL-MODE ONLY (security F-1). In team/hybrid it is never mounted.
 *
 * The token is a SECRET (mirrors 050c): the `GET /me` adopt-check reads the token from the shared file
 * and sends it in the `Authorization` header ONLY — it is NEVER returned in the response body or logged.
 */

import type { Context } from "hono";

import { type AuthFetch, createDeeplakeAuthClient, resolveApiUrl } from "../auth/index.js";
import { loadDiskCredentials } from "../auth/credentials-store.js";
import type { Daemon } from "../server.js";
import {
	type OnboardingState,
	loadOnboarding,
	saveOnboarding,
} from "../onboarding/index.js";
import {
	type HivemindUninstallDeps,
	backupAndUninstallHivemind,
	restoreHivemindBackup,
} from "../onboarding/hivemind-uninstall.js";
import { type EmitDeps, emitHivemindUpgrade } from "../telemetry/index.js";

/** The loopback route the "Proceed with Honeycomb" button POSTs to (PRD-050d / 050b host group). */
export const SETUP_MIGRATE_PATH = "/setup/migrate-from-hivemind" as const;

/** The rollback route the crash-recovery "Roll back" affordance POSTs to (d-AC-7). */
export const SETUP_MIGRATE_ROLLBACK_PATH = "/setup/migrate-from-hivemind/rollback" as const;

/** The root route group the migration routes attach to (already mounted, UNPROTECTED, in `server.ts`). */
export const SETUP_MIGRATE_GROUP = "/" as const;

/**
 * The migration response (d-AC-3 .. d-AC-6). Carries the terminal phase + a plain-language message +
 * the backup path — NEVER a token/secret. `needsLogin:true` tells the page to run the 050c device flow
 * (no valid credential to adopt — d-AC-4); `ok:false` on a partial failure carries the recoverable
 * message + the backup location (d-AC-5).
 */
export interface SetupMigrateResponse {
	/** True once the migration reached a terminal good state (adopted, or ready-for-login). */
	readonly ok: boolean;
	/** The migration sub-phase reached (`done` on adopt-success; the non-terminal phase on failure). */
	readonly phase: NonNullable<OnboardingState["migration"]>["phase"];
	/** A single plain-language status/error line for the page (never a raw stack, never a token). */
	readonly message: string;
	/** The timestamped backup path (present once the backup step ran) — the reversibility anchor. */
	readonly backupPath?: string;
	/**
	 * True when no valid credential could be adopted → the page must run the 050c `--ref mario` device
	 * flow (`POST /setup/login`). False/absent when the shared credential was verify-and-adopted (d-AC-4).
	 */
	readonly needsLogin?: boolean;
	/** True once `priorTool.hivemind` was stamped `migrated` (the d-AC-6 terminal flag). */
	readonly migrated?: boolean;
}

/** The rollback response (d-AC-7). Carries the terminal `rolled_back` phase + a plain-language line. */
export interface SetupMigrateRollbackResponse {
	/** True once the backup was restored AND `migration.phase` stamped `rolled_back`. */
	readonly ok: boolean;
	/** The terminal phase after a rollback (`rolled_back`). */
	readonly phase: "rolled_back";
	/** A single plain-language status/error line for the page. */
	readonly message: string;
}

/** Options for {@link mountSetupMigrate} — every IO seam injectable for deterministic tests. */
export interface MountSetupMigrateOptions {
	/**
	 * Override the onboarding/credentials dir (tests point this at a temp HOME). Threaded into the
	 * onboarding load/save + the credential read so nothing touches the real `~/.deeplake`.
	 */
	readonly dir?: string;
	/**
	 * The Hivemind-uninstall seams (tests inject a temp HOME + a fake npm remover, or a THROWING remover
	 * to exercise the partial-failure path d-AC-5). Threaded straight into {@link backupAndUninstallHivemind}.
	 */
	readonly uninstall?: HivemindUninstallDeps;
	/**
	 * The injectable `fetch` the `GET /me` adopt-check runs through (d-AC-4). A test injects a fake that
	 * replays a 200 `/me` (valid → adopt) or a 401 (invalid → needsLogin). Absent → the global `fetch`.
	 */
	readonly fetch?: AuthFetch;
	/** The injectable env (resolves the apiUrl for the `GET /me` check). Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The telemetry chokepoint seam (PRD-050e). `emitHivemindUpgrade` fires through here AFTER a
	 * user-facing migration success — fire-and-forget, deduped, opt-out-safe, NEVER gating the migration.
	 * The onboarding `dir` is threaded automatically so the dedupe ledger shares the test HOME.
	 */
	readonly telemetry?: EmitDeps;
}

/** Persist a `migration.phase` transition onto the onboarding state, fail-soft (mirrors the rest of it). */
function advancePhase(
	dir: string | undefined,
	phase: NonNullable<OnboardingState["migration"]>["phase"],
	patch: Partial<OnboardingState> = {},
	migrationPatch: Partial<NonNullable<OnboardingState["migration"]>> = {},
): OnboardingState {
	const current = loadOnboarding(dir);
	const startedAt = current.migration?.startedAt ?? new Date().toISOString();
	const next: OnboardingState = {
		...current,
		...patch,
		migration: {
			...(current.migration ?? { startedAt }),
			startedAt,
			...migrationPatch,
			phase,
		},
	};
	try {
		return saveOnboarding(next, dir);
	} catch {
		// Fail-soft: the marker is durable bookkeeping, not a hard dependency — return the in-memory next.
		return next;
	}
}

/**
 * Verify-and-ADOPT the shared `~/.deeplake/credentials.json` via `GET /me` (d-AC-4). Returns `true` when
 * a valid credential loads AND `/me` accepts its token (adopt — NO device flow), `false` when no
 * credential exists OR `/me` rejects it (→ the page runs the 050c flow). The token rides the
 * `Authorization` header ONLY (never returned/logged). Any network/parse error is treated as "cannot
 * adopt" (fail to the login path), never a throw.
 */
async function verifyAndAdoptCredential(options: MountSetupMigrateOptions): Promise<boolean> {
	const env = options.env ?? process.env;
	const disk = loadDiskCredentials(options.dir, env);
	if (disk === null || disk.token.length === 0) return false;
	try {
		const client = createDeeplakeAuthClient({
			apiUrl: resolveApiUrl(env),
			...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
		});
		const me = await client.getMe(disk.token, disk.orgId);
		// A usable identity (a non-empty id) means the token is live → adopt the existing credential.
		return me.id.length > 0;
	} catch {
		// `/me` 4xx/5xx / network / parse failure → the credential is not adoptable; fall to the device flow.
		return false;
	}
}

/**
 * Run the migration transaction (d-AC-3 .. d-AC-6). Each destructive step persists its phase BEFORE
 * acting (crash recovery, d-AC-7); a failure returns a recoverable `ok:false` with the message + backup
 * path and never deletes the shared credential (d-AC-5). On adopt-success it stamps the terminal
 * `migrated` flags + emits telemetry (success only, d-AC-6).
 */
async function runMigration(options: MountSetupMigrateOptions): Promise<SetupMigrateResponse> {
	const dir = options.dir;

	// 1) PHASE backup — persist the marker BEFORE the destructive copy, then back up + uninstall. We mark
	//    `backup` first so a crash before/after the copy is recoverable to a non-terminal phase (d-AC-7).
	advancePhase(dir, "backup");
	let backupPath: string | undefined;
	let removed = false;
	try {
		const result = backupAndUninstallHivemind(options.uninstall ?? {});
		backupPath = result.backupPath;
		removed = result.removed;
	} catch {
		// 2) A failed/partial uninstall (d-AC-5): leave the marker at the non-terminal phase, return a
		//    plain-language message + the (possibly-taken) backup path, and DO NOT touch the credential.
		advancePhase(dir, "uninstall", {}, backupPath !== undefined ? { backupPath } : {});
		return {
			ok: false,
			phase: "uninstall",
			message:
				"Couldn't fully remove the previous Hivemind setup. Your Hivemind config was backed up and your account is untouched — retry, or roll back to restore it.",
			...(backupPath !== undefined ? { backupPath } : {}),
		};
	}

	// 2) PHASE uninstall — the destructive step completed (or there was nothing to remove, idempotent).
	//    Record the backup path on the marker so a later rollback (d-AC-7) can find it.
	advancePhase(dir, "uninstall", {}, backupPath !== undefined ? { backupPath } : {});

	// 3) PHASE link — verify-and-adopt the shared credential (d-AC-4). No valid credential → needsLogin.
	advancePhase(dir, "link", {}, backupPath !== undefined ? { backupPath } : {});
	const adopted = await verifyAndAdoptCredential(options);
	if (!adopted) {
		// No adoptable credential: STOP at the non-terminal `link` phase. The page runs the 050c
		// `--ref mario` device flow (`POST /setup/login`); its persist flips `/setup/state.authenticated`
		// and a follow-up migrate call (or the login's own success) completes the `done` stamp. We do NOT
		// emit the upgrade telemetry yet (it fires only on a COMPLETED migration — d-AC-6).
		return {
			ok: true,
			phase: "link",
			message: "Removed the previous Hivemind setup. Sign in to finish linking your account to DeepLake.",
			needsLogin: true,
			...(backupPath !== undefined ? { backupPath } : {}),
		};
	}

	// 4) PHASE done — adopt-success. Stamp the terminal `migrated` flags (d-AC-6): `priorTool.hivemind`
	//    flips to `migrated`, the onboarding `phase` to `migrated`, and `migration.phase` to `done`.
	advancePhase(
		dir,
		"done",
		{ phase: "migrated", priorTool: { hivemind: "migrated" }, firstTimeSetupComplete: true },
		backupPath !== undefined ? { backupPath } : {},
	);

	// 5) Telemetry — emit `honeycomb_hivemind_upgrade` AFTER the user-facing success, NEVER gating it
	//    (d-AC-6 / 050e). This is the ONLY signal that counts the silent-adopt cohort (no device flow ran,
	//    so the referral header never reached the backend). Fire-and-forget through the deduped chokepoint;
	//    the onboarding `dir` is threaded so the dedupe ledger lives in the same HOME under test. The
	//    resolved effective ref is read from the onboarding file (the install-time `--ref`), defaulting to
	//    the build-injected DEFAULT_REF.
	const ref = loadOnboarding(dir).ref;
	await emitHivemindUpgrade(ref, { ...(options.telemetry ?? {}), ...(dir !== undefined ? { dir } : {}) });

	return {
		ok: true,
		phase: "done",
		message: "You're all set — your DeepLake account is linked and the previous Hivemind setup was removed.",
		migrated: true,
		...(backupPath !== undefined ? { backupPath } : {}),
	};
}

/**
 * Roll back an interrupted migration (d-AC-7): restore the backed-up `~/.hivemind` and stamp
 * `migration.phase:"rolled_back"` so a half-migrated machine is presented as cleanly REVERTED (never
 * cleanly migrated). The shared credential is never touched. Fail-soft: a missing backup still stamps
 * `rolled_back` (there is nothing to restore — the machine is already at the pre-backup state) so the
 * marker reaches its terminal reverted phase.
 */
function runRollback(options: MountSetupMigrateOptions): SetupMigrateRollbackResponse {
	const dir = options.dir;
	const current = loadOnboarding(dir);
	const backupPath = current.migration?.backupPath ?? "";

	let restored = false;
	if (backupPath.length > 0) {
		restored = restoreHivemindBackup(backupPath, {
			...(options.uninstall?.homeDir !== undefined ? { homeDir: options.uninstall.homeDir } : {}),
		});
	}

	// Stamp the TERMINAL reverted phase. `priorTool.hivemind` goes back to `present` (the restored
	// Hivemind is detectable again); the onboarding `phase` returns to `fresh` so the wizard does not
	// present a migrated state. The backup path is preserved on the marker for the record.
	advancePhase(
		dir,
		"rolled_back",
		{ phase: "fresh", priorTool: { hivemind: restored ? "present" : "absent" } },
		backupPath.length > 0 ? { backupPath } : {},
	);

	return {
		ok: true,
		phase: "rolled_back",
		message: restored
			? "Rolled back — your previous Hivemind setup was restored from the backup."
			: "Rolled back — no backup was found to restore, but nothing was changed on your machine.",
	};
}

/**
 * Attach `POST /setup/migrate-from-hivemind` + its `/rollback` sibling onto the daemon's already-mounted
 * root group (PRD-050d). Call ONCE after `createDaemon(...)`; the composition root fires it LOCAL-MODE
 * ONLY (mirroring `mountSetupLogin`). If the root group is not mounted the attach is a no-op.
 *
 * Both handlers are crash-recoverable + idempotent: the marker advances BEFORE each destructive step, the
 * uninstall is safe to re-run, and the response never carries a token/secret nor a raw stack.
 */
export function mountSetupMigrate(daemon: Daemon, options: MountSetupMigrateOptions = {}): void {
	const root = daemon.group(SETUP_MIGRATE_GROUP);
	if (root === undefined) return;

	root.post(SETUP_MIGRATE_PATH, async (c: Context) => {
		try {
			return c.json(await runMigration(options));
		} catch {
			// A truly-unexpected error: a redacted, recoverable message (never a raw stack, never a token).
			// The marker is left at whatever non-terminal phase the transaction reached (resume/rollback).
			const phase = loadOnboarding(options.dir).migration?.phase ?? "backup";
			return c.json(
				{
					ok: false,
					phase,
					message: "Migration didn't finish. Your account is untouched — retry, or roll back to restore the previous setup.",
				} satisfies SetupMigrateResponse,
				200,
			);
		}
	});

	root.post(SETUP_MIGRATE_ROLLBACK_PATH, (c: Context) => {
		try {
			return c.json(runRollback(options));
		} catch {
			return c.json(
				{ ok: false, phase: "rolled_back", message: "Rollback didn't finish — retry." } satisfies SetupMigrateRollbackResponse,
				200,
			);
		}
	});
}
