/**
 * The dashboard IMPERATIVE ACTIONS API — making the dashboard a peer of the CLI for the named
 * lifecycle actions (logout, embeddings on/off, daemon restart, uninstall).
 *
 * ── Why a dedicated seam ─────────────────────────────────────────────────────
 * The rest of the dashboard reads view-models (`api.ts`/`harness-api.ts`) and writes settings
 * (`/api/settings`) / secrets (`/api/secrets`). These four are PROCESS / CREDENTIAL / LIFECYCLE
 * actions that have no daemon endpoint yet — they were CLI-only (`honeycomb logout`,
 * `HONEYCOMB_EMBEDDINGS`, `honeycomb daemon`, `honeycomb uninstall`). This module mounts them under
 * ONE new protected group `/api/actions` (declared in `server.ts`), mirroring how `mountHarnessApi`
 * attaches to an already-mounted group with ZERO `server.ts` handler edits.
 *
 * ── Security (the actions are sharp) ─────────────────────────────────────────
 * Every handler runs behind {@link actionGuard}:
 *   1. LOCAL MODE ONLY — like the dashboard host + setup routes (`assemble.ts` security F-1). A
 *      team/hybrid daemon never exposes a self-destruct/credential surface to a remote.
 *   2. ORIGIN / CSRF — the daemon binds loopback, but a malicious site open in the user's browser
 *      could POST to `127.0.0.1:3850`. We reject a browser cross-origin request (`Sec-Fetch-Site:
 *      cross-site|same-site`), require any present `Origin` to be a loopback origin, AND require the
 *      dashboard's custom `x-honeycomb-session` header (a cross-origin fetch cannot set a custom
 *      header without a CORS preflight the daemon never approves). Three independent barriers.
 * No secret/token EVER crosses a response (logout returns a boolean; embeddings returns the new
 * boolean; uninstall returns paths/ids/a command string; restart returns a flag).
 *
 * ── Hermetic by injection ────────────────────────────────────────────────────
 * The credential remover, the process shutdown, the restart respawn, and the uninstall outcome are
 * all injectable seams, defaulting to the real behaviour — so the unit suite drives every handler
 * (and every guard rejection) against recorders without removing a real credential, killing the
 * test process, or spawning a real daemon.
 */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Context, Hono } from "hono";

import { DAEMON_PORT } from "../../../shared/constants.js";
import type { QueryScope } from "../../storage/client.js";
import { credentialsPath, legacyCredentialsPath } from "../auth/credentials-store.js";
import type { DeploymentMode } from "../config.js";
import type { PipelineReloadSeam } from "../pipeline/reload.js";
import { localDefaultScopeResolver, type ScopeResolver } from "../secrets/api.js";
import type { EmbedSupervisor } from "../services/embed-supervisor.js";
import type { Daemon } from "../server.js";
import { EMBEDDINGS_ENABLED_KEY, MEMORY_ENABLED_KEY } from "../vault/api.js";
import type { VaultStore } from "../vault/store.js";
import { detectInstalledHarnesses } from "./harness-detect.js";

/** The route group the actions API attaches to (declared + protected in `server.ts`). */
export const ACTIONS_GROUP = "/api/actions" as const;

/** Delay (ms) between acking a restart and triggering shutdown, so the HTTP response flushes first. */
const RESTART_SHUTDOWN_DELAY_MS = 100;

/** The structured outcome `POST /api/actions/uninstall` returns (no secret — ids + a command). */
export interface UninstallOutcome {
	/** True when the action completed without error (the guided default always succeeds). */
	readonly ok: boolean;
	/** The canonical harness ids currently wired on disk (so the page can name them). */
	readonly harnesses: readonly string[];
	/** True iff Honeycomb's hooks were actually removed in-process (v1 default: false — guided). */
	readonly removed: boolean;
	/** The exact CLI command that fully reverses Honeycomb's footprint. */
	readonly command: string;
	/** A plain-language note rendered to the user. */
	readonly note: string;
}

/** Construction deps for {@link mountActionsApi}. Everything injectable for testability. */
export interface MountActionsOptions {
	/** The embed supervisor the embeddings toggle actuates live (`setEnabled`). */
	readonly embed: EmbedSupervisor;
	/** The daemon's default tenancy scope (local-mode fallback for the settings write). */
	readonly defaultScope?: QueryScope;
	/** The vault store the embeddings preference persists through (absent → live-only, no persist). */
	readonly store?: VaultStore;
	/** Remove the shared + legacy credentials (logout). Default: rm both credential files (fail-soft). */
	readonly removeCredentials?: () => void;
	/** Trigger a graceful daemon shutdown (restart). Default: `SIGTERM` to self (the assembly drains). */
	readonly shutdown?: () => void;
	/** Spawn the detached respawn helper (restart). Default: spawn `restart-helper.js` unref'd. */
	readonly spawnRestart?: () => void;
	/** Produce the uninstall outcome. Default: the guided result (detect harnesses + the CLI command). */
	readonly uninstall?: () => UninstallOutcome;
	/**
	 * A structured-event sink the `memory` toggle emits on each successful write. Kept alongside the
	 * SP-1 live path (`reload` below) so the toggle stays observable in the boot log. Default: a
	 * no-op (no wiring → the persist still happens, the event is simply dropped). Carries NO secret
	 * — a name + a boolean.
	 */
	readonly onMemoryToggle?: (event: { enabled: boolean }) => void;
	/**
	 * SP-1 (kill `appliesOnRestart`): the pipeline live-reload trigger the `memory` toggle fires
	 * post-persist, so the master extraction gate flips IN-PROCESS (debounced ~1s) instead of
	 * waiting for the next daemon boot. When wired the ack reports `appliedLive: true` (and keeps
	 * `appliesOnRestart: false` for hive back-compat); ABSENT (unit mounts, deferred assemblies)
	 * → the persist-only behavior stands and the ack honestly reports `appliesOnRestart: true`.
	 */
	readonly reload?: PipelineReloadSeam;
}

/** Whether an `Origin` header names a loopback host (the only origin the dashboard is served from). */
function isLoopbackOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * The shared guard for every action endpoint (defense-in-depth, see the file header). Returns a
 * `Response` to short-circuit when the request is rejected, or `null` when it may proceed.
 */
export function actionGuard(c: Context, mode: DeploymentMode): Response | null {
	if (mode !== "local") {
		return c.json({ error: "forbidden", reason: "actions are available in local mode only" }, 403);
	}
	// A browser cross-origin request carries `Sec-Fetch-Site: cross-site` (or `same-site`); a
	// same-origin dashboard request carries `same-origin`, and a non-browser client (CLI/test) sends none.
	const site = c.req.header("sec-fetch-site");
	if (site === "cross-site" || site === "same-site") {
		return c.json({ error: "forbidden", reason: "cross-origin request rejected" }, 403);
	}
	// If an Origin is present it MUST be a loopback origin (the same daemon serving the dashboard).
	const origin = c.req.header("origin");
	if (origin !== undefined && origin !== "" && !isLoopbackOrigin(origin)) {
		return c.json({ error: "forbidden", reason: "untrusted origin" }, 403);
	}
	// Defense-in-depth: require the dashboard's custom session header (a cross-origin fetch cannot set
	// a custom header without a CORS preflight the daemon never approves).
	const session = c.req.header("x-honeycomb-session");
	if (session === undefined || session.trim() === "") {
		return c.json({ error: "forbidden", reason: "missing dashboard session header" }, 403);
	}
	return null;
}

/** Read `{ enabled: boolean }` from the POST body (also accepts `"true"`/`"false"`/`1`/`0`). */
async function readEnabled(c: Context): Promise<boolean | null> {
	try {
		const body: unknown = await c.req.json();
		if (typeof body === "object" && body !== null) {
			const v = (body as Record<string, unknown>).enabled;
			if (typeof v === "boolean") return v;
			if (v === "true" || v === 1) return true;
			if (v === "false" || v === 0) return false;
		}
		return null;
	} catch {
		return null;
	}
}

/** Default logout: remove the shared + legacy credential files (idempotent, never throws). */
function defaultRemoveCredentials(): void {
	for (const path of [credentialsPath(), legacyCredentialsPath()]) {
		try {
			rmSync(path, { force: true });
		} catch {
			// A missing/locked credential file is fine — logout is idempotent (AC-6 parity with the CLI).
		}
	}
}

/** Default shutdown: signal self with SIGTERM so the assembly's graceful handler drains + unlocks. */
function defaultShutdown(): void {
	try {
		process.kill(process.pid, "SIGTERM");
	} catch {
		// If the signal cannot be delivered there is nothing more to do here (the helper still respawns).
	}
}

/**
 * Default restart respawn: spawn the detached `restart-helper.js` (bundled beside the daemon entry),
 * which waits for THIS process to release the port/lock, then starts a fresh daemon. The helper is a
 * separate process, so it is not subject to this daemon's single-instance lock. Unref'd so it
 * outlives the dying parent. A missing entry path (an odd bundling) degrades to a no-op (the
 * accompanying shutdown still stops the daemon; the user re-ups via `honeycomb daemon start`).
 */
function defaultSpawnRestart(): void {
	const entry = process.argv[1];
	if (entry === undefined || entry === "") return;
	const helper = resolve(dirname(entry), "restart-helper.js");
	const child = spawn(process.execPath, [helper], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, HONEYCOMB_RESTART_ENTRY: entry, HONEYCOMB_RESTART_PORT: String(DAEMON_PORT) },
	});
	child.unref();
}

/**
 * Default uninstall (v1, guided): detect the wired harnesses and return the exact CLI command that
 * fully reverses Honeycomb's footprint. The destructive hook removal lives in the CLI connector
 * engine (`honeycomb uninstall`), which is a non-daemon layer; performing it from the very daemon
 * serving this page would also kill the page mid-operation. So v1 surfaces the capability honestly
 * (what is installed + the one command) rather than faking a one-click removal. The seam is
 * injectable so a future composition root can wire a real in-process remover.
 */
function defaultUninstall(): UninstallOutcome {
	const harnesses = [...detectInstalledHarnesses()];
	return {
		ok: true,
		harnesses,
		removed: false,
		command: "honeycomb uninstall",
		note: "Run `honeycomb uninstall` in your terminal to remove Honeycomb's hooks from your coding assistants. It reverses only Honeycomb's changes; your DeepLake login is left intact (use Log out for that).",
	};
}

/**
 * Attach the four action handlers onto a route group (group-relative paths). Split from
 * {@link mountActionsApi} so a unit test can drive a bare Hono group + injected seams.
 */
export function mountActionsGroup(group: Hono, mode: DeploymentMode, options: MountActionsOptions): void {
	const embed = options.embed;
	const store = options.store;
	const removeCredentials = options.removeCredentials ?? defaultRemoveCredentials;
	const shutdown = options.shutdown ?? defaultShutdown;
	const spawnRestart = options.spawnRestart ?? defaultSpawnRestart;
	const uninstall = options.uninstall ?? defaultUninstall;
	const onMemoryToggle = options.onMemoryToggle;
	// The SAME scope resolver the `/api/settings` write path uses, so the embeddings preference
	// persists under the identical tenancy a CLI `honeycomb settings set` would (local-default fallback).
	const settingsScope: ScopeResolver = localDefaultScopeResolver(mode, options.defaultScope);

	// POST /api/actions/logout — remove the shared DeepLake credential (re-auth from the dashboard).
	group.post("/logout", (c) => {
		const denied = actionGuard(c, mode);
		if (denied) return denied;
		removeCredentials();
		return c.json({ ok: true });
	});

	// POST /api/actions/embeddings — turn embeddings on/off LIVE + persist the choice (survives restart).
	group.post("/embeddings", async (c) => {
		const denied = actionGuard(c, mode);
		if (denied) return denied;
		const enabled = await readEnabled(c);
		if (enabled === null) {
			return c.json({ error: "bad_request", reason: "body must carry { enabled: boolean }" }, 400);
		}
		// Persist first (best-effort) so the choice survives a daemon restart; a missing store / no
		// resolvable scope simply skips persistence (the live toggle below still applies this session).
		if (store !== undefined) {
			const sc = settingsScope.resolve(c);
			if (sc !== null) {
				try {
					await store.setSetting(EMBEDDINGS_ENABLED_KEY, enabled, sc);
				} catch {
					// A vault write failure must not block the live toggle — it just won't persist this run.
				}
			}
		}
		// Actuate the running supervisor: spawn + warm (enable) or stop the child (disable).
		await embed.setEnabled(enabled);
		return c.json({ ok: true, enabled });
	});

	// POST /api/actions/memory — turn MEMORY FORMATION on/off: persist `memory.enabled` (vault-first,
	// still authoritative at next boot) AND — SP-1 — actuate it LIVE through the pipeline reload seam,
	// mirroring how the embeddings toggle actuates its supervisor. The seam re-runs the vault-first
	// resolution and flips the extraction stage's live master gate in-process (debounced ~1s), so the
	// ack reports `appliedLive: true`. `appliesOnRestart` is KEPT in the payload for hive back-compat,
	// as `false` when the live path is wired (and honestly `true` on a seam-less mount, where persist-
	// at-next-boot is still the only effect).
	group.post("/memory", async (c) => {
		const denied = actionGuard(c, mode);
		if (denied) return denied;
		const enabled = await readEnabled(c);
		if (enabled === null) {
			return c.json({ error: "bad_request", reason: "body must carry { enabled: boolean }" }, 400);
		}
		// Persist the choice (best-effort) so it survives — and takes effect on — a daemon restart; a
		// missing store / no resolvable scope skips persistence (no live supervisor to fall back to, so
		// with no store the toggle is a structured-event-only no-op this run, surfaced honestly below).
		let persisted = false;
		if (store !== undefined) {
			const sc = settingsScope.resolve(c);
			if (sc !== null) {
				try {
					await store.setSetting(MEMORY_ENABLED_KEY, enabled, sc);
					persisted = true;
				} catch {
					// A vault write failure must not 500 the toggle — it just won't persist this run.
				}
			}
		}
		// Emit the structured event so the toggle is observable in the boot log either way.
		onMemoryToggle?.({ enabled });
		// SP-1: actuate LIVE via the pipeline reload seam (fire-and-forget, post-persist — the
		// debounced rebuild re-reads the just-written vault value and flips the extraction gate).
		// The reload RE-READS STORED state, so `appliedLive` requires BOTH the seam and a
		// successful persist: an unpersisted toggle is applied neither live nor at restart, and
		// firing the seam without a persist would only republish the old value (Aikido finding).
		const appliedLive = persisted && options.reload !== undefined;
		if (appliedLive) options.reload?.requestReload("action:memory");
		return c.json({
			ok: true,
			enabled,
			persisted,
			appliedLive,
			appliesOnRestart: persisted && !appliedLive,
		});
	});

	// POST /api/actions/restart — respawn a fresh daemon, then gracefully stop this one.
	group.post("/restart", (c) => {
		const denied = actionGuard(c, mode);
		if (denied) return denied;
		// Spawn the respawn helper FIRST (it waits for this process to exit, then starts the new daemon),
		// then defer the graceful shutdown a tick so this 200 response flushes to the client.
		spawnRestart();
		setTimeout(() => shutdown(), RESTART_SHUTDOWN_DELAY_MS);
		return c.json({ ok: true, restarting: true });
	});

	// POST /api/actions/uninstall — reverse Honeycomb's footprint (v1: guided; see defaultUninstall).
	group.post("/uninstall", (c) => {
		const denied = actionGuard(c, mode);
		if (denied) return denied;
		return c.json(uninstall());
	});
}

/**
 * Resolve `/api/actions` and mount the handlers (the assembly seam). Mirrors `mountHarnessApi`:
 * resolves the protected group and delegates. A no-op when the group is not mounted (unknown daemon
 * shape) so a unit-constructed daemon without the group never throws.
 */
export function mountActionsApi(daemon: Daemon, options: MountActionsOptions): void {
	const group = daemon.group(ACTIONS_GROUP);
	if (group === undefined) return;
	mountActionsGroup(group, daemon.config.mode, options);
}
