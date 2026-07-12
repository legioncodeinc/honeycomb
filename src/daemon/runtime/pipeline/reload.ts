/**
 * Pipeline LIVE-RELOAD seams — the SP-1 fix for the ISS-001/ISS-005 boot snapshots
 * ("settings/secrets changes take effect only after a daemon restart").
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The memory pipeline historically snapshotted THREE inputs once, inside
 * `buildPipelineWorker` at boot, and never re-read them:
 *
 *   1. the inference {@link ModelClient} (built from the vault provider/model selection,
 *      the Portkey settings, and the `${SECRET_REF}` provider keys);
 *   2. the master `memory.enabled` gate (vault-first over `HONEYCOMB_PIPELINE_ENABLED`);
 *   3. the `'auto'` extraction sentinel, collapsed to a CONCRETE `'none'`/enabled token
 *      from a boot-time "is a provider key present?" probe.
 *
 * So saving an API key or flipping a setting from the dashboard did NOTHING until the
 * operator restarted the daemon. This module supplies the three seams that close that:
 *
 *   - {@link createPipelineReloadSeam} — a narrow, debounced, fire-and-forget trigger the
 *     settings/secrets WRITE APIs invoke post-persist. Assembly creates it UNBOUND (the
 *     mounts hold a stable reference), then `start()` binds the real reload once the
 *     pipeline worker exists. A burst of writes coalesces into ONE reload; the HTTP
 *     response is never blocked (the trigger only schedules).
 *   - {@link LiveModelClient} — a delegating {@link ModelClient} whose inner client the
 *     reload swaps in place, so every stage handler built at boot transparently calls the
 *     REBUILT client on its next job (no worker teardown, no re-wiring).
 *   - {@link createLiveExtractionGate} — the per-job extraction gate state: a live master
 *     `enabled` cell plus a TTL-debounced (~1s) secrets NAME-presence probe
 *     (`listSecretNames` — names only, never a decrypt), so `'auto'` is evaluated PER JOB
 *     against the CURRENT key state instead of being collapsed to `'none'` at boot.
 *
 * ── The TTL/debounce discipline ──────────────────────────────────────────────
 * The provider probe mirrors the stat-debounce documented in
 * `src/daemon/storage/live-reload.ts` (read its header — it exists for exactly this class
 * of bug): a cheap re-check at most once per window, no watcher handles, fail-soft. Here
 * the "stat" is a names-only secret listing, so the worst case is ~one listing per second
 * regardless of job throughput.
 *
 * ── FAIL-SOFT / FAIL-CLOSED ──────────────────────────────────────────────────
 * The reload seam never throws into a caller: a bound reload that rejects is routed to the
 * `onError` sink (stderr in production) and the daemon keeps serving on the last-good
 * clients. The extraction gate is fail-CLOSED: a secrets-store listing error reads as "no
 * provider configured", so `'auto'` never enables extraction on a broken store — the same
 * posture the boot probe had (and `no_model` fail-closed semantics are preserved upstream:
 * the reload re-reads the Portkey selection through the SAME `readPortkeySelection` reader,
 * so a missing `activeModel` still yields NO Portkey target, never a `model: ""` POST).
 */

import { DEFAULT_RESTAT_TTL_MS, type NowFn } from "../../storage/live-reload.js";
import { type ModelClient, type ModelRequest, type ModelWorkload, toModelRequest } from "./model-client.js";

/**
 * The debounce window for the reload trigger AND the TTL for the per-job provider probe.
 * Deliberately the SAME 1s constant `storage/live-reload.ts` uses for its stat debounce —
 * a settings/secret change is honored within about a second, and neither a write burst nor
 * a hot job loop can turn re-resolution into a stampede.
 */
export const PIPELINE_RELOAD_DEBOUNCE_MS = DEFAULT_RESTAT_TTL_MS;

/**
 * The narrow trigger the write APIs see (vault settings POST, secrets POST/DELETE, the
 * dashboard memory toggle). `requestReload` is synchronous, total, and non-throwing —
 * it only SCHEDULES; the actual rebuild runs debounced off the HTTP path.
 */
export interface PipelineReloadSeam {
	/**
	 * Request an in-process pipeline reload (rebuild the inference client + re-evaluate the
	 * extraction gate inputs). `reason` is a short, secret-free tag for observability (e.g.
	 * `"setting:activeModel"`, `"secret:set"`). Calls inside the debounce window coalesce.
	 */
	requestReload(reason: string): void;
}

/**
 * The assembly-side controller: the same seam the mounts hold, PLUS the late `bind` the
 * composition root calls once the pipeline worker (and therefore the real reload closure)
 * exists. A trigger that fires BEFORE `bind` is a clean no-op — before the worker is built
 * there is nothing to reload (boot reads the fresh state anyway).
 */
export interface PipelineReloadController extends PipelineReloadSeam {
	/** Bind the real reload target. Idempotent by replacement (the last bind wins). */
	bind(reload: () => Promise<void>): void;
}

/** The injectable timer seam (tests drive the debounce deterministically). */
export type ReloadScheduleFn = (fn: () => void, ms: number) => void;

/** Options for {@link createPipelineReloadSeam} (all optional; injectable for tests). */
export interface CreatePipelineReloadSeamOptions {
	/** The debounce window. Defaults to {@link PIPELINE_RELOAD_DEBOUNCE_MS}. */
	readonly debounceMs?: number;
	/** Injectable scheduler (tests). Defaults to an unref'd `setTimeout`. */
	readonly schedule?: ReloadScheduleFn;
	/** Where a failed reload's redacted reason goes (production: stderr). Default: dropped. */
	readonly onError?: (reason: string) => void;
}

/** The default scheduler: an unref'd `setTimeout` so a pending reload never holds the process open. */
function defaultSchedule(fn: () => void, ms: number): void {
	const timer = setTimeout(fn, ms);
	// `unref` exists on the Node timer; a bare environment without it simply keeps the handle.
	if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
}

/**
 * Build the debounced, late-bound reload trigger (the SP-1 seam). Trailing-edge debounce:
 * the FIRST `requestReload` in a quiet period schedules ONE run `debounceMs` later; every
 * further request inside the window coalesces into that run (so a dashboard "save settings"
 * burst — provider, model, portkey.* written back-to-back — costs one rebuild). A request
 * that arrives AFTER the run fired schedules a fresh run, so nothing is ever lost.
 */
export function createPipelineReloadSeam(
	options: CreatePipelineReloadSeamOptions = {},
): PipelineReloadController {
	const debounceMs = options.debounceMs ?? PIPELINE_RELOAD_DEBOUNCE_MS;
	const schedule = options.schedule ?? defaultSchedule;
	const onError = options.onError;

	let target: (() => Promise<void>) | null = null;
	let pending = false;

	return {
		bind(reload: () => Promise<void>): void {
			target = reload;
		},
		requestReload(_reason: string): void {
			// Coalesce: one scheduled run absorbs every request inside the window.
			if (pending) return;
			pending = true;
			schedule(() => {
				pending = false;
				const t = target;
				if (t === null) return; // unbound (no pipeline worker yet) → clean no-op.
				// Fire-and-forget: a reload failure is surfaced (never swallowed silently) but can
				// never throw into the scheduler or an HTTP handler; the last-good clients stand.
				void t().catch((err: unknown) => {
					const reason = err instanceof Error ? err.message : String(err);
					onError?.(reason);
				});
			}, debounceMs);
		},
	};
}

/**
 * A delegating {@link ModelClient} whose inner client is SWAPPABLE in place. The stage
 * handlers capture this ONE stable reference at boot; a live reload rebuilds the real
 * client (Portkey-backed, provider-backed, or the no-op) and calls {@link swap}, and the
 * very next job's `complete` rides the rebuilt client — no handler re-wiring, no worker
 * restart. Both `complete` call shapes are normalized via {@link toModelRequest}.
 */
export class LiveModelClient implements ModelClient {
	private inner: ModelClient;

	constructor(initial: ModelClient) {
		this.inner = initial;
	}

	/** Replace the delegate (the reload's atomic publish — a plain reference assignment). */
	swap(next: ModelClient): void {
		this.inner = next;
	}

	/** The current delegate (observability/tests only — never used to bypass the proxy). */
	current(): ModelClient {
		return this.inner;
	}

	complete(request: ModelRequest): Promise<string>;
	complete(workload: ModelWorkload, prompt: string): Promise<string>;
	complete(a: ModelRequest | ModelWorkload, b?: string): Promise<string> {
		return this.inner.complete(toModelRequest(a, b));
	}
}

/**
 * The LIVE inputs the extraction stage's per-job gate reads (ISS-001 — the `'auto'` fix).
 * `enabled()` is the CURRENT master gate (vault-first, updated by the reload seam);
 * `providerConfigured()` is the CURRENT credential-presence signal (TTL-debounced
 * names-only probe). Both are cheap, synchronous, total, and non-throwing.
 */
export interface ExtractionGateProbe {
	/** The live master `enabled` gate (boot: the vault-first resolution; then reload-updated). */
	enabled(): boolean;
	/** Whether the selected provider's credential NAME is currently present (fail-closed). */
	providerConfigured(): boolean;
}

/**
 * The assembly-side extraction gate: the {@link ExtractionGateProbe} the stage reads, PLUS
 * the setters the reload seam publishes through. One instance per pipeline worker.
 */
export interface LiveExtractionGate extends ExtractionGateProbe {
	/** Publish a re-resolved master `enabled` (the vault-first read the reload re-runs). */
	setEnabled(enabled: boolean): void;
	/** Publish the CURRENT credential secret NAMES the selection resolves through. */
	setCredentialNames(names: readonly string[]): void;
	/** Drop the probe's TTL cache so the NEXT job re-probes immediately (post-reload). */
	invalidate(): void;
}

/** Construction inputs for {@link createLiveExtractionGate}. */
export interface CreateLiveExtractionGateOptions {
	/** The boot-resolved master `enabled` (vault-first over the env). */
	readonly enabled: boolean;
	/**
	 * The secret NAMES whose presence makes the CURRENT selection "provider configured"
	 * (`PORTKEY_API_KEY` when the gateway is on; the `agent.yaml` accounts' `${SECRET_REF}`
	 * names otherwise). Empty → never configured (no routable selection).
	 */
	readonly credentialNames: readonly string[];
	/**
	 * The names-only listing (NEVER a value read, NEVER a decrypt) — production wraps
	 * `SecretsStore.listSecretNames` under the daemon scope. A throw reads as "no names"
	 * (fail-closed), mirroring `providerCredentialResolves` in the model-client factory.
	 */
	readonly listSecretNames: () => readonly string[];
	/** The probe TTL. Defaults to {@link PIPELINE_RELOAD_DEBOUNCE_MS} (~1s). */
	readonly ttlMs?: number;
	/** Injectable clock (tests advance it instead of sleeping). Defaults to `Date.now`. */
	readonly now?: NowFn;
}

/**
 * Build the live extraction gate. The `providerConfigured` probe is TTL-debounced exactly
 * like the mtime gate in `storage/live-reload.ts`: inside the window the last answer is
 * returned with NO listing; the first call after the window re-lists and re-derives. So a
 * provider key saved out-of-band (CLI, another process) is honored by the next job within
 * ~a second, and a hot job loop costs at most one listing per window.
 */
export function createLiveExtractionGate(options: CreateLiveExtractionGateOptions): LiveExtractionGate {
	const ttlMs = options.ttlMs ?? PIPELINE_RELOAD_DEBOUNCE_MS;
	const now = options.now ?? ((): number => Date.now());

	let enabled = options.enabled;
	let credentialNames: readonly string[] = options.credentialNames;
	let cachedConfigured = false;
	let hasCached = false;
	let lastProbeAt = Number.NEGATIVE_INFINITY;

	const probe = (): boolean => {
		// No credential name can ever match → configured is a constant false; skip the listing.
		if (credentialNames.length === 0) return false;
		let names: readonly string[];
		try {
			names = options.listSecretNames();
		} catch {
			// Fail-closed: a store/listing failure is "no resolvable credential", never a throw
			// into the job loop (mirrors providerCredentialResolves in the factory).
			return false;
		}
		const present = new Set<string>(names);
		return credentialNames.some((name) => present.has(name));
	};

	return {
		enabled(): boolean {
			return enabled;
		},
		providerConfigured(): boolean {
			const t = now();
			if (hasCached && t - lastProbeAt < ttlMs) return cachedConfigured;
			cachedConfigured = probe();
			hasCached = true;
			lastProbeAt = t;
			return cachedConfigured;
		},
		setEnabled(next: boolean): void {
			enabled = next;
		},
		setCredentialNames(names: readonly string[]): void {
			credentialNames = names;
		},
		invalidate(): void {
			hasCached = false;
			lastProbeAt = Number.NEGATIVE_INFINITY;
		},
	};
}
