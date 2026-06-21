/**
 * The curated provider→model catalog — PRD-032a (D-6, single-sourced).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * The ONE module that names the providers and the models a `setting` may select (D-6).
 * The CLI selector (032b) and the dashboard panel (032c) both read FROM here, so a model
 * id is a ONE-LINE edit in {@link PROVIDER_CATALOG} — never duplicated across surfaces.
 * A live model-fetch is deferred (D-6); this is a curated static list.
 *
 * ── The shipped providers (D-6) ──────────────────────────────────────────────
 *   - `anthropic`   → a CLOSED model list: `claude-sonnet-4-6`, `claude-opus-4-8`.
 *   - `openai`      → a CLOSED model list: `gpt-4o` (+ siblings `gpt-4o-mini`, `gpt-4.1`).
 *   - `openrouter`  → an OPEN list: a free-form model id passes through (OpenRouter routes
 *                     to many upstreams; we don't curate its catalog).
 *
 * ── Validation contract (the API + CLI both call this) ───────────────────────
 * {@link isValidProviderModel} is the single gate: for a CLOSED-list provider the model
 * must be IN the list; for `openrouter` any non-empty id is accepted. The
 * `setting`-class accessors store the chosen provider/model as plain strings (the class
 * value schema is a scalar); this catalog is the SEMANTIC validator the API layer applies
 * on top, so a write of `activeModel` is checked against the chosen `activeProvider`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Provider ids
// ─────────────────────────────────────────────────────────────────────────────

/** The curated provider ids (D-6). The selector offers exactly these. */
export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
/** A curated provider id. */
export type Provider = (typeof PROVIDERS)[number];

/** Narrow a candidate to a known {@link Provider}, or `null`. */
export function asProvider(value: unknown): Provider | null {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value) ? (value as Provider) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider entry in the catalog. `models` is the curated, ORDERED list (the selector's
 * default is `models[0]`). `openEnded` marks a provider (OpenRouter) whose model id is a
 * free-form passthrough — `models` is then a SUGGESTION list, not a closed set.
 */
export interface ProviderEntry {
	/** The provider id. */
	readonly id: Provider;
	/** The human-readable provider name (display only). */
	readonly label: string;
	/** The curated model ids (ordered; `models[0]` is the default). */
	readonly models: readonly string[];
	/** When true, an arbitrary non-empty model id is accepted (OpenRouter passthrough). */
	readonly openEnded: boolean;
}

/**
 * THE catalog (D-6). Single-sourced — edit a model id HERE and every surface reflects it.
 *
 * NOTE the Anthropic ids match the repo's committed `agent.yaml` (`claude-sonnet-4-6`) and
 * this build's model (`claude-opus-4-8`). To add a model, add ONE string to its `models`.
 */
export const PROVIDER_CATALOG: readonly ProviderEntry[] = Object.freeze([
	Object.freeze({
		id: "anthropic" as Provider,
		label: "Anthropic",
		models: Object.freeze(["claude-sonnet-4-6", "claude-opus-4-8"]),
		openEnded: false,
	}),
	Object.freeze({
		id: "openai" as Provider,
		label: "OpenAI",
		models: Object.freeze(["gpt-4o", "gpt-4o-mini", "gpt-4.1"]),
		openEnded: false,
	}),
	Object.freeze({
		id: "openrouter" as Provider,
		label: "OpenRouter",
		// Suggestions only — OpenRouter accepts a free-form `vendor/model` id (passthrough).
		models: Object.freeze(["anthropic/claude-sonnet-4.6", "openai/gpt-4o"]),
		openEnded: true,
	}),
]);

/** Look up a provider's catalog entry, or `undefined` for an unknown provider. */
export function providerEntry(provider: string): ProviderEntry | undefined {
	return PROVIDER_CATALOG.find((p) => p.id === provider);
}

/** The default model for a provider (its `models[0]`), or `undefined` for an unknown provider. */
export function defaultModelFor(provider: string): string | undefined {
	return providerEntry(provider)?.models[0];
}

/**
 * The single validation gate (D-6) the API + CLI apply when a `setting` selects a model.
 * For a CLOSED-list provider (`anthropic`/`openai`) the model MUST be in the list; for an
 * OPEN provider (`openrouter`) any non-empty model id is accepted. An unknown provider is
 * always invalid. Fail-closed: anything not explicitly allowed is rejected.
 */
export function isValidProviderModel(provider: string, model: string): boolean {
	const entry = providerEntry(provider);
	if (entry === undefined) return false;
	if (typeof model !== "string" || model.length === 0) return false;
	if (entry.openEnded) return true;
	return entry.models.includes(model);
}

/**
 * A flat, surface-ready view of the catalog for a `GET` response or a CLI list — provider
 * id + label + models + whether it is open-ended. Carries NO secrets and NO settings, just
 * the static catalog, so it is safe to return on any surface.
 */
export function catalogView(): readonly ProviderEntry[] {
	return PROVIDER_CATALOG;
}
