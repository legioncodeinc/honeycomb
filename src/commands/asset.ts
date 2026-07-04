/**
 * `honeycomb asset` thin-client verb — PRD-033b (b-AC-1..6 / FR-1..FR-8).
 *
 * The CLI surface that moves a skill/agent through the tier × style lattice under
 * explicit user control. Six subcommands + a device pair:
 *
 *   - `asset register <path> --type <skill|agent> --harness <h> [--style ...]`
 *       Register an artifact at the `Local` tier with an explicit style + a stamped
 *       `honeycomb_id`. Writes ONLY the local registry — nothing to DeepLake (b-AC-1).
 *   - `asset promote <id> <tier>`   Raise the tier (publishes at the new radius, FR-4).
 *   - `asset demote  <id> <tier>`   Lower the tier (tombstones every wider tier left, FR-5).
 *   - `asset style   <id> <style>`  Flip Repository↔User (orthogonal; publishes nothing, FR-3).
 *   - `asset list`                  Show every registered artifact's cell + id.
 *   - `asset device list`           Show this machine's device identity.
 *   - `asset device revoke <id>`    Revoke a device — write a device tombstone (D-1).
 *
 * ── It is a THIN CLIENT (D-6 / the dispatcher thesis) ─────────────────────────
 * The DeepLake side (publish/tombstone) goes through the loopback
 * {@link createLoopbackAssetSyncApi} over the {@link DaemonClient} seam — the SAME
 * `127.0.0.1:3850` path every storage verb uses (the daemon owns the `synced_assets`
 * table; the CLI never opens DeepLake). The LOCAL `.honeycomb/registry.json` is read
 * and written DIRECTLY (the registry is local-disk bookkeeping, not team state — D-2),
 * which is allowed: `src/commands` is a NON_DAEMON_ROOT only with respect to
 * `daemon/storage` (the DeepLake client), and the registry store imports none of it.
 *
 * ── The lattice authority is shared (no second copy of the rule) ──────────────
 * Promotion/demotion run through {@link transitionAsset} (`daemon/runtime/assets`),
 * which gates every move through `isLegalTransition` and writes the tombstones for
 * every wider tier a demotion leaves (FR-5). The CLI does the FS work the lifecycle
 * is kept free of (read the artifact, mint + stamp the id, hash it) and passes the
 * resolved values in. No secret/token is ever printed (b-AC: CLI surface is clean).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import {
	type AssetLifecycleDeps,
	type AssetRegistryStore,
	type AssetScope,
	type AssetSyncApi,
	createAssetRegistryStore,
	defaultRegistryBaseDir,
	legacyRegistryBaseDir,
	type DeviceRecord,
	type FileEntry,
	hashArtifact,
	loadOrCreateDevice,
	type LatticeCell,
	type RegistryEntry,
	registerAsset,
	resolveHoneycombId,
	stampHoneycombId,
	type Style,
	type SyncedAssetType,
	type Tier,
	TIERS,
	STYLES,
	SYNCED_ASSET_TYPES,
	transitionAsset,
	TransitionError,
} from "../daemon/runtime/assets/index.js";
import { createLoopbackAssetSyncApi } from "../daemon-client/assets/index.js";
import { type CommandDeps, type CommandResult, type OutputSink } from "./contracts.js";

/** The daemon route group the publish/tombstone side reaches (the PRD-033c `/api/assets` mount). */
export const ASSETS_ENDPOINT = "/api/assets" as const;

/** A parsed `asset` invocation: the subcommand word + positional operands + the recognized flags. */
export interface AssetCliInvocation {
	/** `register` | `promote` | `demote` | `style` | `list` | `device` | unknown. */
	readonly subCommand: string;
	/** Positional operands after the subcommand (e.g. `[path]`, `[id, tier]`, `[id, style]`). */
	readonly args: readonly string[];
	/** `--type <skill|agent>` for register (defaults to `skill`). */
	readonly type: string;
	/** `--harness <h>` for register (the native target). */
	readonly harness: string;
	/** `--style <Repository|User>` for register (defaults to `Repository`). */
	readonly style: string;
}

/**
 * The injectable seams the `asset` verb runs against (beyond {@link CommandDeps}). Every
 * external touch is a seam so a test drives the whole surface against a fake daemon client,
 * a temp registry dir, a fixed device, and a temp artifact tree — no real `~`, no daemon.
 */
export interface AssetCliDeps extends CommandDeps {
	/** The local registry store (defaults to `~/.honeycomb/registry.json`). */
	readonly registry?: AssetRegistryStore;
	/** The loopback asset-sync API (defaults to one built from `deps.daemon`). */
	readonly sync?: AssetSyncApi;
	/** This machine's device record (defaults to `loadOrCreateDevice()`). */
	readonly device?: DeviceRecord;
	/** The resolved tenancy scope's org (defaults to env `HONEYCOMB_ORG` or `"local"`). */
	readonly org?: string;
	/** The resolved tenancy scope's workspace (defaults to env `HONEYCOMB_WORKSPACE` or `"default"`). */
	readonly workspace?: string;
	/** The acting author identity (defaults to env `HONEYCOMB_AUTHOR` or the device label). */
	readonly author?: string;
	/** The project dir Repository-style keying resolves against (defaults to `process.cwd()`). */
	readonly projectDir?: string;
}

/**
 * Parse a raw `asset` argv tail (everything AFTER the `asset` word) into a typed
 * {@link AssetCliInvocation}. The first non-flag word is the subcommand; remaining non-flag
 * words are positional operands; `--type`/`--harness`/`--style` (and their `=` forms) are
 * the register flags. Pure: no IO, fully testable.
 */
export function parseAssetCliArgs(argv: readonly string[]): AssetCliInvocation {
	let subCommand = "";
	const args: string[] = [];
	let type = "";
	let harness = "";
	let style = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const flag = matchFlag(a, argv[i + 1]);
		if (flag !== null) {
			if (flag.consumedNext) i += 1;
			if (flag.key === "type") type = flag.value;
			else if (flag.key === "harness") harness = flag.value;
			else if (flag.key === "style") style = flag.value;
			continue;
		}
		if (a.startsWith("--")) continue; // an unrecognized flag is ignored
		if (subCommand === "") subCommand = a;
		else args.push(a);
	}
	return { subCommand, args, type, harness, style };
}

/** Match one of the register flags (`--key value` or `--key=value`); `null` for a non-flag/unknown. */
function matchFlag(
	token: string,
	next: string | undefined,
): { key: string; value: string; consumedNext: boolean } | null {
	for (const key of ["type", "harness", "style"] as const) {
		if (token === `--${key}`) {
			if (next !== undefined && !next.startsWith("--")) return { key, value: next, consumedNext: true };
			return { key, value: "", consumedNext: false };
		}
		if (token.startsWith(`--${key}=`)) return { key, value: token.slice(`--${key}=`.length), consumedNext: false };
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seam resolution — build the registry / sync / scope from the (injected) deps.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the local registry store (injected, or the default `~/.honeycomb/registry.json`). */
function resolveRegistry(deps: AssetCliDeps): AssetRegistryStore {
	return (
		deps.registry ??
		createAssetRegistryStore(
			defaultRegistryBaseDir(deps.dir ?? homedir()),
			legacyRegistryBaseDir(deps.dir ?? homedir()),
		)
	);
}

/** Resolve the loopback asset-sync API (injected, or one built from the daemon seam). */
function resolveSync(deps: AssetCliDeps): AssetSyncApi {
	return deps.sync ?? createLoopbackAssetSyncApi(deps.daemon);
}

/** Resolve this machine's device record (injected, or loaded/created under the home dir). */
function resolveDevice(deps: AssetCliDeps): DeviceRecord {
	return deps.device ?? loadOrCreateDevice(deps.dir !== undefined ? { homeDir: deps.dir } : {});
}

/**
 * Resolve the {@link AssetScope} the publish/tombstone side carries (FR-6 / FR-7). org/
 * workspace bound the Team radius; author + the device id bound the Device radius. Each
 * leg prefers the injected dep, then the env, then a safe local default — mirroring the
 * daemon-side `defaultScope` posture (a loopback CLI in local mode carries the single tenant).
 */
function resolveScope(deps: AssetCliDeps, device: DeviceRecord): AssetScope {
	const env = deps.env ?? process.env;
	return {
		org: deps.org ?? env.HONEYCOMB_ORG ?? "local",
		workspace: deps.workspace ?? env.HONEYCOMB_WORKSPACE ?? "default",
		author: deps.author ?? env.HONEYCOMB_AUTHOR ?? device.label,
		deviceId: device.device_id,
	};
}

/** Build the {@link AssetLifecycleDeps} the lifecycle runs against from the resolved seams. */
function lifecycleDeps(sync: AssetSyncApi, registry: AssetRegistryStore): AssetLifecycleDeps {
	return { sync, registry };
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact reading — enumerate the file entries for hashing + the native blob.
// ─────────────────────────────────────────────────────────────────────────────

/** The bytes + file entries an artifact resolves to (the native blob + the hash leaves). */
interface ReadArtifact {
	/** The native blob to publish (the single file's content for both skill + agent in v1). */
	readonly native: string;
	/** The (path, content) leaves the hash folds over (one for an agent; many for a skill dir). */
	readonly files: readonly FileEntry[];
	/** The primary file path the `honeycomb_id` is stamped into (frontmatter). */
	readonly primaryPath: string;
}

/**
 * Read an artifact off disk into its native blob + hash leaves. An AGENT is a single file
 * (the path points at it). A SKILL is a directory: every file under it is a hash leaf, and
 * the native blob is the `SKILL.md` at its root (the canonical entry the install side writes).
 * Returns `null` when the path is missing/unreadable.
 */
function readArtifact(path: string, assetType: SyncedAssetType): ReadArtifact | null {
	try {
		const st = statSync(path);
		if (assetType === "agent") {
			if (!st.isFile()) return null;
			const content = readFileSync(path, "utf-8");
			return { native: content, files: [{ relativePath: "AGENT.md", content }], primaryPath: path };
		}
		// A skill is a directory — enumerate every file as a hash leaf; the native blob is SKILL.md.
		const dir = st.isDirectory() ? path : join(path, "..");
		const files: FileEntry[] = [];
		walkFiles(dir, dir, files);
		if (files.length === 0) return null;
		const skillMd = join(dir, "SKILL.md");
		let native = "";
		try {
			native = readFileSync(skillMd, "utf-8");
		} catch {
			// No SKILL.md → use the first file's content as the native blob (best-effort).
			native = typeof files[0]!.content === "string" ? files[0]!.content : "";
		}
		return { native, files, primaryPath: skillMd };
	} catch {
		return null;
	}
}

/** Recursively collect every file under `dir` as a `(relativePath, content)` leaf (skill hashing). */
function walkFiles(root: string, dir: string, out: FileEntry[]): void {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			walkFiles(root, full, out);
		} else if (st.isFile()) {
			const rel = relative(root, full).split(sep).join("/");
			out.push({ relativePath: rel, content: readFileSync(full, "utf-8") });
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand handlers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `asset register <path> --type --harness [--style]` (b-AC-1 / FR-1). Reads the artifact,
 * resolves its stable `honeycomb_id` (frontmatter, registry fallback, else mint), hashes it,
 * and records a `Local` entry via {@link registerAsset} — NOTHING to DeepLake. The stamped
 * id is reported (so a re-scan after a rename resolves the same identity, a-AC-3). NOTE the
 * CLI computes the stamped frontmatter but does not REWRITE the user's file in v1 (the stamp
 * is reported + the registry is authoritative, D-3); a future `--stamp` writes it back.
 */
async function runRegister(deps: AssetCliDeps, inv: AssetCliInvocation, out: OutputSink): Promise<CommandResult> {
	const path = inv.args[0] ?? "";
	if (path === "") {
		out("usage: honeycomb asset register <path> --type <skill|agent> --harness <harness> [--style <Repository|User>]");
		return { exitCode: 1 };
	}
	const assetType = isAssetType(inv.type) ? inv.type : "skill";
	const harness = inv.harness;
	if (harness === "") {
		out("error: --harness is required (the native harness this artifact targets).");
		return { exitCode: 1 };
	}
	const style: Style = isStyleStr(inv.style) ? inv.style : "Repository";

	const artifact = readArtifact(path, assetType);
	if (artifact === null) {
		out(`error: cannot read ${assetType} at '${path}'.`);
		return { exitCode: 1 };
	}

	const registry = resolveRegistry(deps);
	const sync = resolveSync(deps);
	const device = resolveDevice(deps);
	const scope = resolveScope(deps, device);

	// Resolve the stable id: frontmatter first, then the registry's record, else mint (a-AC-3 / D-3).
	const existing = registry.read().find((e) => sameArtifact(e, assetType, harness, artifact.native));
	const resolved = resolveHoneycombId(artifact.native, existing?.honeycombId);
	const honeycombId = resolved.id;
	const stamped = stampHoneycombId(artifact.native, honeycombId);
	const contentHash = hashArtifact(assetType, artifact.files);

	const entry = await registerAsset(lifecycleDeps(sync, registry), {
		honeycombId,
		assetType,
		harness,
		style,
		contentHash,
		scope,
		// F-3: record the absolute source path so a later promote re-reads the CURRENT bytes.
		sourcePath: resolve(path),
	});

	out(`asset: registered ${assetType} '${honeycombId}' at ${entry.tier}/${entry.style} (harness ${harness}).`);
	out(
		resolved.minted
			? `  honeycomb_id minted + ready to stamp (registry is authoritative).`
			: `  honeycomb_id resolved (rename-stable).`,
	);
	// `stamped` is computed so a caller can persist the frontmatter; v1 reports the id, not the rewrite.
	void stamped;
	return { exitCode: 0 };
}

/**
 * `asset promote <id> <tier>` / `asset demote <id> <tier>` (b-AC-2..6 / FR-2/FR-4/FR-5).
 * Both route through {@link transitionAsset}: a PROMOTE publishes at the new radius; a DEMOTE
 * tombstones every WIDER tier it leaves. The target tier is the second operand. On a promotion
 * the CLI re-reads the artifact's native blob + hash (a publish carries the bytes); a demotion
 * needs neither. An illegal transition is rejected with a clear message (b-AC-6).
 */
async function runTransition(
	deps: AssetCliDeps,
	verb: "promote" | "demote",
	inv: AssetCliInvocation,
	out: OutputSink,
): Promise<CommandResult> {
	const honeycombId = inv.args[0] ?? "";
	const tierArg = inv.args[1] ?? "";
	if (honeycombId === "" || tierArg === "") {
		out(`usage: honeycomb asset ${verb} <honeycomb_id> <${TIERS.join("|")}>`);
		return { exitCode: 1 };
	}
	if (!isTierStr(tierArg)) {
		out(`error: '${tierArg}' is not a tier. Choose one of: ${TIERS.join(", ")}.`);
		return { exitCode: 1 };
	}
	const toTier: Tier = tierArg;

	const registry = resolveRegistry(deps);
	const sync = resolveSync(deps);
	const device = resolveDevice(deps);
	const scope = resolveScope(deps, device);

	const current = registry.read().find((e) => e.honeycombId === honeycombId);
	if (current === undefined) {
		out(`error: unknown artifact '${honeycombId}'. Register it first (honeycomb asset register …).`);
		return { exitCode: 1 };
	}

	// A promotion publishes the artifact's CURRENT bytes — re-read them from the recorded source
	// path (F-3). A demotion (tombstone) carries no payload. Re-reading on every promote (rather
	// than trusting a stale snapshot) is what lets a teammate / 2nd device pull the actual content,
	// and reflects any on-disk edit made since register (master AC-2/AC-3, end-to-end).
	//
	// A promotion to a managed tier (Device/Team) with NO readable source is a HARD FAILURE: we
	// never publish an empty native blob (that would propagate empty content to the consumer). A
	// demotion, a same-tier move, or a promote that stays Local needs no bytes.
	let native: string | undefined;
	let contentHash: string | undefined;
	if (verb === "promote" && toTier !== "Local" && current.tier !== toTier) {
		const sourcePath = resolveSourcePath(current);
		const artifact = sourcePath !== null ? readArtifact(sourcePath, current.assetType) : null;
		if (artifact === null) {
			out(
				`error: cannot read the ${current.assetType} for '${honeycombId}' to publish its content` +
					`${sourcePath === null ? " (no source path on record)" : ` (source '${sourcePath}' is missing or unreadable)`}.`,
			);
			out("  re-register it (honeycomb asset register <path> …) so promote can publish the current bytes.");
			return { exitCode: 1 };
		}
		native = artifact.native;
		contentHash = hashArtifact(current.assetType, artifact.files);
	}

	try {
		const result = await transitionAsset(lifecycleDeps(sync, registry), {
			honeycombId,
			toTier,
			scope,
			...(native !== undefined ? { native } : {}),
			...(contentHash !== undefined ? { contentHash } : {}),
		});
		return renderTransition(verb, result, out);
	} catch (err) {
		if (err instanceof TransitionError) {
			out(`error: ${err.message}`);
			return { exitCode: 1 };
		}
		throw err;
	}
}

/**
 * `asset style <id> <style>` (b-AC-6 / FR-3). A pure style flip — orthogonal to tier, so it
 * publishes/tombstones nothing; it re-keys the cell in the registry through the SAME
 * {@link transitionAsset} authority (which still gates the endpoint). Ends in exactly one cell.
 */
async function runStyle(deps: AssetCliDeps, inv: AssetCliInvocation, out: OutputSink): Promise<CommandResult> {
	const honeycombId = inv.args[0] ?? "";
	const styleArg = inv.args[1] ?? "";
	if (honeycombId === "" || styleArg === "") {
		out(`usage: honeycomb asset style <honeycomb_id> <${STYLES.join("|")}>`);
		return { exitCode: 1 };
	}
	if (!isStyleStr(styleArg)) {
		out(`error: '${styleArg}' is not a style. Choose one of: ${STYLES.join(", ")}.`);
		return { exitCode: 1 };
	}
	const registry = resolveRegistry(deps);
	const sync = resolveSync(deps);
	const device = resolveDevice(deps);
	const scope = resolveScope(deps, device);

	if (registry.read().find((e) => e.honeycombId === honeycombId) === undefined) {
		out(`error: unknown artifact '${honeycombId}'. Register it first.`);
		return { exitCode: 1 };
	}
	try {
		const result = await transitionAsset(lifecycleDeps(sync, registry), { honeycombId, toStyle: styleArg, scope });
		out(`asset: '${honeycombId}' style → ${result.to.style} (tier ${result.to.tier} unchanged).`);
		return { exitCode: 0 };
	} catch (err) {
		if (err instanceof TransitionError) {
			out(`error: ${err.message}`);
			return { exitCode: 1 };
		}
		throw err;
	}
}

/** `asset list` (FR-1). Render every registered artifact's id + cell + harness (no DeepLake read). */
function runList(deps: AssetCliDeps, out: OutputSink): CommandResult {
	const registry = resolveRegistry(deps);
	const entries = [...registry.read()].sort((a, b) => (a.honeycombId < b.honeycombId ? -1 : 1));
	if (entries.length === 0) {
		out("assets: none registered yet (honeycomb asset register <path> --type <skill|agent> --harness <h>).");
		return { exitCode: 0 };
	}
	out("assets:");
	for (const e of entries) {
		out(`  ${e.honeycombId}  ${e.assetType}/${e.harness}  ${e.tier}/${e.style}  v${e.version}`);
	}
	return { exitCode: 0 };
}

/**
 * `asset device list` / `asset device revoke <device_id>` (D-1). `list` prints THIS machine's
 * device identity (id + label). `revoke <id>` writes a device tombstone through the daemon —
 * a Device-tier retraction addressed to the revoked device, so its next pull retracts the
 * Device-tier artifacts (the device leaves the author's "my devices" audience). No secret printed.
 */
async function runDevice(deps: AssetCliDeps, inv: AssetCliInvocation, out: OutputSink): Promise<CommandResult> {
	const device = resolveDevice(deps);
	const action = inv.args[0] ?? "";
	if (action === "list" || action === "") {
		out("device (this machine):");
		out(`  device_id = ${device.device_id}`);
		out(`  label     = ${device.label}`);
		return { exitCode: 0 };
	}
	if (action === "revoke") {
		const target = inv.args[1] ?? "";
		if (target === "") {
			out("usage: honeycomb asset device revoke <device_id>");
			return { exitCode: 1 };
		}
		const registry = resolveRegistry(deps);
		const sync = resolveSync(deps);
		const scope = resolveScope(deps, device);
		// Revocation tombstones every Device-tier artifact for the revoked device: the device leaves
		// the author's "my devices" audience, so the device's next pull retracts those artifacts (D-1).
		const deviceAssets = registry.read().filter((e) => e.tier === "Device" && e.deviceSet.includes(target));
		let revoked = 0;
		for (const e of deviceAssets) {
			const res = await sync.tombstone({
				honeycombId: e.honeycombId,
				assetType: e.assetType,
				harness: e.harness,
				cell: { tier: "Device", style: e.style },
				scope,
				// Address the tombstone to the revoked device so its pull retracts.
				deviceSet: [target],
			});
			if (res.tombstoned) {
				revoked++;
				// Narrow the local registry's device set: the revoked device leaves the audience.
				registry.upsert({ ...e, deviceSet: e.deviceSet.filter((d) => d !== target) });
			}
		}
		out(`device: revoked '${target}' — wrote ${revoked} device tombstone(s).`);
		return { exitCode: 0 };
	}
	out("usage: honeycomb asset device <list|revoke <device_id>>");
	return { exitCode: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering + small helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Render a {@link transitionAsset} result (publish/tombstone summary + the resulting cell). */
function renderTransition(
	verb: "promote" | "demote",
	result: { to: LatticeCell; from: LatticeCell; published: boolean; tombstonedTiers: readonly Tier[] },
	out: OutputSink,
): CommandResult {
	if (verb === "promote") {
		const where =
			result.to.tier === "Team"
				? "workspace radius"
				: result.to.tier === "Device"
					? "device radius"
					: "Local (unmanaged)";
		out(`asset: promoted ${result.from.tier} → ${result.to.tier} (${where})${result.published ? ", published" : ""}.`);
	} else {
		const left = result.tombstonedTiers.length > 0 ? ` — tombstoned ${result.tombstonedTiers.join(", ")}` : "";
		out(`asset: demoted ${result.from.tier} → ${result.to.tier}${left}.`);
	}
	out(`  now at ${result.to.tier}/${result.to.style}.`);
	return { exitCode: 0 };
}

/**
 * Resolve the on-disk source path to re-read on a promotion (F-3). `register` records the
 * absolute path of the agent FILE or the skill DIRECTORY as `entry.sourcePath`; promote reads
 * it back here. The CURRENT bytes at that path are then re-read + re-hashed so the publish
 * carries the real content (and reflects any edit made since register), exactly the single-file
 * shape (`SKILL.md` / the agent file) the install side writes — so publish↔install round-trips.
 *
 * Returns `null` when no source path is on record (an entry registered before this field, FR-3
 * back-compat). The caller treats `null` (and an unreadable path) as a HARD failure on a managed
 * promotion — it NEVER publishes an empty native blob.
 */
function resolveSourcePath(entry: RegistryEntry): string | null {
	return entry.sourcePath !== undefined && entry.sourcePath !== "" ? entry.sourcePath : null;
}

/** True when `value` is a valid asset type (`skill`/`agent`). */
function isAssetType(value: string): value is SyncedAssetType {
	return (SYNCED_ASSET_TYPES as readonly string[]).includes(value);
}

/** True when `value` is a valid style (`Repository`/`User`). */
function isStyleStr(value: string): value is Style {
	return (STYLES as readonly string[]).includes(value);
}

/** True when `value` is a valid tier (`Local`/`Device`/`Team`). */
function isTierStr(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

/** Match a registry entry to a freshly-read artifact by kind/harness (id resolution input). */
function sameArtifact(entry: RegistryEntry, assetType: SyncedAssetType, harness: string, _native: string): boolean {
	return entry.assetType === assetType && entry.harness === harness;
}

/** The usage block for the `asset` verb (printed for no/unknown subcommand). */
function usage(out: OutputSink): void {
	out("usage: honeycomb asset <register|promote|demote|style|list|device>");
	out("  register <path> --type <skill|agent> --harness <h> [--style <Repository|User>]");
	out("  promote <id> <Local|Device|Team>      raise the tier (publishes at the new radius)");
	out("  demote  <id> <Local|Device|Team>      lower the tier (tombstones every wider tier left)");
	out("  style   <id> <Repository|User>        flip the style (orthogonal to tier)");
	out("  list                                  show registered artifacts + their cell");
	out("  device  <list|revoke <device_id>>     show this device, or revoke one");
}

/**
 * Run the `asset` verb (b-AC-1..6). Routes the subcommand to its handler. The DeepLake side
 * (promote→publish, demote/revoke→tombstone) goes ONLY through the loopback daemon seam; the
 * registry is read/written locally. No subcommand (or an unknown one) prints usage. Never
 * prints a secret/token.
 */
export async function runAssetVerb(argv: readonly string[], deps: AssetCliDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const inv = parseAssetCliArgs(argv);

	switch (inv.subCommand) {
		case "register":
			return runRegister(deps, inv, out);
		case "promote":
			return runTransition(deps, "promote", inv, out);
		case "demote":
			return runTransition(deps, "demote", inv, out);
		case "style":
			return runStyle(deps, inv, out);
		case "list":
			return runList(deps, out);
		case "device":
			return runDevice(deps, inv, out);
		default:
			usage(out);
			return { exitCode: inv.subCommand === "" ? 0 : 1 };
	}
}
