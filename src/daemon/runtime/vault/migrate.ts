/**
 * The DeepLake-creds migration + the vault→env→file token resolver — PRD-032a
 * (AC-3, the highest-risk item — non-destructive by construction).
 *
 * ── The one rule that defines this module ────────────────────────────────────
 * The shared `~/.deeplake/credentials.json` is the SHARED Hivemind login (one
 * `hivemind login` OR `honeycomb login` authenticates BOTH tools). The migration
 * COPIES the token into the vault as a `secret`-class record; it NEVER moves, deletes,
 * rewrites, re-chmods, or otherwise touches the plaintext file (D-3). The plaintext file
 * stays BYTE-UNCHANGED and authoritative for the shared login — the vault is an ADDITIVE
 * cache, not a replacement.
 *
 * Concretely, {@link migrateDeeplakeToken}:
 *   - READS the token via the existing {@link loadDiskCredentials} (the only read path —
 *     it applies the `HONEYCOMB_TOKEN` env rule and the legacy fallback);
 *   - WRITES it into the vault as the `secret` record {@link DEEPLAKE_TOKEN_NAME};
 *   - performs ZERO writes to `~/.deeplake` — there is no `writeFileSync`, `rmSync`,
 *     `chmodSync`, or `renameSync` against the creds path anywhere in this file.
 *
 * ── Resolution order: vault → env → file (D-3 / FR-7) ────────────────────────
 * {@link resolveDeeplakeToken} resolves the live DeepLake token in this precedence:
 *   1. the VAULT (`secret`/`DEEPLAKE_TOKEN`) — the migrated copy, machine-bound;
 *   2. the ENV (`HONEYCOMB_TOKEN`) — an operator override;
 *   3. the plaintext FILE (`~/.deeplake/credentials.json`) — the shared login, never
 *      regressed: a "vault empty" path STILL resolves the login from the file.
 * The login resolves in EVERY case — an empty vault is not a regression (AC-5 / FR-7).
 */

import {
	type DiskCredentials,
	loadDiskCredentials,
} from "../auth/credentials-store.js";
import type { SecretScope } from "./contracts.js";
import type { VaultStore } from "./store.js";

/**
 * The `secret`-class record name the DeepLake login token is copied into (D-3). A
 * traversal-proof, env-var-style name so it round-trips through the secret-name validator
 * and is readable in a `honeycomb secret list`.
 */
export const DEEPLAKE_TOKEN_NAME = "DEEPLAKE_TOKEN" as const;

/** The injectable creds reader — defaults to the real {@link loadDiskCredentials}. */
export interface DeeplakeCredsReader {
	/** Read the on-disk DeepLake creds (or `null` when absent/malformed). Never throws. */
	read(): DiskCredentials | null;
}

/** The default reader: the shared `~/.deeplake/credentials.json` via the existing loader. */
export const systemDeeplakeCredsReader: DeeplakeCredsReader = {
	read(): DiskCredentials | null {
		return loadDiskCredentials();
	},
};

/** The typed outcome of {@link migrateDeeplakeToken}. */
export type MigrateResult =
	/** The token was copied into the vault (or already present and refreshed). */
	| { readonly ok: true; readonly migrated: true }
	/** No plaintext creds to migrate (the file is absent/malformed) — a NO-OP, not an error. */
	| { readonly ok: true; readonly migrated: false; readonly reason: "no_creds" }
	/** The vault write failed (e.g. IO). The plaintext file is STILL untouched. */
	| { readonly ok: false; readonly reason: string };

/**
 * COPY the DeepLake login token from the plaintext `~/.deeplake/credentials.json` into the
 * vault as a `secret`-class record (AC-3 / AC-4). NON-DESTRUCTIVE by construction: this
 * function reads the creds and writes the VAULT — it issues NO write to the creds file.
 *
 * Idempotent: re-running overwrites the vault record with the current token (a fresh
 * machine-bound ciphertext), so a token rotation in the plaintext file is picked up on the
 * next migrate. When no usable creds exist, it is a NO-OP returning `migrated: false`
 * (`no_creds`) — never an error, and never a vault write.
 *
 * The `reader` + `scope` are injected so a test points the read at a temp creds file and
 * the write at a temp vault, never the real `~/.deeplake` or the real workspace.
 */
export async function migrateDeeplakeToken(
	store: VaultStore,
	scope: SecretScope,
	reader: DeeplakeCredsReader = systemDeeplakeCredsReader,
): Promise<MigrateResult> {
	const creds = reader.read();
	// A "no creds" path is a no-op: the plaintext file is absent/malformed, so there is
	// nothing to copy and nothing to break. The login still resolves from env/file later.
	if (creds === null || creds.token.length === 0) {
		return { ok: true, migrated: false, reason: "no_creds" };
	}
	// COPY: write the token into the vault `secret` class. NO write to the creds file.
	const res = await store.setSecret(DEEPLAKE_TOKEN_NAME, creds.token, scope);
	if (!res.ok) {
		return { ok: false, reason: res.reason };
	}
	return { ok: true, migrated: true };
}

/**
 * The DeepLake token resolution chain — VAULT → ENV → FILE (D-3 / FR-7 / AC-5).
 *
 * Resolves the live DeepLake login token in precedence order, returning the FIRST that
 * resolves and a `source` tag so a caller can log WHERE the token came from (never the
 * token itself):
 *   1. `vault` — the migrated `secret`/`DEEPLAKE_TOKEN`, decrypted in-process (machine-
 *      bound). The vault wins so a migrated token is preferred.
 *   2. `env`   — `HONEYCOMB_TOKEN`, an operator override.
 *   3. `file`  — the plaintext `~/.deeplake/credentials.json` token, the shared login —
 *      so an EMPTY vault still resolves the login (no regression, AC-5).
 *
 * Returns `{ ok: false }` only when ALL THREE are empty (genuinely not logged in). The
 * token value is returned to the in-process caller (this IS the resolver path); it is never
 * logged here. `env` + `reader` are injected for tests.
 *
 * ── INTENTIONALLY STAGED, not yet on the live-connection path (D-3) ──────────
 * As of PRD-032 the boot path COPIES the token into the vault (see {@link migrateDeeplakeToken}
 * fired in `assemble.ts` `start()`), but the live DeepLake storage connection still resolves its
 * token through `loadDiskCredentials` (env→file), keeping the plaintext file AUTHORITATIVE for the
 * shared Hivemind login — exactly D-3 ("the plaintext file remains authoritative for the shared
 * login until a later PRD changes that contract"). This resolver is the documented, tested seam a
 * FOLLOW-UP PRD will swap the connection onto (so the swap is a one-line call-site change, not a
 * new mechanism). It is deliberately not yet wired to a live caller — staged, not dead.
 */
export async function resolveDeeplakeToken(
	store: VaultStore,
	scope: SecretScope,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly reader?: DeeplakeCredsReader;
	} = {},
): Promise<{ ok: true; token: string; source: "vault" | "env" | "file" } | { ok: false }> {
	const env = options.env ?? process.env;
	const reader = options.reader ?? systemDeeplakeCredsReader;

	// 1. The vault (the migrated copy). The secret resolver is internal — this IS that path.
	const fromVault = await store.getSecretValue(DEEPLAKE_TOKEN_NAME, scope);
	if (fromVault.ok && fromVault.value.length > 0) {
		return { ok: true, token: fromVault.value, source: "vault" };
	}

	// 2. The env override.
	const envToken = env.HONEYCOMB_TOKEN;
	if (typeof envToken === "string" && envToken.length > 0) {
		return { ok: true, token: envToken, source: "env" };
	}

	// 3. The plaintext file (the shared login) — an empty vault still resolves here.
	const creds = reader.read();
	if (creds !== null && creds.token.length > 0) {
		return { ok: true, token: creds.token, source: "file" };
	}

	return { ok: false };
}
