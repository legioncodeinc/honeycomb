/**
 * Inference-backed ModelClient factory — PRD-026 AC-T (the daemon-assembly seam
 * that turns the inference router into a 006 {@link ModelClient}).
 *
 * Daemon assembly (a Wave-1c bee owns `assemble.ts`) injects a {@link ModelClient}
 * into every pipeline stage + the pollinating runner. Wave 1 of PRD-010 left a
 * documented TODO: swap `noopModelClient` for `new RouterModelClient(router)` once a
 * real transport + config + secret resolver exist. This factory IS that swap,
 * packaged so the assembly bee calls ONE function:
 *
 *   const model = await buildInferenceModelClient({ scope, secretsStore, config });
 *
 * It constructs the real {@link createSecretResolver} + the real Anthropic
 * {@link createAnthropicTransport} + {@link createInferenceRouter}, and returns a
 * {@link RouterModelClient} typed as the 006 {@link ModelClient}. When NO inference
 * config is present/parseable, it returns {@link noopModelClient} — it NEVER throws.
 * A daemon without inference configured runs recall on lexical fallback and pollinating
 * is simply unavailable (the runner's no-op model yields an empty completion, which
 * the defensive parser turns into a zero-mutation pass — never a failed job).
 *
 * ── Why a string OR a path for `config` ──────────────────────────────────────
 * The assembly bee may already hold a resolved {@link InferenceConfig} (parsed once
 * at startup) OR only a path to `agent.yaml`. Both are accepted: a path is loaded
 * via `loadInferenceConfigFromYaml` (which returns `null` when the file or the
 * `inference:` block is absent — not an error), a resolved config is used directly.
 * Either way an empty/absent config → `noopModelClient`.
 *
 * ── Telemetry is the assembly's concern, not this factory's ──────────────────
 * The router's optional {@link RoutingHistoryStore} defaults to the no-op store
 * here. Wiring the real `history-store.ts` (which needs `storage`) is a separate
 * assembly step; this factory stays storage-free so it can be called before the
 * storage client is constructed, and a caller that wants telemetry passes a
 * `history` of its own.
 */

import { noopModelClient } from "../pipeline/model-client.js";
import type { ModelClient, ModelRequest, ModelWorkload } from "../pipeline/model-client.js";
import { createSecretResolver, type SecretsStore } from "../secrets/store.js";
import type { SecretScope } from "../secrets/contracts.js";
import { loadInferenceConfigFromYaml } from "./config.js";
import {
	type InferenceConfig,
	noopRoutingHistoryStore,
	type RoutingHistoryStore,
} from "./contracts.js";
import { createInferenceRouter, RouterModelClient } from "./router.js";
import { createAnthropicTransport, type UsageSink } from "./transport-anthropic.js";
import { createPortkeyTransport } from "./transport-portkey.js";

/** A resolved {@link InferenceConfig}, or a filesystem path to load `agent.yaml` from. */
export type InferenceConfigSource = InferenceConfig | string;

/**
 * A vault-driven provider/model SELECTION override (PRD-032d / AC-6). When the daemon's
 * `setting`-class vault carries an active provider + model, assembly passes it here so the
 * vault WINS over the committed `agent.yaml` target selection. This is SELECTION ONLY — the
 * credential keeps resolving through the `secret` class via the existing `${SECRET_REF}`
 * `apiKeyRef` (FR-2), which this override NEVER touches. Absent → the `agent.yaml` config is
 * used verbatim (no regression).
 */
export interface ProviderModelOverride {
	/** The catalog provider id the vault selected (e.g. `anthropic`). */
	readonly provider: string;
	/** The model id the vault selected, validated against the catalog before reaching here. */
	readonly model: string;
}

/**
 * The secret REFERENCE the Portkey transport resolves its key from (PRD-063b). The synthetic
 * Portkey {@link InferenceConfig} the factory builds points its single account's `apiKeyRef`
 * at this ref, so the router resolves it through the SAME `${SECRET_REF}` resolver (FR-2) — the
 * key is decrypted in-process at call time and NEVER inlined, logged, or returned (b-AC-3).
 */
export const PORTKEY_API_KEY_REF = "${PORTKEY_API_KEY}" as const;

/** The bare secret NAME the `${PORTKEY_API_KEY}` ref resolves (used for the presence check). */
export const PORTKEY_API_KEY_NAME = "PORTKEY_API_KEY" as const;

/** The synthetic account/target/policy/workload ids the Portkey config uses (internal, never user-facing). */
const PORTKEY_ACCOUNT_ID = "portkey-gateway" as const;
const PORTKEY_TARGET_ID = "portkey-target" as const;
const PORTKEY_POLICY_ID = "portkey-default" as const;

/**
 * The Portkey gateway SELECTION (PRD-063b — the SUPERSESSION). When `enabled` is true the factory
 * routes inference through the Portkey transport instead of the per-provider path: it resolves
 * `PORTKEY_API_KEY` via the `${SECRET_REF}` resolver, builds the Portkey transport with `config`,
 * and sends `model` (the vault `activeModel`, D-2) as the requested model — the Portkey config may
 * override it per its routing. This NEVER routes through {@link applyProviderModelOverride} (which
 * preserves the per-provider `apiKeyRef`); the per-provider key is neither required nor read.
 */
export interface PortkeySelection {
	/** Whether the Portkey gateway is ON (the `portkey.enabled` vault setting). */
	readonly enabled: boolean;
	/** The Portkey config / virtual-key id (the `portkey.config` vault setting). */
	readonly config: string;
	/** The requested model (the vault `activeModel`, D-2); Portkey's config may override it. */
	readonly model: string;
	/** Opt-in fallback to the per-provider path on an UNREACHABLE gateway (`portkey.fallbackToProvider`, D-3). */
	readonly fallbackToProvider: boolean;
}

/**
 * The honest outcome of resolving the Portkey path (PRD-063b / b-AC-4 / b-AC-7). The factory
 * returns this ALONGSIDE the {@link ModelClient} so assembly can derive `reasons.portkey` honestly
 * from config at assembly time (`off` / `ok` / `unconfigured`) WITHOUT a synchronous probe, and so
 * a missing key is a typed, named state rather than a silent success on some other provider.
 *
 *   - `off`          — the gateway toggle is off; the per-provider path is in force (no Portkey code).
 *   - `ok`           — Portkey is on, the key is present, and the Portkey-backed client is built.
 *   - `unconfigured` — Portkey is on but `PORTKEY_API_KEY` is absent → FAIL-CLOSED. The client is the
 *                      no-op (no provider key is silently used), even with fallback ON (a missing key
 *                      is a hard error regardless, D-3).
 */
export type PortkeyStatus = "off" | "ok" | "unconfigured";

/**
 * A typed Portkey misconfiguration error (b-AC-4). Thrown by {@link resolvePortkeyClient} when the
 * gateway is ON but `PORTKEY_API_KEY` is absent. The factory catches it to drive the `unconfigured`
 * status + the no-op client (fail-closed), so the daemon boots and `/health` reports the honest
 * reason rather than the daemon throwing or silently using a provider key. The message is short +
 * key-free (it names the absent SETTING, never a value).
 */
export class PortkeyUnconfiguredError extends Error {
	constructor() {
		super("portkey: enabled but PORTKEY_API_KEY is not set (fail-closed; set the key or disable portkey.enabled)");
		this.name = "PortkeyUnconfiguredError";
	}
}

/** Construction deps for {@link buildInferenceModelClient}. */
export interface InferenceModelClientDeps {
	/** The active secret scope the resolver decrypts under (org/workspace[/agent]). */
	readonly scope: SecretScope;
	/** The machine-bound `.secrets/` store the real {@link createSecretResolver} closes over. */
	readonly secretsStore: SecretsStore;
	/** A resolved {@link InferenceConfig} OR a path to load it from; absent/empty → no-op client. */
	readonly config: InferenceConfigSource;
	/** Optional telemetry sink; defaults to the no-op store (assembly wires the real one). */
	readonly history?: RoutingHistoryStore;
	/**
	 * An optional vault-driven provider/model SELECTION override (PRD-032d / AC-6). Additive:
	 * when present AND a routable {@link InferenceConfig} resolved, the resolved config's
	 * targets are rewritten so the vault-selected provider/model serve every routing decision
	 * (the vault wins over `agent.yaml`). When absent the resolved config is used as-is (no
	 * regression). The override changes only `account.provider` + `target.model` — never the
	 * `apiKeyRef`, so the `${SECRET_REF}` credential path is preserved (FR-2). If the override
	 * cannot be applied (no routable config to graft onto), it is ignored and the base config
	 * (or the no-op client) stands — the daemon never throws on a bad override.
	 */
	readonly providerModelOverride?: ProviderModelOverride;
	/**
	 * An optional usage meter the Anthropic transport reports each successful call's token
	 * usage to (PRD-060d / d-AC-1). This is how Honeycomb's OWN inference (the Haiku skillify
	 * gate, and any other own-inference workload routed here) threads its metered token counts
	 * into the pollination read-model. Absent → the transport's default no-op sink (no metering,
	 * zero behavior change). SELECTION/metering only — it never touches routing, the gate, or
	 * the `${SECRET_REF}` credential path.
	 */
	readonly usageSink?: UsageSink;
	/**
	 * The Portkey gateway SELECTION (PRD-063b). When present AND `enabled`, the factory routes
	 * inference through the Portkey transport (the SUPERSESSION) and the per-provider path +
	 * `providerModelOverride` are bypassed entirely. Absent or `enabled: false` → today's
	 * per-provider path runs UNCHANGED (b-AC-5, byte-identical). The Portkey path resolves
	 * `PORTKEY_API_KEY` through {@link createSecretResolver}; a missing key fails closed (b-AC-4).
	 */
	readonly portkey?: PortkeySelection;
	/**
	 * An OBSERVED-failure observer the Portkey transport calls when a real gateway call fails to
	 * connect / is auth-rejected (PRD-063b / b-AC-7). Assembly threads its cached last-failure
	 * signal here so `/health` flips `reasons.portkey` to `unreachable` from an ACTUAL runtime
	 * failure — never a synchronous probe. Only fires when the Portkey path is in force. Total +
	 * non-throwing. Absent → no signal wired.
	 */
	readonly onPortkeyUnreachable?: (statusCode: number) => void;
}

/**
 * The factory result when the caller needs the Portkey health status (PRD-063b / b-AC-7). Carries
 * the built {@link ModelClient} PLUS the honest {@link PortkeyStatus} assembly derives `/health`
 * `reasons.portkey` from. `buildInferenceModelClient` returns only the client (byte-identical to
 * its pre-063b signature); assembly calls {@link buildInferenceModelClientWithStatus} for the status.
 */
export interface InferenceModelClientResult {
	/** The built model client (Portkey-backed, provider-backed, or the no-op). */
	readonly client: ModelClient;
	/** The honest Portkey status for `/health` (`off` when Portkey is not in force). */
	readonly portkeyStatus: PortkeyStatus;
}

/**
 * Resolve the {@link InferenceConfigSource} to an {@link InferenceConfig}, or `null`
 * when none is available. A string is treated as a path and loaded via
 * `loadInferenceConfigFromYaml` (absent file / absent block → `null`, never a
 * throw). A resolved config object is returned as-is. A present-but-INVALID config
 * file still throws `InferenceConfigError` from the loader (fail-closed) — the
 * caller (`buildInferenceModelClient`) catches it and degrades to the no-op client.
 */
async function resolveConfig(source: InferenceConfigSource): Promise<InferenceConfig | null> {
	if (typeof source === "string") {
		return loadInferenceConfigFromYaml(source);
	}
	return source;
}

/** Whether a resolved config actually has something routable (at least one account + workload). */
function isRoutable(config: InferenceConfig): boolean {
	return config.accounts.length > 0 && config.workloads.length > 0;
}

/**
 * Apply a vault-driven provider/model SELECTION override onto a routable
 * {@link InferenceConfig} (PRD-032d / AC-6). The vault gives a `(provider, model)` pair from
 * the catalog; the committed `agent.yaml` supplies the routing GRAPH (accounts → targets →
 * policies → workloads) and — critically — the `apiKeyRef` (`${SECRET_REF}`) on each account.
 * We keep that graph and the credential refs intact, and ONLY:
 *   - set every account's `provider` to the vault provider (the transport selector), and
 *   - set every target's `model` to the vault model (the model the router serves).
 *
 * Result: whichever target the policy selects, it now runs the vault's provider/model while
 * still resolving the same `${SECRET_REF}` credential through the `secret` class (FR-2 — the
 * key is never inlined, never touched here). Targets keep their privacy tier + capabilities,
 * so the gates still behave; this is a SELECTION swap, not a re-architecture (D-5).
 *
 * Pure + total: returns a new config (the input is treated as immutable). The override is the
 * caller's already-catalog-validated pair, so no validation happens here.
 */
function applyProviderModelOverride(config: InferenceConfig, override: ProviderModelOverride): InferenceConfig {
	return {
		accounts: config.accounts.map((a) => ({ ...a, provider: override.provider })),
		targets: config.targets.map((t) => ({ ...t, model: override.model })),
		policies: config.policies,
		workloads: config.workloads,
	};
}

/**
 * Build the EXISTING per-provider {@link ModelClient} (PRD-026 AC-T — the pre-063b path,
 * unchanged). Returns a {@link RouterModelClient} when a routable {@link InferenceConfig}
 * resolves, else {@link noopModelClient}. NEVER throws — an absent, empty, or even malformed
 * config degrades to the no-op client (pollinating/extraction simply produce empty output, which
 * the defensive parsers treat as "no usable output", never a failed job).
 *
 * The provider transport is the real Anthropic Messages transport; the secret resolver is the
 * real machine-bound `.secrets/` resolver scoped to `deps.scope`. The resolved key lives only
 * inside one provider call (in the router's local scope) — it never enters the return value.
 *
 * This is the SAME body PRD-026 shipped; it was extracted out of `buildInferenceModelClient` so
 * the Portkey fallback target (D-3) can reuse it verbatim. With Portkey OFF/unset, the public
 * entry point delegates straight here, so the off-path is byte-identical (b-AC-5).
 */
async function buildProviderPathClient(deps: InferenceModelClientDeps): Promise<ModelClient> {
	let config: InferenceConfig | null;
	try {
		config = await resolveConfig(deps.config);
	} catch {
		// A malformed config file (or any load error) → run without inference. We do not
		// log the error body here (it could name a config path or value); the loader
		// itself surfaces a redacted InferenceConfigError to anyone who calls it directly.
		return noopModelClient;
	}
	if (config === null || !isRoutable(config)) {
		return noopModelClient;
	}
	// PRD-032d / AC-6: the vault wins over `agent.yaml` for provider/model SELECTION. When the
	// daemon resolved an active provider/model from the `setting` class, graft it onto the
	// routable base config (keeping the `${SECRET_REF}` apiKeyRef untouched — FR-2). Absent →
	// the `agent.yaml` config stands (no regression).
	const effectiveConfig =
		deps.providerModelOverride !== undefined
			? applyProviderModelOverride(config, deps.providerModelOverride)
			: config;
	const secrets = createSecretResolver(deps.secretsStore, deps.scope);
	// PRD-060d / d-AC-1: thread the optional usage meter into the transport so Honeycomb's own
	// inference (the Haiku skillify gate) surfaces its token usage to the pollination read-model.
	// Absent → the transport's default no-op sink (no metering, byte-for-byte prior behavior).
	const transport = createAnthropicTransport(
		deps.usageSink !== undefined ? { usageSink: deps.usageSink } : {},
	);
	const router = createInferenceRouter({
		config: effectiveConfig,
		transport,
		secrets,
		history: deps.history ?? noopRoutingHistoryStore,
	});
	return new RouterModelClient(router);
}

/**
 * Build the public inference-backed {@link ModelClient} (PRD-026 AC-T + PRD-063b). When the
 * Portkey gateway is OFF/unset this is byte-identical to the pre-063b factory (delegates to
 * {@link buildProviderPathClient}, b-AC-5). When Portkey is ON it routes through the Portkey
 * transport (the SUPERSESSION, b-AC-2). NEVER throws — a Portkey misconfiguration degrades to
 * the no-op client (fail-closed, b-AC-4), and the per-provider path keeps its pre-063b
 * no-throw degradation. Callers that need the `/health` status call
 * {@link buildInferenceModelClientWithStatus} instead.
 */
export async function buildInferenceModelClient(deps: InferenceModelClientDeps): Promise<ModelClient> {
	const { client } = await buildInferenceModelClientWithStatus(deps);
	return client;
}

/**
 * Build the model client AND the honest Portkey {@link PortkeyStatus} (PRD-063b / b-AC-7). The
 * status is derived from config at assembly — `off` when the gateway is off, `ok` when on + keyed,
 * `unconfigured` when on but the key is absent — with NO synchronous network probe. Assembly maps
 * it onto `/health` `reasons.portkey`. NEVER throws.
 */
export async function buildInferenceModelClientWithStatus(
	deps: InferenceModelClientDeps,
): Promise<InferenceModelClientResult> {
	const portkey = deps.portkey;
	// Portkey OFF/unset → today's per-provider path, byte-identical (b-AC-5). Status `off`.
	if (portkey === undefined || !portkey.enabled) {
		return { client: await buildProviderPathClient(deps), portkeyStatus: "off" };
	}
	// Portkey ON: try to build the Portkey-backed client. A missing key is a typed, honest error
	// (PortkeyUnconfiguredError) that we map to fail-closed: the no-op client + `unconfigured`
	// status. We never silently use a provider key for a missing Portkey key — even with fallback
	// ON (a MISSING key is a hard error regardless, D-3 / b-AC-4).
	try {
		const client = await resolvePortkeyClient(deps, portkey);
		return { client, portkeyStatus: "ok" };
	} catch (err) {
		if (err instanceof PortkeyUnconfiguredError) {
			// Fail-closed: no provider key is used. The no-op client boots cleanly (empty,
			// zero-mutation passes) and `/health` reports the honest `unconfigured` reason.
			return { client: noopModelClient, portkeyStatus: "unconfigured" };
		}
		// Any other unexpected build error also fails closed to the no-op (never a provider-key
		// leak); the daemon boots and reports `unconfigured` rather than throwing.
		return { client: noopModelClient, portkeyStatus: "unconfigured" };
	}
}

/**
 * Build the Portkey-backed {@link ModelClient} (b-AC-2 / b-AC-3 / b-AC-4). Resolves the
 * `PORTKEY_API_KEY` presence FIRST (fail-closed: a missing key throws {@link PortkeyUnconfiguredError}
 * BEFORE any client is built — a missing key is never a provider fallback, D-3). With the key present,
 * constructs a SYNTHETIC single-entry {@link InferenceConfig} whose account `apiKeyRef` is
 * `${PORTKEY_API_KEY}` (so the router resolves the key through the SAME `${SECRET_REF}` resolver —
 * the key is decrypted in-process per call, never inlined or logged, b-AC-3) and a Portkey transport
 * carrying the `config` id. Sends `portkey.model` (the vault `activeModel`, D-2). Does NOT route
 * through {@link applyProviderModelOverride} (which preserves a per-provider apiKeyRef).
 *
 * When `fallbackToProvider` is ON, the returned client is a {@link PortkeyFallbackModelClient} that
 * tries Portkey first and, on an UNREACHABLE/transport gateway error, routes the SAME request through
 * the per-provider path (resolving the provider's `${SECRET_REF}` as today). When OFF (default), an
 * unreachable gateway surfaces the transport error (fail-closed).
 */
async function resolvePortkeyClient(deps: InferenceModelClientDeps, portkey: PortkeySelection): Promise<ModelClient> {
	// Presence check FIRST (fail-closed on a missing key, BEFORE building anything). We probe the
	// scope's secret NAMES (names-only, never a value read) so a missing key is an honest
	// `unconfigured`, not a confusing per-call rejection later. This NEVER decrypts the key.
	const names = deps.secretsStore.listSecretNames(deps.scope);
	if (!names.includes(PORTKEY_API_KEY_NAME as (typeof names)[number])) {
		throw new PortkeyUnconfiguredError();
	}

	const secrets = createSecretResolver(deps.secretsStore, deps.scope);
	const transport = createPortkeyTransport({
		config: portkey.config,
		...(deps.usageSink !== undefined ? { usageSink: deps.usageSink } : {}),
		...(deps.onPortkeyUnreachable !== undefined ? { onTransportError: deps.onPortkeyUnreachable } : {}),
	});
	const router = createInferenceRouter({
		config: buildPortkeyConfig(portkey.model),
		transport,
		secrets,
		history: deps.history ?? noopRoutingHistoryStore,
	});
	const portkeyClient: ModelClient = new RouterModelClient(router);

	// D-3 default (fallback OFF): the Portkey client stands alone — an unreachable gateway throws
	// the transport error (fail-closed). The stage wrapper treats a rejection as "no usable output",
	// and assembly's last-failure signal flips `/health` to `unreachable`.
	if (!portkey.fallbackToProvider) {
		return portkeyClient;
	}

	// D-3 fallback ON: build the per-provider path client too and wrap both so an UNREACHABLE
	// gateway transparently retries the SAME request through the provider path. A missing
	// PORTKEY_API_KEY already hard-errored above, so this branch is only reached with the key present.
	const providerClient = await buildProviderPathClient(deps);
	return new PortkeyFallbackModelClient(portkeyClient, providerClient);
}

/**
 * Build the SYNTHETIC Portkey {@link InferenceConfig} (PRD-063b). One account → one target → one
 * `automatic` policy that reaches it → one workload per 006 token, all routing to the single
 * Portkey target. The account's `apiKeyRef` is `${PORTKEY_API_KEY}` so the router resolves the key
 * through the existing `${SECRET_REF}` resolver (FR-2). `model` is the vault `activeModel` (D-2);
 * Portkey's server-side config may override it. The target advertises the `chat` capability + the
 * `public` privacy tier with a large context window so the router's gates always admit it (Portkey
 * abstracts the underlying provider — the per-provider privacy-tier reasoning is intentionally
 * bypassed when Portkey is on; see the PRD privacy-tier note, flagged for security-worker-bee).
 */
function buildPortkeyConfig(model: string): InferenceConfig {
	return {
		accounts: [{ id: PORTKEY_ACCOUNT_ID, provider: "portkey", apiKeyRef: PORTKEY_API_KEY_REF }],
		targets: [
			{
				id: PORTKEY_TARGET_ID,
				accountRef: PORTKEY_ACCOUNT_ID,
				model,
				privacyTier: "public",
				capabilities: ["chat"],
				contextWindow: 1_000_000,
			},
		],
		policies: [{ id: PORTKEY_POLICY_ID, mode: "strict", chain: [PORTKEY_TARGET_ID] }],
		workloads: [
			{ name: "memory_extraction", policyRef: PORTKEY_POLICY_ID, requiredCapabilities: ["chat"], minPrivacyTier: "public" },
			{ name: "memory_decision", policyRef: PORTKEY_POLICY_ID, requiredCapabilities: ["chat"], minPrivacyTier: "public" },
			{ name: "memory_pollinating", policyRef: PORTKEY_POLICY_ID, requiredCapabilities: ["chat"], minPrivacyTier: "public" },
		],
	};
}

/**
 * The opt-in fallback {@link ModelClient} (D-3 / b-AC-4). Tries the Portkey client first; on an
 * UNREACHABLE/transport gateway error (a connect failure → 503, or an auth/5xx the gateway returns,
 * surfaced as a {@link RoutingExhaustedError} wrapping the transport's {@link ProviderError}) it
 * routes the SAME request through the per-provider path. A non-transport error (e.g. the provider
 * path also exhausting) propagates. This client is ONLY constructed when `PORTKEY_API_KEY` is
 * present, so it can never paper over a missing-key hard error.
 */
export class PortkeyFallbackModelClient implements ModelClient {
	private readonly portkey: ModelClient;
	private readonly provider: ModelClient;

	constructor(portkey: ModelClient, provider: ModelClient) {
		this.portkey = portkey;
		this.provider = provider;
	}

	complete(request: ModelRequest): Promise<string>;
	complete(workload: ModelWorkload, prompt: string): Promise<string>;
	async complete(a: ModelRequest | ModelWorkload, b?: string): Promise<string> {
		try {
			// The two-overload signature is forwarded by reconstructing the call shape.
			return typeof a === "string" ? await this.portkey.complete(a, b as string) : await this.portkey.complete(a);
		} catch (err) {
			// Only an UNREACHABLE/transport gateway failure falls back (D-3). A connect failure is a
			// 503 and an auth-rejection a 401/4xx — both ride a ProviderError the router re-wraps; we
			// treat any error reaching here as the gateway being unusable for this request and retry
			// the SAME request through the per-provider path (which resolves the provider key as today).
			void err;
			return typeof a === "string" ? this.provider.complete(a, b as string) : this.provider.complete(a);
		}
	}
}
