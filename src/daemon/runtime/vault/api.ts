/**
 * The daemon `/api/settings` API — PRD-032a (AC-8, settings-class only).
 *
 * ── The surface (settings are daemon-readable; secrets stay names-only) ──────
 * This module mounts the `setting`-class surface. Unlike `/api/secrets` (names-only, NO
 * value-returning route — the PRD-012 security property, left intact), a `setting` IS
 * daemon-readable, so this surface DOES return setting values:
 *
 *   - `GET  /api/settings`        → list the current settings (key → value) + the catalog;
 *   - `GET  /api/settings/:key`   → read one setting's typed value;
 *   - `POST /api/settings/:key`   → write a `setting`-class record (zod + catalog-validated).
 *
 * CRITICAL — no secret crosses this surface (D-4 / AC-8). The handlers read/write ONLY the
 * `setting` class through {@link VaultStore.getSetting} / {@link VaultStore.setSetting},
 * whose posture gate REJECTS any `internal-only` class. The `GET` list returns setting
 * values + a catalog; it NEVER reads the `secret` class, so no key/token can appear. A
 * setting that REFERENCES a secret (a future `apiKeyRef`) would show the ref NAME / a
 * "set ✓" marker, never the value — but this surface stores no such thing today.
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/settings` is a PROTECTED group (server.ts ROUTE_GROUPS: `protect: true`). Attaching
 * via `daemon.group("/api/settings")` inherits the PRD-011 auth/RBAC middleware with ZERO
 * re-wiring — mirrors the `/api/secrets` + `/api/goals` mount pattern. The route group MUST
 * be declared in `server.ts` (this PRD adds it); if the group is not mounted the mount is a
 * no-op (mirrors `mountGoalsApi`).
 *
 * Scope is resolved per-request via the SAME header-based {@link ScopeResolver} the secrets
 * API uses (reused, not re-invented), so tenancy handling is identical across the vault.
 */

import type { Context, Hono } from "hono";

import { headerScopeResolver, type ScopeResolver } from "../secrets/api.js";
import type { Daemon } from "../server.js";
import { catalogView, isValidProviderModel, providerEntry } from "./catalog.js";
import type { SecretScope } from "./contracts.js";
import { type SettingValue, SettingValueSchema } from "./registry.js";
import type { VaultStore } from "./store.js";

/** The route group the settings API attaches to (declared + protected in `server.ts`). */
export const SETTINGS_GROUP = "/api/settings" as const;

/**
 * The KNOWN setting keys this surface curates (AC-8). A write is fail-closed against this
 * allow-list: only these keys are accepted, so a caller cannot stuff arbitrary records into
 * the `setting` class through the API. Each maps to a small typed value:
 *   - `activeProvider` — a catalog provider id;
 *   - `activeModel`    — a model id, validated against the chosen `activeProvider`;
 *   - `pollinating.enabled` — the pollinating toggle (boolean);
 *   - `recallMode`     — the recall-mode selector (PRD-044c): the CLOSED enum
 *     `keyword | semantic | hybrid` (validated below, fail-closed). UNSET preserves the
 *     PRD-025 runtime default (behavior-neutral), so the key exists to OPT IN to an explicit mode.
 *   - `portkey.enabled` — the Portkey gateway toggle (boolean, PRD-063a). Persisted intent only;
 *     063b makes it take effect on the inference path.
 *   - `portkey.config`  — the free-form Portkey config / virtual-key id (string). Validated as a
 *     NON-EMPTY string only WHEN `portkey.enabled === true`; when disabled any/empty string passes.
 *   - `portkey.fallbackToProvider` — the opt-in "fall back to the provider key if Portkey is
 *     unreachable" toggle (boolean, PRD-063a D-3, default false).
 *   - `dashboard.*`    — free-form scalar dashboard prefs (validated only by the class schema).
 */
/**
 * The `setting`-class key the embeddings on/off preference persists under (dashboard actions). The
 * single source of truth shared by the `/api/settings` allow-list (below), the boot read that seeds
 * the embed supervisor (`assemble.ts`), and the `POST /api/actions/embeddings` toggle that writes it.
 */
export const EMBEDDINGS_ENABLED_KEY = "embeddings.enabled" as const;

export const KNOWN_SETTING_KEYS = [
	"activeProvider",
	"activeModel",
	"pollinating.enabled",
	EMBEDDINGS_ENABLED_KEY,
	"recallMode",
	"portkey.enabled",
	"portkey.config",
	"portkey.fallbackToProvider",
] as const;

/**
 * The closed `recallMode` enum (PRD-044c). The recall pipeline reads this `setting` at recall
 * time and gates the channels: `keyword` → lexical FTS only (NOT degraded — an intentional
 * lexical run), `semantic` → the vector arm (with the PRD-025 embeddings-off degraded fallback),
 * `hybrid` → both arms. An UNSET key preserves today's PRD-025 runtime decision exactly.
 */
export const RECALL_MODES = ["keyword", "semantic", "hybrid"] as const;
/** One recall mode drawn from the closed {@link RECALL_MODES} vocabulary. */
export type RecallMode = (typeof RECALL_MODES)[number];

/** Whether `value` is a valid {@link RecallMode} (fail-closed: anything else is rejected). */
export function isValidRecallMode(value: string): value is RecallMode {
	return (RECALL_MODES as readonly string[]).includes(value);
}

/** A dashboard-pref key prefix accepted as a free-form scalar setting. */
export const DASHBOARD_PREF_PREFIX = "dashboard." as const;

/** Whether `key` is an accepted setting key (a known key OR a `dashboard.*` pref). */
export function isKnownSettingKey(key: string): boolean {
	if ((KNOWN_SETTING_KEYS as readonly string[]).includes(key)) return true;
	return key.startsWith(DASHBOARD_PREF_PREFIX) && key.length > DASHBOARD_PREF_PREFIX.length;
}

/** Construction deps for the settings API. Everything injected for testability. */
export interface SettingsApiDeps {
	/** The multi-class vault store the handlers read/write the `setting` class through. */
	readonly store: VaultStore;
	/** The per-request scope resolver (default: the shared header-based resolver). */
	readonly scope?: ScopeResolver;
}

/**
 * Mount the `/api/settings` handlers onto a route group (AC-8). Call AFTER `createDaemon`
 * with `daemon.group("/api/settings")` so the handlers inherit the already-mounted auth/RBAC
 * middleware. The three routes are registered relative to the group base.
 */
export function mountSettingsGroup(group: Hono, deps: SettingsApiDeps): void {
	const scope = deps.scope ?? headerScopeResolver;
	const store = deps.store;

	// GET /api/settings — list the current settings (key → value) + the catalog. NO secret.
	group.get("/", async (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const keys = store.listSettingKeys(sc);
		const settings: Record<string, SettingValue> = {};
		for (const key of keys) {
			// Each value is read through the daemon-readable `getSetting` accessor; a malformed
			// or undecryptable record is simply omitted (never surfaced as an error/leak).
			const res = await store.getSetting(key, sc);
			if (res.ok) settings[key] = res.value;
		}
		// The catalog is static + secret-free, so returning it here lets a surface render the
		// provider→model selector without a second round-trip.
		return c.json({ settings, catalog: catalogView() });
	});

	// GET /api/settings/:key — read one setting's typed value.
	group.get("/:key", async (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const key = c.req.param("key");
		if (!isKnownSettingKey(key)) {
			return c.json({ error: "not_found", reason: "no such setting" }, 404);
		}
		const res = await store.getSetting(key, sc);
		if (!res.ok) {
			if (res.reason === "not_found") return c.json({ error: "not_found", reason: "no such setting" }, 404);
			// `not_readable` (a secret probed through this surface) → 404, not a 200 leak.
			if (res.reason === "not_readable") return c.json({ error: "not_found", reason: "no such setting" }, 404);
			return c.json({ error: "read_failed", reason: "could not read the setting" }, 502);
		}
		return c.json({ key, value: res.value });
	});

	// POST /api/settings/:key — write a `setting`-class record (zod + catalog validated).
	group.post("/:key", async (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const key = c.req.param("key");
		if (!isKnownSettingKey(key)) {
			return c.json({ error: "bad_request", reason: "unknown setting key" }, 400);
		}
		const value = await readSettingValue(c);
		if (value === null) {
			return c.json({ error: "bad_request", reason: "request body must carry a scalar value" }, 400);
		}
		// Catalog validation for the model key: the model must be valid for the CURRENT
		// (or just-written) provider. We read the active provider from the vault; a body that
		// also sets the provider is honored by the caller writing `activeProvider` first.
		const semanticError = await validateSettingSemantics(store, sc, key, value);
		if (semanticError !== null) {
			return c.json({ error: "bad_request", reason: semanticError }, 400);
		}
		const res = await store.setSetting(key, value, sc);
		if (!res.ok) {
			if (res.reason === "invalid_value") {
				return c.json({ error: "bad_request", reason: "invalid setting value" }, 400);
			}
			if (res.reason === "not_readable" || res.reason === "unknown_class") {
				// A defensive guard — `setSetting` always targets the `setting` class, so this
				// should not occur, but never let a posture/registry failure 200.
				return c.json({ error: "bad_request", reason: "setting class is not writable" }, 400);
			}
			return c.json({ error: "store_failed", reason: "could not store the setting" }, 502);
		}
		// The response echoes the key + value (a setting is daemon-readable) — never a secret.
		return c.json({ ok: true, key, value }, 201);
	});
}

/**
 * Resolve `/api/settings` and mount the handlers (the assembly seam). Mirrors
 * `mountGoalsApi(daemon, options)`: resolves the protected group and delegates. A no-op when
 * the group is not mounted (unknown daemon shape).
 */
export function mountSettingsApi(daemon: Daemon, deps: SettingsApiDeps): void {
	const group = daemon.group(SETTINGS_GROUP);
	if (group === undefined) return;
	mountSettingsGroup(group, deps);
}

/** The 400 for a request with no resolvable tenancy (fail-closed — never a broad scope). */
function badTenancy(c: Context): Response {
	return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
}

/**
 * Read a scalar setting value from the POST body. Accepts a JSON `{ value: <scalar> }` or a
 * raw text body (coerced to a string). Returns `null` for a missing value or a non-scalar
 * (object/array) value — those are rejected at the boundary by the class schema anyway, but
 * we fail fast here. The value is then re-validated by `setSetting`'s zod schema.
 */
async function readSettingValue(c: Context): Promise<SettingValue | null> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("application/json")) {
		try {
			const body: unknown = await c.req.json();
			if (typeof body === "object" && body !== null) {
				const v = (body as Record<string, unknown>).value;
				const parsed = SettingValueSchema.safeParse(v);
				return parsed.success ? parsed.data : null;
			}
			return null;
		} catch {
			return null;
		}
	}
	const text = await c.req.text();
	return text.length > 0 ? text : null;
}

/**
 * Apply the CATALOG semantics on top of the class schema (D-6). The class schema already
 * validated the value is a scalar; this layer enforces provider/model coherence:
 *   - `activeProvider` must be a catalog provider;
 *   - `activeModel` must be valid for the active provider (the one being written alongside,
 *     or already stored). Returns an error STRING (the 400 reason) or `null` when valid.
 */
async function validateSettingSemantics(
	store: VaultStore,
	scope: SecretScope,
	key: string,
	value: SettingValue,
): Promise<string | null> {
	if (key === "activeProvider") {
		if (providerEntry(String(value)) === undefined) return "unknown provider";
		return null;
	}
	if (key === "activeModel") {
		// The active provider is whatever is currently stored; a caller sets provider first.
		const provRes = await store.getSetting("activeProvider", scope);
		const provider = provRes.ok ? String(provRes.value) : "";
		if (provider.length === 0) return "set activeProvider before activeModel";
		if (!isValidProviderModel(provider, String(value))) return "model not in provider catalog";
		return null;
	}
	if (key === "recallMode") {
		// PRD-044c: fail-closed against the CLOSED enum, the same way `activeModel` is
		// catalog-validated. Anything outside `keyword | semantic | hybrid` is rejected with a
		// 400 — a caller cannot persist a garbage recall mode the pipeline would not understand.
		if (!isValidRecallMode(String(value))) return "recallMode must be keyword, semantic, or hybrid";
		return null;
	}
	if (key === "portkey.enabled" || key === "portkey.fallbackToProvider") {
		// PRD-063a (D-3): both toggles MUST be a true boolean — a non-boolean (string/number) is
		// rejected 400, the same fail-closed shape the other keys use. The class schema accepts
		// any scalar, so this layer is what enforces the boolean type for the toggles.
		if (typeof value !== "boolean") return `${key} must be a boolean`;
		return null;
	}
	if (key === "portkey.config") {
		// PRD-063a: a free-form id (config or virtual key). It must be a NON-EMPTY string only
		// WHEN Portkey is enabled — an enabled gateway with an empty config is incoherent. The
		// enabled flag is whatever is currently stored; a caller writes `portkey.enabled` first
		// (mirrors the `activeProvider` → `activeModel` ordering above). When disabled, any/empty
		// string passes (the user may clear or pre-fill the field with the gateway off).
		if (typeof value !== "string") return "portkey.config must be a string";
		// SECURITY (header-injection defense-in-depth): `portkey.config` is sent VERBATIM as the
		// `x-portkey-config` HTTP header value by the inference transport. Reject any control
		// character (CR/LF/NUL/etc.) at this validated boundary so a header-injection attempt is a
		// clean 400 here rather than a confusing silent "unreachable" later (the undici fetch layer
		// already rejects CR/LF in header values, so this is belt-and-suspenders, not the only guard).
		if (/[\u0000-\u001F\u007F]/.test(value)) return "portkey.config must not contain control characters";
		const enabledRes = await store.getSetting("portkey.enabled", scope);
		const enabled = enabledRes.ok && enabledRes.value === true;
		if (enabled && value.length === 0) return "portkey.config must be non-empty when portkey.enabled is true";
		return null;
	}
	return null;
}
