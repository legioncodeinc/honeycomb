/**
 * The blessed-version channel (PRD-064e, OD-3 resolved -- the safety, not the TTL).
 *
 * Before the auto-update engine installs npm `@latest`, it must confirm that version is
 * BLESSED for auto-rollout: a static `blessed-version.json` object on the install CDN
 * (`get.theapiary.sh`), flipped by a CI "bless" step gated on canary + smoke health.
 * `@latest` on npm is necessary but NOT sufficient (PRD-064e Scope). A 30-min poll
 * against raw `@latest` would fan a bad publish across the fleet in 30 minutes; the
 * blessed gate is what makes auto-update safe.
 *
 * ── FAIL-CLOSED (binding) ───────────────────────────────────────────────────
 * If the channel is unreachable, times out, returns non-2xx, or returns a body that is
 * not parseable JSON with a valid `version` string, {@link fetchBlessedVersion} resolves
 * to `{ ok: false, reason }` -- NEVER a version. The caller treats any non-ok result as
 * "stay on the current version" (AC-064e.2, second half). Fetching the channel can never
 * trigger an update; only a positively-parsed blessed version can.
 *
 * ── Built-ins ONLY ──────────────────────────────────────────────────────────
 * The fetch goes through an injected {@link BlessedFetch} seam (defaults to the Node 22
 * global `fetch`) so tests never hit the network. The POST/GET is bounded by an
 * AbortController timeout and wrapped in a try/catch that swallows all transport errors
 * (design principle 1, "incapable of crashing"). No zod: the body is hand-validated.
 */

/** The default install-CDN URL of the blessed-version object. */
export const DEFAULT_BLESSED_URL = "https://get.theapiary.sh/blessed-version.json" as const;

/** The default bounded fetch timeout (ms). A wedged CDN socket must never hang the loop. */
export const DEFAULT_BLESSED_TIMEOUT_MS = 5_000 as const;

/**
 * The parsed, validated blessed-version manifest. The schema is deliberately minimal
 * (PRD-064e open question on schema): a single `version` string is required; an optional
 * `minVersion` lets a later bless step express "auto-update only from >= minVersion"
 * without a code change. Unknown fields are ignored (forward-compatible).
 */
export interface BlessedManifest {
	/** The version approved for auto-rollout (must be a non-empty string). */
	readonly version: string;
	/** Optional floor: installs older than this are not eligible to forward-update. */
	readonly minVersion?: string;
}

/** The result of fetching the blessed channel. Fail-closed: a failure is a value, never a throw. */
export type BlessedFetchResult =
	| { readonly ok: true; readonly manifest: BlessedManifest }
	| { readonly ok: false; readonly reason: BlessedFailReason };

/** Why the blessed channel did not yield a usable manifest (all fail-closed). */
export type BlessedFailReason =
	| "unreachable" // transport error / timeout / abort
	| "non_2xx" // the CDN answered but not with a 2xx
	| "unparseable" // body was not JSON, or `version` was missing/empty/not a string
	;

/** The minimal response shape the channel reads (mirrors the telemetry fetch seam). */
export interface BlessedFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}

/** The minimal request init the channel passes. */
export interface BlessedFetchInit {
	readonly method: string;
	readonly signal?: AbortSignal;
}

/** The injectable fetch seam. Tests pass a recorder; production uses globalThis.fetch. */
export type BlessedFetch = (url: string, init: BlessedFetchInit) => Promise<BlessedFetchResponse>;

/** Options for {@link fetchBlessedVersion} (all optional; production defaults provided). */
export interface BlessedChannelOptions {
	/** The blessed-version.json URL (default {@link DEFAULT_BLESSED_URL}). */
	readonly url?: string;
	/** Network seam (default: the global `fetch`). */
	readonly fetch?: BlessedFetch;
	/** Bounded fetch timeout in ms (default {@link DEFAULT_BLESSED_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/**
 * Hand-validate a parsed JSON body into a {@link BlessedManifest}, or `null` when it does
 * not carry a usable `version` string. Zod-free (built-ins only). An object missing
 * `version`, with a non-string `version`, or with an empty `version` is rejected.
 */
export function parseBlessedManifest(parsed: unknown): BlessedManifest | null {
	if (parsed === null || typeof parsed !== "object") return null;
	const o = parsed as Record<string, unknown>;
	if (typeof o.version !== "string" || o.version.trim().length === 0) return null;
	const manifest: BlessedManifest = {
		version: o.version.trim(),
		...(typeof o.minVersion === "string" && o.minVersion.trim().length > 0
			? { minVersion: o.minVersion.trim() }
			: {}),
	};
	return manifest;
}

/**
 * Fetch + parse the blessed-version manifest from the install CDN. FAIL-CLOSED: any
 * transport error, non-2xx status, or unparseable/invalid body resolves to
 * `{ ok: false, reason }` so the caller stays on the current version. NEVER throws.
 */
export async function fetchBlessedVersion(options: BlessedChannelOptions = {}): Promise<BlessedFetchResult> {
	const url = options.url ?? DEFAULT_BLESSED_URL;
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as BlessedFetch);
	const timeoutMs = options.timeoutMs ?? DEFAULT_BLESSED_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	let body: string;
	try {
		const resp = await doFetch(url, { method: "GET", signal: controller.signal });
		if (!resp.ok) return { ok: false, reason: "non_2xx" };
		body = await resp.text();
	} catch {
		// Transport error, DNS failure, timeout, or abort -- fail-closed: stay on current.
		return { ok: false, reason: "unreachable" };
	} finally {
		clearTimeout(timer);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, reason: "unparseable" };
	}

	const manifest = parseBlessedManifest(parsed);
	if (manifest === null) return { ok: false, reason: "unparseable" };
	return { ok: true, manifest };
}
