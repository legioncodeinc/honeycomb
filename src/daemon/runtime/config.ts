/**
 * Daemon runtime config resolver (PRD-004a FR-1 / a-AC-1 / a-AC-7).
 *
 * Resolves the daemon's listen address and deployment mode from the environment,
 * validated by zod, FAIL-CLOSED — mirroring the storage `config.ts` pattern
 * (coerce/clamp tuning knobs, reject structurally-invalid required values). An
 * invalid `HONEYCOMB_BIND` is rejected here at resolution (impl-note edge case),
 * so the daemon never reaches `listen()` against a bad address.
 *
 * Bind posture (D-1, binding): default `127.0.0.1:3850`. `HONEYCOMB_PORT`,
 * `HONEYCOMB_HOST`, and `HONEYCOMB_BIND` override port, host, and bind address.
 * Default is loopback; a team deployment widens explicitly via `HONEYCOMB_BIND`
 * (e.g. `0.0.0.0`). Resolution is pure (env in → typed config out), so the
 * server bootstrap is constructed with the resolved address and the whole
 * surface is verifiable in-process without binding a real socket.
 *
 * Deployment mode (`local` | `team` | `hybrid`) drives the permission
 * middleware: `local` is open, `team`/`hybrid` enforce. Resolved from
 * `HONEYCOMB_MODE`, default `local` (the safe single-user posture).
 */

import { z } from "zod";
import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";

/** The three deployment modes (FR-3). `local` is open; `team`/`hybrid` enforce. */
export const DEPLOYMENT_MODES = Object.freeze(["local", "team", "hybrid"] as const);
/** A resolved deployment mode. */
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/** Loopback host — the only address reachable from the same machine. */
const LOOPBACK_HOST = DAEMON_HOST; // "127.0.0.1"

/**
 * Coercing, clamping schema for the listen port. A non-numeric value falls back
 * to the default (a port is a tuning knob, not a structurally-required field); a
 * value outside the valid TCP range is clamped into `[1, 65535]` rather than
 * silently disabling the bind. `0` is NOT allowed (it means "OS picks a port",
 * which would make the daemon unreachable at a known address) — it clamps to 1.
 */
const Port = z.preprocess((raw) => {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return DAEMON_PORT;
	return Math.min(Math.max(1, Math.trunc(n)), 65_535);
}, z.number().int());

/**
 * Host validation. A host must be a non-empty token with no whitespace and no
 * scheme/path — it is an interface address or hostname, never a URL. An empty or
 * malformed host is REJECTED (fail-closed), not defaulted, so a typo surfaces at
 * resolution instead of binding to an unintended interface.
 */
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
const Host = z
	.string()
	.trim()
	.min(1, "host must not be empty")
	.regex(HOST_PATTERN, "host must be a bare hostname or IP, not a URL");

/**
 * The resolved runtime config the server bootstrap binds against. `host` is the
 * effective listen address after `HONEYCOMB_BIND` widening; `widened` records
 * whether the bind was explicitly widened off loopback (a-AC-7), so diagnostics
 * and `/api/status` can report the posture without re-deriving it.
 */
export const RuntimeConfigSchema = z.object({
	/** Effective listen host (post-`HONEYCOMB_BIND` widening). */
	host: Host.default(LOOPBACK_HOST),
	/** Listen port, clamped into the valid TCP range. */
	port: Port.default(DAEMON_PORT),
	/** Deployment mode driving permission enforcement (FR-3). */
	mode: z.enum(DEPLOYMENT_MODES).default("local"),
	/** True when the bind was widened off loopback via `HONEYCOMB_BIND` (a-AC-7). */
	widened: z.boolean().default(false),
});

/** The validated runtime config every server layer reads. */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Structured runtime-config error. Carries the flattened zod issues so the
 * daemon logs exactly which knob failed without echoing the bad value. Distinct
 * type so a bind-config failure is never mistaken for a runtime request failure.
 */
export class RuntimeConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid daemon runtime config: ${issues.join("; ")}`);
		this.name = "RuntimeConfigError";
		this.issues = issues;
	}
}

/**
 * The runtime-config provider seam. Mirrors the storage `CredentialProvider`
 * seam: returns the raw, un-validated record so validation is the schema's job
 * (one fail-closed gate, not two). The env provider is the default; a test
 * injects a fixed record.
 */
export interface RuntimeConfigProvider {
	/** Read the raw runtime-config record. Missing keys yield undefined. */
	read(): RawRuntimeConfig;
}

/** The raw shape the provider yields before validation. */
export interface RawRuntimeConfig {
	readonly port?: unknown;
	readonly host?: unknown;
	readonly bind?: unknown;
	readonly mode?: unknown;
}

/**
 * Default provider: reads `HONEYCOMB_PORT` / `HONEYCOMB_HOST` / `HONEYCOMB_BIND`
 * / `HONEYCOMB_MODE` from the environment. Daemon-only code (never bundled into
 * the OpenClaw target), so a direct env read is correct here.
 */
export function envRuntimeConfigProvider(env: NodeJS.ProcessEnv = process.env): RuntimeConfigProvider {
	return {
		read(): RawRuntimeConfig {
			return {
				port: env.HONEYCOMB_PORT,
				host: env.HONEYCOMB_HOST,
				bind: env.HONEYCOMB_BIND,
				mode: env.HONEYCOMB_MODE,
			};
		},
	};
}

/**
 * Resolve the raw record into a validated `RuntimeConfig`, failing closed.
 *
 * Precedence (FR-1): `HONEYCOMB_BIND`, when set, is the effective host and marks
 * the bind as widened (a-AC-7) — it is the explicit "widen off loopback" knob,
 * so it wins over `HONEYCOMB_HOST`. When `HONEYCOMB_BIND` is unset, `HONEYCOMB_HOST`
 * (default loopback) is the host and the bind is NOT widened. Either way an
 * invalid address is rejected by the `Host` schema, so the daemon never binds to
 * a malformed interface (impl-note edge case).
 *
 * Throws `RuntimeConfigError` listing every issue. This is the single boundary
 * where untrusted env crosses into typed config (zod-at-boundary discipline).
 */
export function resolveRuntimeConfig(provider: RuntimeConfigProvider = envRuntimeConfigProvider()): RuntimeConfig {
	const raw = provider.read();

	// `HONEYCOMB_BIND` is the explicit widening knob and takes precedence over
	// `HONEYCOMB_HOST`. We only treat it as "set" when it is a non-empty string,
	// so `HONEYCOMB_BIND=""` is the same as unset (no accidental empty-host bind).
	const bindSet = typeof raw.bind === "string" && raw.bind.trim().length > 0;
	const effectiveHost = bindSet ? raw.bind : raw.host;

	const parsed = RuntimeConfigSchema.safeParse({
		host: effectiveHost,
		port: raw.port,
		mode: raw.mode,
		widened: bindSet && !isLoopback(String(raw.bind).trim()),
	});

	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new RuntimeConfigError(issues);
	}
	return parsed.data;
}

/** Loopback addresses — a bind to one of these is not a "widening" (a-AC-7). */
function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
