/**
 * DeepLake storage config: zod-validated, fail-closed (PRD-002a FR-2 / a-AC-3).
 *
 * Config is resolved once at daemon startup from a credentials provider seam.
 * Today the seam reads `HONEYCOMB_DEEPLAKE_*` from the environment; the real
 * secret store is PRD-012 and slots in behind the same `CredentialProvider`
 * interface without touching the client. Validation is fail-closed: a missing
 * endpoint/token/org or an out-of-range knob throws a structured
 * `StorageConfigError` at init, so the daemon never starts against bad config
 * and never reaches first-write before discovering it (the coding-standards
 * fail-closed posture, D-1).
 *
 * Decision D-1 (binding): connection/auth model is a config object
 * { endpoint, token, org, timeout, tracing } validated by zod. Org travels as
 * a request header (resolved per query — see client.ts). Single shared
 * connection, per-query org resolution (D-2).
 */

import { z } from "zod";

import { DEFAULT_DEEPLAKE_API_URL, loadDiskCredentials } from "../runtime/auth/credentials-store.js";

/** Default per-statement timeout when `HONEYCOMB_QUERY_TIMEOUT_MS` is unset. */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Coercing, clamping schema for the query timeout. A non-numeric or negative
 * value is clamped to a non-negative range rather than rejected: `0` means
 * "abort immediately", never "block forever" (FR-4). `NaN` falls back to the
 * default. Upper-bounded so a fat-fingered value can't disable the guard.
 */
const QueryTimeoutMs = z.preprocess((raw) => {
	// Coerce here so a non-numeric value (e.g. "abc") becomes the default rather
	// than failing the whole config — the timeout is a tuning knob, not a
	// required field. A negative/oversized value is clamped, never rejected.
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_QUERY_TIMEOUT_MS;
	// Clamp to [0, 10 minutes]. Non-negative per the fail-closed posture.
	return Math.min(Math.max(0, Math.trunc(n)), 600_000);
}, z.number());

/**
 * The validated storage config the client runs against. Credentials are kept
 * here in memory only; redaction (FR-8) happens at every log/error boundary.
 */
export const StorageConfigSchema = z.object({
	/** DeepLake HTTP query endpoint, e.g. https://api.deeplake.ai. */
	endpoint: z.string().url("endpoint must be a valid URL"),
	/** Bearer token. Never logged in full — see redactToken. */
	token: z.string().min(1, "token must not be empty"),
	/** Org identity sent as a request header so DeepLake enforces tenancy. */
	org: z.string().min(1, "org must not be empty"),
	/** Workspace/partition the queries target within the org. */
	workspace: z.string().min(1, "workspace must not be empty"),
	/** Per-statement timeout, clamped non-negative. */
	queryTimeoutMs: QueryTimeoutMs.default(DEFAULT_QUERY_TIMEOUT_MS),
	/** SQL tracing gate (FR-6). Evaluated at call time, see client.ts. */
	traceSql: z.boolean().default(false),
});

/** The validated config object every storage layer reads. */
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/**
 * Structured config error. Carries the flattened zod issues so the daemon can
 * log exactly which knob failed without echoing the bad values (which may hold
 * a token). Distinct error type so a config failure is never mistaken for a
 * runtime query failure.
 */
export class StorageConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid DeepLake storage config: ${issues.join("; ")}`);
		this.name = "StorageConfigError";
		this.issues = issues;
	}
}

/**
 * The credentials provider seam (D-1). The env provider is the default today;
 * PRD-012's secret store implements the same interface later. Returns the raw,
 * un-validated record — validation is the schema's job so there is one
 * fail-closed gate, not two.
 */
export interface CredentialProvider {
	/** Read the raw config record. Missing keys yield undefined, not throw. */
	read(): Record<string, unknown>;
}

/**
 * Default provider: reads `HONEYCOMB_DEEPLAKE_*` from the environment plus the
 * shared tuning/tracing knobs. This is daemon-only code and is never bundled
 * into the OpenClaw target (which forbids `process.env`), so a direct env read
 * is correct here.
 */
export function envCredentialProvider(env: NodeJS.ProcessEnv = process.env): CredentialProvider {
	return {
		read(): Record<string, unknown> {
			return {
				endpoint: env.HONEYCOMB_DEEPLAKE_ENDPOINT,
				token: env.HONEYCOMB_DEEPLAKE_TOKEN,
				org: env.HONEYCOMB_DEEPLAKE_ORG,
				workspace: env.HONEYCOMB_DEEPLAKE_WORKSPACE,
				queryTimeoutMs: env.HONEYCOMB_QUERY_TIMEOUT_MS,
				traceSql: env.HONEYCOMB_TRACE_SQL === "1" || env.HONEYCOMB_TRACE_SQL === "true",
			};
		},
	};
}

/**
 * Options for {@link deeplakeCredentialsFileProvider} / {@link defaultCredentialProvider},
 * injectable so a test points the file read at a temp HOME without touching the real
 * `~/.deeplake` (PRD-023 AC-7, deterministic). All optional.
 */
export interface CredentialsFileProviderOptions {
	/** Override the SHARED `~/.deeplake` credentials dir (tests). */
	readonly dir?: string;
	/** Override the legacy `~/.honeycomb` dir for the read-fallback (tests). */
	readonly legacyDir?: string;
	/** Injectable env (defaults to `process.env`) so the `HONEYCOMB_TOKEN` rule is testable. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * The SHARED-FILE credential provider (PRD-023 D-3 / AC-7). Reads the shared
 * `~/.deeplake/credentials.json` (Hivemind shape, with legacy `~/.honeycomb`
 * read-fallback) via {@link loadDiskCredentials} and maps it onto the storage config
 * record:
 *
 *   { endpoint ← apiUrl, token, org ← orgId, workspace ← workspaceId }
 *
 * `apiUrl` defaults to {@link DEFAULT_DEEPLAKE_API_URL} when the file omits it (a
 * legacy file has no `apiUrl`), so a file-only resolve still yields a valid endpoint.
 * `queryTimeoutMs` / `traceSql` are NOT credential fields — they are env-only tuning
 * knobs, so this provider leaves them undefined (the schema applies its defaults).
 *
 * A MISSING file or a file MISSING keys yields UNDEFINED fields — never a throw. The
 * zod `resolveStorageConfig` is the single fail-closed validation gate (so a file with
 * no token resolves to `{ token: undefined }` → a `StorageConfigError`, not a silent
 * pass). The token is NEVER logged here (D-4).
 */
export function deeplakeCredentialsFileProvider(options: CredentialsFileProviderOptions = {}): CredentialProvider {
	return {
		read(): Record<string, unknown> {
			const env = options.env ?? process.env;
			const disk = loadDiskCredentials(options.dir, env, options.legacyDir);
			if (disk === null) {
				// No usable file → all-undefined record; the schema fails closed if this is
				// the only provider and nothing supplies the required fields.
				return {
					endpoint: undefined,
					token: undefined,
					org: undefined,
					workspace: undefined,
					orgName: undefined,
				};
			}
			return {
				// `apiUrl` is the DeepLake base URL; a legacy file omits it → the canonical default.
				endpoint: disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : DEFAULT_DEEPLAKE_API_URL,
				token: disk.token,
				org: disk.orgId,
				workspace: disk.workspaceId,
				// The friendly org name (display only) — NOT a storage-config field (the zod
				// schema strips it). Carried so the daemon's settings view can show "OSPRY"
				// instead of the org GUID. Never load-bearing for the connection.
				orgName: disk.orgName,
			};
		},
	};
}

/**
 * The DAEMON DEFAULT credential provider (PRD-023 D-3 / AC-7): ENV-OVER-FILE, merged
 * PER FIELD. A present `HONEYCOMB_DEEPLAKE_*` env value WINS over the shared file's
 * field; an absent (undefined) env value falls back to the file's value. This is the
 * provider the daemon assembly uses by default so that:
 *   - after `honeycomb login` (or a seeded shared file) with NO env, the file supplies
 *     all four of `{ endpoint, token, org, workspace }` and the daemon connects (AC-7);
 *   - any `HONEYCOMB_DEEPLAKE_*` override still wins per-field (the escape hatch).
 *
 * The tuning knobs (`queryTimeoutMs`, `traceSql`) come from the ENV provider only — the
 * file carries no tuning knobs — so they pass through whatever the env provider read.
 * Missing-everywhere fields stay undefined and the zod schema fails closed on the
 * required ones. The token is NEVER logged here (D-4).
 */
export function defaultCredentialProvider(options: CredentialsFileProviderOptions = {}): CredentialProvider {
	const env = options.env ?? process.env;
	const envProvider = envCredentialProvider(env);
	const fileProvider = deeplakeCredentialsFileProvider(options);
	return {
		read(): Record<string, unknown> {
			const fromEnv = envProvider.read();
			const fromFile = fileProvider.read();
			// Per-field merge: env wins when present (not undefined), else the file's value.
			// `mergeField` treats only `undefined` as "absent" so an explicit empty string in
			// the env still wins (and is then rejected by the zod min(1) gate, fail-closed) —
			// never silently widened to the file's value.
			return {
				endpoint: mergeField(fromEnv.endpoint, fromFile.endpoint),
				token: mergeField(fromEnv.token, fromFile.token),
				org: mergeField(fromEnv.org, fromFile.org),
				workspace: mergeField(fromEnv.workspace, fromFile.workspace),
				// The friendly org name is a file-only display field (the env provider carries
				// none) — passed through from the file so the daemon's settings view can show it.
				// The zod storage-config schema strips it; it is never part of the connection.
				orgName: fromFile.orgName,
				// Tuning knobs are env-only (the file carries none).
				queryTimeoutMs: fromEnv.queryTimeoutMs,
				traceSql: fromEnv.traceSql,
			};
		},
	};
}

/** Pick the env value when it is present (not undefined), else the file value (D-3). */
function mergeField(envValue: unknown, fileValue: unknown): unknown {
	return envValue !== undefined ? envValue : fileValue;
}

/**
 * Validate raw config into a StorageConfig, failing closed. Throws
 * StorageConfigError listing every issue. This is the single boundary where
 * untrusted config crosses into typed config (zod-at-boundary discipline).
 */
export function resolveStorageConfig(provider: CredentialProvider): StorageConfig {
	const parsed = StorageConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new StorageConfigError(issues);
	}
	return parsed.data;
}

/**
 * Redact a credential/org value for logs and errors (FR-8). Never echoes a
 * token in full: keeps the last 4 chars for correlation, masks the rest. An
 * empty/short value collapses to a fixed mask so length isn't leaked either.
 */
export function redactToken(value: string): string {
	if (value.length <= 4) return "****";
	return `****${value.slice(-4)}`;
}
