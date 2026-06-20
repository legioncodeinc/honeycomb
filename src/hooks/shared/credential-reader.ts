/**
 * Production `CredentialReader` — PRD-021c Wave 2 (c-AC-2 / FR-2) + PRD-023 Wave 3 (the shared
 * `~/.deeplake` repoint).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `contracts.ts` defines {@link CredentialReader} as the seam the hook runtime reads the shared
 * credentials file through, so a hook speaks as the SAME authenticated identity a `honeycomb login`
 * (or `hivemind login`) wrote and the daemon reads (FR-2). The production impl was deferred behind
 * the seam; THIS fills it.
 *
 * ── PRD-023: the file moved to the SHARED `~/.deeplake/credentials.json` (D-1) ─
 * Honeycomb and Hivemind now share ONE credentials file at `~/.deeplake/credentials.json` in
 * Hivemind's EXACT on-disk shape (`workspaceId`, not `workspace`). One login authenticates BOTH
 * tools, and the capture/hook path must read THAT file so a `honeycomb login` OR a `hivemind login`
 * credential flows through to capture. So this reads:
 *   1. `~/.deeplake/credentials.json` first — the new shared file (Hivemind shape: the workspace is
 *      the `workspaceId` field, the org is `orgId`, the actor is the additive `agentId`);
 *   2. else the LEGACY `~/.honeycomb/credentials.json` (the pre-PRD-023 Honeycomb shape, whose
 *      workspace was the `workspace` field) — read-only back-compat, never written.
 * The first file present wins; a malformed shared file falls through to the legacy read.
 *
 * ── WHY IT READS THE FILE DIRECTLY (thin-client discipline, D-2) ────────────
 * `src/hooks` is a NON_DAEMON_ROOT (`invariant.test.ts`): it may import NOTHING from `daemon/storage`,
 * directly or transitively — and (by the same thin-client discipline) it does NOT import the
 * daemon-side credentials store (`src/daemon/runtime/...`) either. It mirrors the minimal path +
 * shape logic here with `node:fs` so the hook stays a SELF-CONTAINED thin client. The daemon-side
 * store owns the WRITE discipline (0600 perms, server-stamped `savedAt`, the org-claim integrity
 * gate); the daemon re-validates the token on every request (it never trusts a header), so the
 * hook's read is a HINT, not the gate.
 *
 * ── FAIL-SOFT, NEVER A THROW (FR-10) ────────────────────────────────────────
 * A missing OR malformed file (both locations) resolves to `undefined` (read-only / signed-out mode),
 * never a throw — a hook with no credential proceeds unscoped and the daemon fail-closes the write.
 * The token is NEVER logged (security, Wave 3).
 *
 * ── ENV TOKEN (parity with the daemon-side store) ───────────────────────────
 * `HONEYCOMB_TOKEN` in the env wins over the file's token (the daemon-side store's b-AC-5 rule), so a
 * hook honors the same env-token override the CLI + daemon do.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CredentialReader, HookCredential } from "./contracts.js";

/**
 * The SHARED credentials directory name under the user's home (PRD-023 D-1). Mirrors the daemon-side
 * store's `CREDENTIALS_DIR_NAME` WITHOUT importing it (thin-client discipline).
 */
export const CREDENTIALS_DIR_NAME = ".deeplake" as const;
/** The LEGACY Honeycomb credentials directory (pre-PRD-023) — read-only fallback, never written. */
export const LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb" as const;
/** The credentials file name within either dir. */
export const CREDENTIALS_FILE_NAME = "credentials.json" as const;
/** The env var carrying the bearer token directly (parity with the daemon-side store). */
export const ENV_TOKEN = "HONEYCOMB_TOKEN" as const;

/** Options for {@link createCredentialReader} (all optional; injectable for tests). */
export interface CredentialReaderOptions {
	/** Override the SHARED credentials directory (tests). Defaults to `~/.deeplake`. */
	readonly dir?: string;
	/** Override the LEGACY credentials directory (tests). Defaults to `~/.honeycomb`. */
	readonly legacyDir?: string;
	/** Injectable env (defaults to `process.env`) so the env-token rule is testable. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the production {@link CredentialReader} (c-AC-2 / FR-2 + PRD-023). Reads the SHARED
 * `~/.deeplake/credentials.json` first (Hivemind shape — workspace is `workspaceId`), falling back to
 * the legacy `~/.honeycomb/credentials.json` (old Honeycomb shape — workspace is `workspace`), and
 * maps the persisted shape onto the minimal {@link HookCredential} the hook runtime needs (token /
 * org / workspace / actor). Returns `undefined` when neither file yields a usable credential
 * (read-only mode), never a throw. The `HONEYCOMB_TOKEN` env override wins over the file's token.
 */
export function createCredentialReader(options: CredentialReaderOptions = {}): CredentialReader {
	const env = options.env ?? process.env;
	const sharedPath = join(options.dir ?? join(homedir(), CREDENTIALS_DIR_NAME), CREDENTIALS_FILE_NAME);
	const legacyPath = join(options.legacyDir ?? join(homedir(), LEGACY_CREDENTIALS_DIR_NAME), CREDENTIALS_FILE_NAME);

	return {
		async read(): Promise<HookCredential | undefined> {
			// PRD-023 read precedence: the shared `~/.deeplake` file first (workspaceId), else the legacy
			// `~/.honeycomb` file (workspace). The first that yields a usable credential wins.
			const fileCred = readFileCredential(sharedPath) ?? readFileCredential(legacyPath);
			const envToken = env[ENV_TOKEN];
			const hasEnvToken = typeof envToken === "string" && envToken.length > 0;

			// Both files absent/malformed: with no file there is no org/actor to scope, so resolve to
			// undefined (read-only). The daemon resolves an env-only token to a tenancy server-side.
			if (fileCred === undefined) {
				return undefined;
			}

			return {
				// The env token wins over the file's token (parity with the daemon-side store).
				token: hasEnvToken ? envToken : fileCred.token,
				...(fileCred.org !== undefined ? { org: fileCred.org } : {}),
				...(fileCred.workspace !== undefined ? { workspace: fileCred.workspace } : {}),
				...(fileCred.actor !== undefined ? { actor: fileCred.actor } : {}),
			};
		},
	};
}

/** The subset of the on-disk credential the hook reads (token + org + workspace + actor). */
interface FileCredential {
	readonly token: string;
	readonly org?: string;
	readonly workspace?: string;
	readonly actor?: string;
}

/**
 * Read + parse a credentials file into the minimal {@link FileCredential}. Returns `undefined` on a
 * missing OR malformed file (never a throw) so the caller can fall through to the next location. A
 * half-written file is treated as absent — a partial credential is worse than none.
 *
 * Accepts BOTH on-disk shapes (PRD-023): the new shared `~/.deeplake` file uses `workspaceId` for the
 * workspace; the legacy `~/.honeycomb` file used `workspace`. The org is `orgId` and the actor is
 * `agentId` in both. The workspace is read from `workspaceId` FIRST (the shared shape), then
 * `workspace` (the legacy shape), so EITHER file scopes the capture correctly. Dropping the workspace
 * forced the `default` sentinel, landing every captured row in the `default` partition while the
 * daemon and read-back queried the credential's real workspace — a silent tenancy mismatch that hid
 * captures on read-back.
 */
function readFileCredential(path: string): FileCredential | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const rec = parsed as Record<string, unknown>;
	// The token is the load-bearing field — a credential with no token is not usable.
	if (typeof rec.token !== "string" || rec.token.length === 0) return undefined;
	// The persisted file uses `orgId` for the org and `agentId` for the actor label.
	const org = typeof rec.orgId === "string" ? rec.orgId : undefined;
	const actor = typeof rec.agentId === "string" ? rec.agentId : undefined;
	// PRD-023: the shared `~/.deeplake` file carries `workspaceId` (Hivemind shape); the legacy
	// `~/.honeycomb` file carried `workspace`. Read `workspaceId` first, then `workspace`, so a file
	// written by EITHER tool scopes the capture to the right physical write partition.
	const wsId = typeof rec.workspaceId === "string" && rec.workspaceId.length > 0 ? rec.workspaceId : undefined;
	const wsLegacy = typeof rec.workspace === "string" && rec.workspace.length > 0 ? rec.workspace : undefined;
	const workspace = wsId ?? wsLegacy;
	return {
		token: rec.token,
		...(org !== undefined ? { org } : {}),
		...(workspace !== undefined ? { workspace } : {}),
		...(actor !== undefined ? { actor } : {}),
	};
}
