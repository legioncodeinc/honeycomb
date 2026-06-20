/**
 * Production `CredentialReader` — PRD-021c Wave 2 (c-AC-2 / FR-2).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `contracts.ts` defines {@link CredentialReader} as the seam the hook runtime reads
 * `~/.honeycomb/credentials.json` through, so a hook speaks as the SAME authenticated
 * identity the CLI login wrote and the daemon reads (FR-2). The production impl was
 * deferred behind the seam; THIS fills it.
 *
 * ── WHY IT READS THE FILE DIRECTLY (thin-client discipline, D-2) ────────────
 * `src/hooks` is a NON_DAEMON_ROOT (`invariant.test.ts`): it may import NOTHING from
 * `daemon/storage`, directly or transitively. The daemon-side credentials store
 * (`src/daemon/runtime/auth/credentials-store.ts`) owns the WRITE discipline (0600
 * perms, server-stamped `savedAt`, the org-claim integrity gate); the hook only
 * needs to READ presence + token/org/actor to scope its daemon call. So this reads
 * the file with `node:fs` directly rather than importing daemon-side code — keeping
 * the hook a self-contained thin client. The daemon re-validates the token on every
 * request (it never trusts a header), so the hook's read is a HINT, not the gate.
 *
 * ── FAIL-SOFT, NEVER A THROW (FR-10) ────────────────────────────────────────
 * A missing OR malformed file resolves to `undefined` (read-only / signed-out mode),
 * never a throw — a hook with no credential proceeds unscoped and the daemon
 * fail-closes the write. The token is NEVER logged (security, Wave 3).
 *
 * ── ENV TOKEN (parity with the daemon-side store) ───────────────────────────
 * `HONEYCOMB_TOKEN` in the env wins over the file's token (the daemon-side store's
 * b-AC-5 rule), so a hook honors the same env-token override the CLI + daemon do.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CredentialReader, HookCredential } from "./contracts.js";

/** The credentials directory name under the user's home (mirrors the daemon-side store). */
export const CREDENTIALS_DIR_NAME = ".honeycomb" as const;
/** The credentials file name within the dir. */
export const CREDENTIALS_FILE_NAME = "credentials.json" as const;
/** The env var carrying the bearer token directly (parity with the daemon-side store). */
export const ENV_TOKEN = "HONEYCOMB_TOKEN" as const;

/** Options for {@link createCredentialReader} (all optional; injectable for tests). */
export interface CredentialReaderOptions {
	/** Override the credentials directory (tests). Defaults to `~/.honeycomb`. */
	readonly dir?: string;
	/** Injectable env (defaults to `process.env`) so the env-token rule is testable. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the production {@link CredentialReader} (c-AC-2 / FR-2). Reads
 * `~/.honeycomb/credentials.json` and maps the persisted {@link Credentials} shape
 * onto the minimal {@link HookCredential} the hook runtime needs (token / org /
 * actor). Returns `undefined` when the file is absent or malformed (read-only mode),
 * never a throw. The `HONEYCOMB_TOKEN` env override wins over the file's token.
 */
export function createCredentialReader(options: CredentialReaderOptions = {}): CredentialReader {
	const env = options.env ?? process.env;
	const dir = options.dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
	const path = join(dir, CREDENTIALS_FILE_NAME);

	return {
		async read(): Promise<HookCredential | undefined> {
			const fileCred = readFileCredential(path);
			const envToken = env[ENV_TOKEN];
			const hasEnvToken = typeof envToken === "string" && envToken.length > 0;

			// File absent/malformed: only an env token can carry an identity, but with no
			// file there is no org/actor to scope — so resolve to undefined (read-only). The
			// daemon resolves an env-only token to a tenancy server-side if one is configured.
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
 * Read + parse the credentials file into the minimal {@link FileCredential}. Returns
 * `undefined` on a missing OR malformed file (never a throw). A half-written file is
 * treated as absent — a partial credential is worse than none.
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
	// The persisted file carries `workspace` verbatim (mirrors the daemon-side
	// Credentials.workspace). It MUST be read here: the transport stamps it onto
	// metadata.workspace, which the daemon uses as the physical write partition.
	// Dropping it forced the `default` sentinel, landing every captured row in the
	// `default` partition while the daemon and read-back queried the credential's
	// real workspace — a silent tenancy mismatch that hid captures on read-back.
	const workspace = typeof rec.workspace === "string" && rec.workspace.length > 0 ? rec.workspace : undefined;
	return {
		token: rec.token,
		...(org !== undefined ? { org } : {}),
		...(workspace !== undefined ? { workspace } : {}),
		...(actor !== undefined ? { actor } : {}),
	};
}
