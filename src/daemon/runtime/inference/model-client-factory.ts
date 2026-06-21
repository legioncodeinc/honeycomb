/**
 * Inference-backed ModelClient factory — PRD-026 AC-T (the daemon-assembly seam
 * that turns the inference router into a 006 {@link ModelClient}).
 *
 * Daemon assembly (a Wave-1c bee owns `assemble.ts`) injects a {@link ModelClient}
 * into every pipeline stage + the dreaming runner. Wave 1 of PRD-010 left a
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
 * A daemon without inference configured runs recall on lexical fallback and dreaming
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
import type { ModelClient } from "../pipeline/model-client.js";
import { createSecretResolver, type SecretsStore } from "../secrets/store.js";
import type { SecretScope } from "../secrets/contracts.js";
import { loadInferenceConfigFromYaml } from "./config.js";
import {
	type InferenceConfig,
	noopRoutingHistoryStore,
	type RoutingHistoryStore,
} from "./contracts.js";
import { createInferenceRouter, RouterModelClient } from "./router.js";
import { createAnthropicTransport } from "./transport-anthropic.js";

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
 * Build the inference-backed {@link ModelClient} (AC-T). Returns a
 * {@link RouterModelClient} when a routable {@link InferenceConfig} resolves, else
 * {@link noopModelClient}. NEVER throws — an absent, empty, or even malformed config
 * degrades to the no-op client (dreaming/extraction simply produce empty output,
 * which the defensive parsers treat as "no usable output", never a failed job).
 *
 * The provider transport is the real Anthropic Messages transport; the secret
 * resolver is the real machine-bound `.secrets/` resolver scoped to `deps.scope`.
 * The resolved key lives only inside one provider call (in the router's local
 * scope) — it never enters this factory's return value.
 */
export async function buildInferenceModelClient(deps: InferenceModelClientDeps): Promise<ModelClient> {
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
	const transport = createAnthropicTransport();
	const router = createInferenceRouter({
		config: effectiveConfig,
		transport,
		secrets,
		history: deps.history ?? noopRoutingHistoryStore,
	});
	return new RouterModelClient(router);
}
