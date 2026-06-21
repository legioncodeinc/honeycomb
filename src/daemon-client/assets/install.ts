/**
 * Asset-sync thin-client install/retract engine — PRD-033c (the consume half).
 *
 * ── DAEMON-ONLY DEEPLAKE (D-6) ───────────────────────────────────────────────
 * This module reaches the `synced_assets` table ONLY through the loopback
 * {@link AssetSyncApi} ({@link createLoopbackAssetSyncApi}) — a thin `DaemonClient.send`
 * to `/api/assets/*`. It touches the local filesystem to install/retract the native
 * artifact. It opens NO DeepLake (the thin-client invariant test scans this root).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *   - {@link createLoopbackAssetSyncApi} — the `AssetSyncApi` impl that POSTs
 *     publish/pull/tombstone to the daemon over loopback (the seam 033b's CLI consumes).
 *   - {@link pullAndInstall} — pull, then for each NON-tombstone asset install the
 *     VERBATIM native artifact via the {@link AssetAdapter} (identity, c-AC-4) onto a
 *     MATCHING harness only (c-AC-3); for each TOMBSTONE asset present locally, RETRACT
 *     per D-4 (back up to `.bak`, then remove). Last-writer-wins + `.bak` (c-AC-2 / FR-5)
 *     mirrors skillify's `decideAction`. Idempotent + fail-soft.
 *   - {@link autoPull} — the session-start wrapper: a 5s budget, swallows ALL errors →
 *     no-op, NEVER blocks session start (c-AC-6 / FR-7) — lifted from skillify `autoPull`.
 *
 * ── Path safety (the install root is the jail) ───────────────────────────────
 * The native artifact writes ONLY under the resolved harness root. The contained
 * install path is derived from the `honeycomb_id` (a `hc_<32hex>` token, safe by
 * construction) BUT re-validated at USE time through {@link resolveContainedDir} — a
 * malicious id/native blob can NEVER escape the root (mirrors skillify's
 * `resolveContainedCanonicalDir` traversal guard). The `.bak`/retraction never escapes
 * the install root either (D-4).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type DaemonClient } from "../../commands/contracts.js";
import {
	type AssetAdapter,
	type AssetScope,
	type AssetSyncApi,
	type DecideInstallInput,
	type HarnessRootResolver,
	IDENTITY_ADAPTER,
	type InstallAction,
	type PublishRequest,
	type PublishResponse,
	type PulledAsset,
	type PullRequest,
	type PullResponse,
	type PullAndInstallDeps,
	type Style,
	type SyncedAssetType,
	type TombstoneRequest,
	type TombstoneResponse,
} from "./contracts.js";

/** The `/api/assets` route base the loopback client POSTs to (the daemon mount). */
export const ASSETS_API_BASE = "/api/assets" as const;

/** The auto-pull timeout budget — a slow store never blocks startup past this (c-AC-6 / FR-7). */
export const ASSET_AUTOPULL_TIMEOUT_MS = 5_000;

/** The canonical file a SKILL artifact's native blob is written into (a skill is a directory). */
const SKILL_FILE = "SKILL.md";
/** The file suffix an AGENT artifact's native blob is written into (an agent is a single file). */
const AGENT_FILE = "AGENT.md";
/** The sidecar that records the installed `{version, contentHash}` for the LWW compare (c-AC-2). */
const ASSET_MARKER = ".honeycomb-asset.json";
/** The `.bak` suffix a backup-write / retraction leaves the prior copy at (D-4 / c-AC-2). */
const BAK_SUFFIX = ".bak";

// ─────────────────────────────────────────────────────────────────────────────
// createLoopbackAssetSyncApi — the AssetSyncApi over the loopback DaemonClient.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the loopback {@link AssetSyncApi} (the seam 033b's CLI consumes). Every method
 * POSTs to the daemon's `/api/assets/*` endpoints through the injected
 * {@link DaemonClient} — the SAME thin loopback `fetch` to `127.0.0.1:3850` the rest of
 * the CLI uses. This is the ONLY way the thin client reaches `synced_assets` (D-6); it
 * opens no DeepLake. A non-2xx / unparseable response is mapped to a safe default
 * (publish/tombstone: `published/tombstoned: false`; pull: an empty, table-absent result)
 * so a transport hiccup degrades rather than throwing — the auto-pull swallows it anyway.
 */
export function createLoopbackAssetSyncApi(daemon: DaemonClient): AssetSyncApi {
	return {
		async publish(req: PublishRequest): Promise<PublishResponse> {
			const res = await daemon.send({ method: "POST", path: `${ASSETS_API_BASE}/publish`, body: req });
			const body = asRecord(res.body);
			return {
				honeycombId: pickString(body.honeycombId) ?? req.honeycombId,
				version: pickNumber(body.version) ?? 0,
				published: res.status >= 200 && res.status < 300 && pickBool(body.published) === true,
			};
		},

		async pull(req: PullRequest): Promise<PullResponse> {
			const res = await daemon.send({ method: "POST", path: `${ASSETS_API_BASE}/pull`, body: req });
			if (res.status < 200 || res.status >= 300) {
				// A non-2xx pull is fail-soft: an empty result, table-absent unknown → false.
				return { assets: [], tableAbsent: false };
			}
			const body = asRecord(res.body);
			const assets = Array.isArray(body.assets) ? body.assets.map(asPulledAsset).filter(isPresent) : [];
			return { assets, tableAbsent: pickBool(body.tableAbsent) === true };
		},

		async tombstone(req: TombstoneRequest): Promise<TombstoneResponse> {
			const res = await daemon.send({ method: "POST", path: `${ASSETS_API_BASE}/tombstone`, body: req });
			const body = asRecord(res.body);
			return {
				honeycombId: pickString(body.honeycombId) ?? req.honeycombId,
				version: pickNumber(body.version) ?? 0,
				tombstoned: res.status >= 200 && res.status < 300 && pickBool(body.tombstoned) === true,
			};
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// pullAndInstall — pull, install non-tombstones, retract tombstones (c-AC-2..6).
// ─────────────────────────────────────────────────────────────────────────────

/** The outcome of a {@link pullAndInstall}: a per-category count for assertions + logs. */
export interface InstallOutcome {
	/** Native artifacts written (a skip does NOT count). */
	readonly installed: number;
	/** Artifacts skipped — local at/newer than remote, or non-matching harness, or dry-run no-op. */
	readonly skipped: number;
	/** Artifacts whose prior copy was backed up to `.bak` before a newer write (c-AC-2). */
	readonly backedUp: number;
	/** Locally-present artifacts retracted by a tombstone (`.bak` then remove, c-AC-5 / D-4). */
	readonly retracted: number;
	/** True when the SELECT was skipped because `synced_assets` was absent (fail-soft no-op, FR-7). */
	readonly tableAbsent: boolean;
	/** True when nothing was written — `dryRun`. */
	readonly dryRun: boolean;
}

/**
 * Pull the caller's audience, then install non-tombstones + retract tombstones
 * (c-AC-2..6 / FR-2..7).
 *
 * For each pulled asset:
 *   - TOMBSTONE present locally → RETRACT (back up to `.bak`, then remove — D-4 / c-AC-5);
 *   - NON-tombstone on a MATCHING harness → install per {@link decideInstall}
 *     (local-absent → write; remote.version>local && hash-divergent → `.bak`+write;
 *     ≤ → skip; force → `.bak`+write — c-AC-2 / FR-5);
 *   - NON-matching harness → skip (c-AC-3): a `(skill, claude_code)` row never lands on
 *     a different harness root (the resolver returns `null`).
 *
 * The native artifact is round-tripped through the {@link AssetAdapter} (`parse(render(x))`,
 * identity in v1, c-AC-4) so the installed bytes equal the published bytes. `tableAbsent`
 * → no-op (FR-7). `dryRun` reports decisions and touches nothing.
 */
export async function pullAndInstall(deps: PullAndInstallDeps): Promise<InstallOutcome> {
	const adapter = deps.adapter ?? IDENTITY_ADAPTER;
	const dryRun = deps.dryRun ?? false;
	const force = deps.force ?? false;

	const pullReq: PullRequest = deps.style === undefined ? { scope: deps.scope } : { scope: deps.scope, style: deps.style };
	const res = await deps.api.pull(pullReq);
	if (res.tableAbsent) {
		return emptyOutcome({ tableAbsent: true, dryRun });
	}

	let installed = 0;
	let skipped = 0;
	let backedUp = 0;
	let retracted = 0;

	for (const asset of res.assets) {
		const root = deps.roots.rootFor(asset.harness, asset.assetType, asset.cell.style);
		// c-AC-3: a non-matching / uninstalled harness yields no root → the artifact is skipped.
		if (root === null) {
			skipped++;
			continue;
		}
		// Resolve + CONTAIN the install dir under the root (path safety — the jail). An id/blob
		// that would escape the root yields null → skipped (never a write outside the root).
		const dir = resolveContainedDir(root, asset.honeycombId);
		if (dir === null) {
			skipped++;
			continue;
		}
		const file = join(dir, fileNameFor(asset.assetType));

		if (asset.tombstone) {
			// c-AC-5 / D-4: a tombstone present locally → retract (back up, then remove).
			if (existsSync(file)) {
				if (dryRun) {
					retracted++;
				} else if (retract(dir, file)) {
					retracted++;
				}
			} else {
				skipped++;
			}
			continue;
		}

		// A non-tombstone: render→parse round-trip (identity in v1, c-AC-4), then LWW-decide.
		const native = adapter.parse(adapter.render(asset.native));
		const local = readLocalMarker(dir);
		const action = decideInstall({
			localExists: existsSync(file),
			localVersion: local?.version ?? null,
			localHash: local?.contentHash ?? null,
			remoteVersion: asset.version,
			remoteHash: asset.contentHash,
			force,
		});

		if (action === "skip") {
			skipped++;
			continue;
		}
		if (dryRun) {
			installed++;
			if (action === "backup-write") backedUp++;
			continue;
		}
		if (action === "backup-write") {
			if (backupExisting(file)) backedUp++;
		}
		writeArtifact(dir, file, native, asset);
		installed++;
	}

	return { installed, skipped, backedUp, retracted, tableAbsent: false, dryRun };
}

/** The injectable seams an {@link autoPull} runs against (extends {@link PullAndInstallDeps}). */
export interface AssetAutoPullDeps extends PullAndInstallDeps {
	/** The env (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The timeout budget in ms (default {@link ASSET_AUTOPULL_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/** The env var that disables session-start asset auto-pull entirely (c-AC-6 / FR-7). */
export const ASSET_AUTOPULL_DISABLED_ENV = "HONEYCOMB_ASSET_AUTOPULL_DISABLED";

/**
 * Auto-pull at session start (c-AC-6 / FR-7). Idempotent + fail-soft:
 *   - `HONEYCOMB_ASSET_AUTOPULL_DISABLED=1` → return `null`, run NOTHING;
 *   - otherwise run {@link pullAndInstall}, bounded by a 5s timeout; ANY error is
 *     SWALLOWED so startup is never blocked. A swallowed/timed-out run returns `null`.
 *
 * The conflict policy + idempotency are inherited from {@link pullAndInstall} — auto-pull
 * adds the gating + the bound, not a second compare. Mirrors skillify's `autoPull`.
 */
export async function autoPull(deps: AssetAutoPullDeps): Promise<InstallOutcome | null> {
	const env = deps.env ?? process.env;
	if (env[ASSET_AUTOPULL_DISABLED_ENV] === "1") return null;
	const timeoutMs = deps.timeoutMs ?? ASSET_AUTOPULL_TIMEOUT_MS;
	try {
		return await withTimeout(pullAndInstall(deps), timeoutMs);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// decideInstall — the last-writer-wins policy (c-AC-2 / FR-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve what a pull should DO with one remote artifact (c-AC-2 / FR-5). The branches:
 *
 *   - local ABSENT                              → `write`        (nothing to back up).
 *   - `--force`                                 → `backup-write` (re-write; back up first).
 *   - remote.version > local && hash-divergent  → `backup-write` (LWW: preserve, then write).
 *   - remote.version > local && hash-IDENTICAL  → `skip`         (same bytes — nothing to do).
 *   - remote.version <= local                   → `skip`         (the idempotent no-op).
 *
 * `localVersion === null` with `localExists` true means an unreadable/garbled local marker:
 * treated as "no usable local version" so a newer remote still wins (a backup-write proceeds
 * when hashes also diverge, which an unknown local hash satisfies).
 */
export function decideInstall(input: DecideInstallInput): InstallAction {
	if (!input.localExists) return "write";
	if (input.force) return "backup-write";
	const localVersion = input.localVersion;
	const remoteNewer = localVersion === null || input.remoteVersion > localVersion;
	if (!remoteNewer) return "skip";
	// Remote is newer. Only back up + overwrite when the local copy is HASH-DIVERGENT
	// (locally edited): if the bytes already match, there is nothing to preserve or write.
	const hashDivergent = input.localHash === null || input.localHash !== input.remoteHash;
	return hashDivergent ? "backup-write" : "skip";
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers — write, backup, retract, marker, path-safety.
// ─────────────────────────────────────────────────────────────────────────────

/** The all-skipped/empty outcome (table absent or no assets). */
function emptyOutcome(over: Partial<InstallOutcome>): InstallOutcome {
	return { installed: 0, skipped: 0, backedUp: 0, retracted: 0, tableAbsent: false, dryRun: false, ...over };
}

/** The native-blob file name for an asset kind (skill = SKILL.md; agent = AGENT.md). */
function fileNameFor(assetType: SyncedAssetType): string {
	return assetType === "agent" ? AGENT_FILE : SKILL_FILE;
}

/**
 * Write the native artifact + its `{version, contentHash}` marker into `dir` (c-AC-1
 * install side). The body is written VERBATIM (the adapter already round-tripped it); the
 * marker is what the next pull's LWW compare reads. Both writes are contained — `dir` is
 * the validated, root-contained directory.
 */
function writeArtifact(dir: string, file: string, native: string, asset: PulledAsset): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, native, "utf-8");
	writeFileSync(
		join(dir, ASSET_MARKER),
		`${JSON.stringify({ honeycombId: asset.honeycombId, version: asset.version, contentHash: asset.contentHash }, null, 2)}\n`,
		"utf-8",
	);
}

/**
 * Back up an existing artifact file to `<file>.bak` before a newer write (c-AC-2 / FR-5).
 * Returns true when a backup was made. A missing source returns false; a rename failure is
 * swallowed so the newer write still proceeds. The `.bak` is a SIBLING of the file inside
 * the same contained dir — it never escapes the install root (D-4).
 */
function backupExisting(file: string): boolean {
	try {
		if (!existsSync(file)) return false;
		renameSync(file, `${file}${BAK_SUFFIX}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Retract a locally-present artifact a tombstone selected (c-AC-5 / D-4): back the file up
 * to `<file>.bak`, THEN remove the LIVE file + its marker. The user's content is preserved
 * via `.bak` (mirrors the LWW backup discipline). Returns true when the retraction landed.
 * Everything happens INSIDE the already-contained `dir`, so neither the `.bak` nor the
 * removal can escape the install root (D-4). The `.bak` itself is left in place (the user's
 * copy); only the managed live file + marker are removed.
 */
function retract(dir: string, file: string): boolean {
	try {
		// Back up the live file first (preserve the user's content), then drop the marker so the
		// next pull sees the artifact as absent and would re-install only on a fresh (non-tombstone)
		// publish. The `.bak` is the user's keepsake; the managed artifact is gone.
		if (existsSync(file)) renameSync(file, `${file}${BAK_SUFFIX}`);
		const marker = join(dir, ASSET_MARKER);
		if (existsSync(marker)) rmSync(marker, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** The `{version, contentHash}` an install marker records (the LWW compare reads it back). */
interface AssetMarker {
	readonly version: number;
	readonly contentHash: string;
}

/** Read the install marker from `dir`, or `null` when absent/garbled (→ treated as no local version). */
function readLocalMarker(dir: string): AssetMarker | null {
	try {
		const raw = readFileSync(join(dir, ASSET_MARKER), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		const version = typeof obj.version === "number" ? obj.version : Number(obj.version);
		const contentHash = typeof obj.contentHash === "string" ? obj.contentHash : "";
		if (!Number.isFinite(version)) return null;
		return { version, contentHash };
	} catch {
		return null;
	}
}

/**
 * Resolve `<root>/<honeycombId>` to an absolute install dir ONLY when it is contained
 * (the path-safety jail). The `honeycombId` should be a `hc_<32hex>` token (safe by
 * construction), but it arrives off the WIRE and is therefore UNTRUSTED — re-validate at
 * USE time (mirrors skillify's `resolveContainedCanonicalDir`):
 *
 *   - the id must be a single safe segment (`[A-Za-z0-9._-]`, no separators, not `.`/`..`);
 *   - the resolved path must be a DIRECT child of the resolved root (never the root itself,
 *     never an ancestor).
 *
 * Returns the contained absolute dir, or `null` when the id is unsafe → the asset is skipped
 * (never written outside the root). A malicious `honeycomb_id` (`../../etc`, an absolute path,
 * a path separator) can NEVER escape the install root.
 */
export function resolveContainedDir(root: string, honeycombId: string): string | null {
	if (typeof root !== "string" || root === "") return null;
	if (!isSafeSegment(honeycombId)) return null;
	const rootResolved = resolve(root);
	const candidate = resolve(join(rootResolved, honeycombId));
	if (candidate === rootResolved) return null;
	if (resolve(dirname(candidate)) !== rootResolved) return null;
	return candidate;
}

/**
 * True when `value` is a SINGLE filesystem segment safe to use as an install dir name. No
 * path separator (`/`, `\`), no NUL, not a `.`/`..` traversal token, and only the safe char
 * class `[A-Za-z0-9._-]`. Anything else is rejected — never sanitized-in-place — because a
 * silently rewritten destructive path is worse than a refused one (the skillify floor).
 */
function isSafeSegment(value: string): boolean {
	if (typeof value !== "string" || value === "" || value === "." || value === "..") return false;
	if (/[/\\\0]/.test(value)) return false;
	if (/\.\.+/.test(value)) return false;
	return /^[A-Za-z0-9._-]+$/.test(value);
}

/** Bound a promise; resolve to `null` when the timeout wins (c-AC-6). The timer is unref'd. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise<T | null>((res, rej) => {
		const timer = setTimeout(() => res(null), ms);
		if (typeof timer.unref === "function") timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				res(value);
			},
			(err) => {
				clearTimeout(timer);
				rej(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Default harness roots — the production `(harness, style)` → root map (c-AC-3).
// ─────────────────────────────────────────────────────────────────────────────

/** The per-harness skills subdir under a base (the canonical host-agent convention). */
const HARNESS_SKILL_DIRS: Readonly<Record<string, string>> = Object.freeze({
	claude_code: join(".claude", "skills"),
	codex: join(".codex", "skills"),
	cursor: join(".cursor", "skills"),
	hermes: join(".hermes", "skills"),
	pi: join(".pi", "agent", "skills"),
	openclaw: join(".openclaw", "skills"),
});

/** The per-harness agents subdir under a base (agents live beside skills under the host dir). */
const HARNESS_AGENT_DIRS: Readonly<Record<string, string>> = Object.freeze({
	claude_code: join(".claude", "agents"),
	codex: join(".codex", "agents"),
	cursor: join(".cursor", "agents"),
	hermes: join(".hermes", "agents"),
	pi: join(".pi", "agent", "agents"),
	openclaw: join(".openclaw", "agents"),
});

/**
 * Build the production {@link HarnessRootResolver} (c-AC-3 / FR-3). `Repository` style maps
 * onto the PROJECT-local root (`<projectDir>/.claude/skills`…), `User` onto the GLOBAL root
 * (`<home>/.claude/skills`…). A harness with no known root mapping returns `null` (the
 * artifact is skipped — it never lands on an unknown harness). `home` + `projectDir` are
 * injectable so a test points the whole set at temp dirs (no real `~`/cwd writes).
 *
 * NOTE (v1): this resolver returns a root for EVERY known harness (it does not gate on
 * "is this harness installed") — the daemon only ever publishes a row for a harness the
 * AUTHOR has, and the matching is by the row's `harness` field, so a `(skill, claude_code)`
 * row resolves to the Claude Code root and a different-harness row resolves elsewhere. The
 * c-AC-3 "only a matching harness" property is the (harness)→(root) map being 1:1: the row's
 * own harness picks its root, and a row for a harness this resolver does not know is skipped.
 */
export function createDefaultHarnessRoots(options: {
	readonly home?: string;
	readonly projectDir?: string;
} = {}): HarnessRootResolver {
	const home = options.home ?? homedir();
	const projectDir = options.projectDir ?? process.cwd();
	return {
		rootFor(harness: string, assetType: SyncedAssetType, style: Style): string | null {
			const table = assetType === "agent" ? HARNESS_AGENT_DIRS : HARNESS_SKILL_DIRS;
			const sub = table[harness];
			if (sub === undefined) return null;
			const base = style === "User" ? home : projectDir;
			return join(base, sub);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape coercion helpers (the loopback responses are untrusted JSON).
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow an unknown body to a record (or an empty record). */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** A non-empty string, or `undefined`. */
function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number, or `undefined`. */
function pickNumber(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/** A boolean, or `undefined`. */
function pickBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Type guard for `.filter`. */
function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

/**
 * Coerce one untrusted pull-response entry into a {@link PulledAsset}, or `null` when the
 * required id is missing. Defensive — the loopback body is JSON the daemon produced, but the
 * thin client validates it rather than trusting the shape blindly (no field drives a write
 * before `resolveContainedDir` re-validates the id).
 */
function asPulledAsset(value: unknown): PulledAsset | null {
	const o = asRecord(value);
	const honeycombId = pickString(o.honeycombId);
	if (honeycombId === undefined) return null;
	const cellRaw = asRecord(o.cell);
	return {
		honeycombId,
		assetType: o.assetType === "agent" ? "agent" : "skill",
		harness: pickString(o.harness) ?? "",
		native: typeof o.native === "string" ? o.native : "",
		canonical: typeof o.canonical === "string" ? o.canonical : "",
		contentHash: typeof o.contentHash === "string" ? o.contentHash : "",
		version: pickNumber(o.version) ?? 0,
		tombstone: pickBool(o.tombstone) === true,
		cell: {
			tier: cellRaw.tier === "Device" || cellRaw.tier === "Team" ? cellRaw.tier : "Local",
			style: cellRaw.style === "User" ? "User" : "Repository",
		},
		deviceSet: Array.isArray(o.deviceSet) ? o.deviceSet.filter((x): x is string => typeof x === "string") : [],
		author: pickString(o.author) ?? "",
		org: pickString(o.org) ?? "",
		workspace: pickString(o.workspace) ?? "",
	};
}

// Re-export the scope type for the CLI seam.
export type { AssetScope };
