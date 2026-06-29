/**
 * The npm-registry `@latest` reader (PRD-064e version source).
 *
 * The auto-update poll needs the version npm currently tags `@latest` for
 * `@legioncodeinc/honeycomb`. We read it from the registry's JSON metadata endpoint
 * (`https://registry.npmjs.org/<pkg>/latest`) over the Node 22 global `fetch`, behind an
 * injected {@link RegistryFetch} seam so tests never hit the network (binding constraint:
 * "every npm/registry/CDN/health call behind injectable interfaces").
 *
 * This reads METADATA only -- it never runs `npm install`. The install is the engine's
 * job ({@link file://./update-engine.ts}) and goes through the injected command runner.
 *
 * Fail-soft (design principle 1): any transport error, non-2xx, or unparseable body
 * resolves to `null` ("latest unknown"), never a throw. A null latest means the poll
 * simply does nothing this tick -- it can never trigger an update.
 *
 * Built-ins ONLY: the global `fetch` + an AbortController timeout. No npm client, no
 * `npm view` shell-out on the hot path.
 */

/** The default registry metadata URL builder for a package's `@latest` dist-tag. */
export function defaultLatestUrl(pkg: string): string {
	// The `/latest` abbreviated endpoint returns the manifest of the @latest dist-tag.
	return `https://registry.npmjs.org/${pkg}/latest`;
}

/** The default bounded fetch timeout (ms). */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 5_000 as const;

/** The minimal response shape the reader consumes. */
export interface RegistryFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}

/** The minimal request init the reader passes. */
export interface RegistryFetchInit {
	readonly method: string;
	readonly signal?: AbortSignal;
}

/** The injectable fetch seam. Tests pass a recorder; production uses globalThis.fetch. */
export type RegistryFetch = (url: string, init: RegistryFetchInit) => Promise<RegistryFetchResponse>;

/** Reads the latest published version of the primary package, or null when unknown. Injected. */
export type ReadLatestVersionFn = () => Promise<string | null>;

/** Options for {@link createRegistryLatestReader}. */
export interface RegistryReaderOptions {
	/** The npm package whose `@latest` is read. */
	readonly pkg: string;
	/** Network seam (default: the global `fetch`). */
	readonly fetch?: RegistryFetch;
	/** Override the metadata URL (default {@link defaultLatestUrl}). */
	readonly url?: string;
	/** Bounded fetch timeout in ms (default {@link DEFAULT_REGISTRY_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/**
 * Extract the `version` string from the registry's abbreviated `/latest` manifest body.
 * Returns null when the body is not JSON or carries no usable `version` string. Defensive.
 */
export function parseLatestVersion(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const version = (parsed as Record<string, unknown>).version;
	return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
}

/**
 * Build a {@link ReadLatestVersionFn} that reads npm `@latest` over the injected fetch
 * seam. Fail-soft: any error resolves to null. NEVER throws.
 */
export function createRegistryLatestReader(options: RegistryReaderOptions): ReadLatestVersionFn {
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as RegistryFetch);
	const url = options.url ?? defaultLatestUrl(options.pkg);
	const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

	return async (): Promise<string | null> => {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, timeoutMs);
		try {
			const resp = await doFetch(url, { method: "GET", signal: controller.signal });
			if (!resp.ok) return null;
			const body = await resp.text();
			return parseLatestVersion(body);
		} catch {
			// Transport error / timeout / abort: latest is unknown this tick. Fail-soft.
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
