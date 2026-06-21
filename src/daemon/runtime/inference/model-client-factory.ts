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
	const secrets = createSecretResolver(deps.secretsStore, deps.scope);
	const transport = createAnthropicTransport();
	const router = createInferenceRouter({
		config,
		transport,
		secrets,
		history: deps.history ?? noopRoutingHistoryStore,
	});
	return new RouterModelClient(router);
}
