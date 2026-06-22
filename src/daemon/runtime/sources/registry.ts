/**
 * Sources registry + provider resolver — PRD-045e (the deferred-assembly seam
 * PRD-013 left). This module is the WIRING the composition root could not build at
 * PRD-022d time: the durable {@link SourceRegistry} the lifecycle engine registers
 * configs through, and the {@link ProviderResolver} that maps a source `kind` to its
 * real provider (Obsidian / Discord / GitHub). With these two deps constructible the
 * assembly can finally pass `sources` into `mountProductDataApi` and fire
 * `mountSourcesApi` (e-AC-1) so `/api/sources` answers real data (e-AC-2).
 *
 * ── Wiring-only (mirrors PRD-021/022) ────────────────────────────────────────
 * NO new schema and NO new provider types. The registry persists source configs as
 * `memory_artifacts` rows of `kind: "source_config"` through the SAME 013a
 * {@link SourceArtifactStore} (append-only, version-bumped, poll-convergent,
 * deterministic-id) the lifecycle engine writes artifacts with — so it inherits the
 * live-correct write path for free and stores config in an EXISTING table (no DDL).
 * The provider resolver instantiates the three already-built providers
 * (`providers/{obsidian,discord,github}.ts`); it does NOT re-port otherhive's ingest.
 *
 * ── The deterministic source id (why register() can be id-stable) ────────────
 * The `/api/sources` POST flow resolves the provider from the parsed config BEFORE
 * `lifecycle.connect()` calls `registry.register()` — so the provider must be built
 * with the SAME `source_id` the registry will assign. We make `source_id`
 * DETERMINISTIC over `(org, workspace, kind, root, settings)` ({@link sourceIdFor}),
 * so the resolver and the registry compute the identical id independently. A re-add
 * of the same config resolves the same id (idempotent) and a purge by `source_id`
 * is a clean scoped sweep — the same property every derived row already relies on.
 *
 * ── Tenancy (e-AC-2) ─────────────────────────────────────────────────────────
 * The registry is bound to ONE resolved `{ org, workspace }` scope at construction;
 * every config row carries explicit `org_id`/`workspace_id` and the store partitions
 * physically, so `list()` only ever sees this tenant's sources. A per-request scope
 * arrives via the API's header resolver; the assembly builds a registry per request
 * scope ({@link createSourcesApiDepsFactory}) so cross-tenant reads never leak.
 */

import crypto from "node:crypto";

import { MEMORY_ARTIFACTS_TABLE } from "../../storage/catalog/sources.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { val } from "../../storage/writes.js";

import type { EmbedClient } from "../services/embed-client.js";
import type { JobQueueService } from "../services/job-queue.js";
import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	type SourceConfig,
	type SourceProvider,
} from "./contracts.js";
import { SourceArtifactStore, type SourceRegistry } from "./lifecycle.js";
import type { ProviderResolver, SourcesApiDeps } from "./api.js";
import { createDocumentWorker } from "./document-worker.js";
import { createObsidianProvider, type ObsidianConfig } from "./providers/obsidian.js";
import { createDiscordProvider } from "./providers/discord.js";
import { createGithubProvider } from "./providers/github.js";

/**
 * The `kind` a registry config row carries on `memory_artifacts` (distinct from the
 * `document`/`note`/… artifact kinds, so a config row never reads as a content
 * artifact). Stored on the existing `kind` column — NO schema change.
 */
export const SOURCE_CONFIG_KIND = "source_config" as const;

/** How many times the registry list scan polls before taking the id union (poll-convergent). */
const REGISTRY_LIST_POLLS = 8;

/**
 * A lowercase-hex sha256 over the material, truncated to 24 chars (mirrors the
 * lifecycle engine's id hashing). Pure.
 */
function hash24(material: string): string {
	return crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
}

/** ISO timestamp for `created_at` / `updated_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Derive the DETERMINISTIC source id for a config (the purge key + the dedup key).
 * Includes the tenancy + kind + root + a stable JSON of `settings` so the resolver
 * and the registry compute the SAME id independently (the property that lets the
 * provider be built before `register()` runs). Prefixed `src_`. Pure.
 */
export function sourceIdFor(config: SourceConfig): string {
	const workspace = config.workspace.length > 0 ? config.workspace : "default";
	const settings = stableStringify(config.settings);
	return `src_${hash24(`${config.org}:${workspace}:${config.kind}:${config.root}:${settings}`)}`;
}

/** Deterministic JSON: object keys sorted, so a re-add with the same settings hashes identically. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * The durable, tenancy-scoped {@link SourceRegistry}. Persists each source config as
 * a version-bumped `memory_artifacts` row (`kind: 'source_config'`) through the 013a
 * {@link SourceArtifactStore}, so the registry survives a daemon restart and a
 * `sources list` reflects what was added. Append-only soft-delete: `remove` advances
 * the config row's `status` to `deleted` (never an in-place UPDATE), so it falls out
 * of `list()` while history is retained — the same mechanism the artifact rows use.
 */
export class DeeplakeSourceRegistry implements SourceRegistry {
	private readonly store: SourceArtifactStore;

	constructor(
		private readonly storage: StorageQuery,
		private readonly scope: QueryScope,
		/** Optional canonical→physical table resolver (identity in prod; a live itest injects a prefix). */
		private readonly resolveTable?: (canonical: string) => string,
		/** Delay (ms) between purge-discovery polls; a unit test passes 0. */
		discoveryPollDelayMs?: number,
	) {
		this.store = new SourceArtifactStore(storage, scope, resolveTable, discoveryPollDelayMs);
	}

	/**
	 * Register a config: APPEND a version-bumped `source_config` row keyed by the
	 * DETERMINISTIC {@link sourceIdFor} id, with the full config serialized into the
	 * `metadata` JSONB column. A re-register of the same config resolves the same id
	 * and appends the next version (idempotent re-add — never a duplicate row id).
	 * Returns the assigned source id.
	 */
	async register(config: SourceConfig): Promise<string> {
		const sourceId = sourceIdFor(config);
		const version = (await this.store.maxVersion(MEMORY_ARTIFACTS_TABLE, sourceId)) + 1;
		const now = nowIso();
		const workspace = config.workspace.length > 0 ? config.workspace : "default";
		await this.store.append(MEMORY_ARTIFACTS_TABLE, sourceId, version, [
			["source_id", val.str(sourceId)],
			["source_kind", val.str(config.kind)],
			["source_path", val.str("")],
			["source_root", val.str(config.root)],
			["org_id", val.str(config.org)],
			["workspace_id", val.str(workspace)],
			["kind", val.str(SOURCE_CONFIG_KIND)],
			["status", val.str(ARTIFACT_ACTIVE)],
			["title", val.str(`${config.kind} source`)],
			["content", val.text("")],
			["summary", val.text("")],
			["content_hash", val.str("")],
			["failure_reason", val.str("")],
			["metadata", val.text(JSON.stringify(config))],
			["superseded_by", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
		return sourceId;
	}

	/** Read a registered config by id (poll-convergent current row), or null when absent/deleted. */
	async get(sourceId: string): Promise<SourceConfig | null> {
		const row = await this.store.resolveCurrent(MEMORY_ARTIFACTS_TABLE, sourceId);
		if (row === null) return null;
		if (row.status === ARTIFACT_DELETED) return null;
		if (row.kind !== SOURCE_CONFIG_KIND) return null;
		return parseConfigFromRow(row);
	}

	/** Soft-delete (status advance) the config row — the config-only half of a disconnect. */
	async remove(sourceId: string): Promise<void> {
		await this.store.softDelete(MEMORY_ARTIFACTS_TABLE, sourceId);
	}

	/**
	 * List the ids of every registered (non-deleted) `source_config` row for this
	 * tenant. Poll-and-union the candidate ids via the store's scan, then keep only
	 * those whose CURRENT row is an active `source_config` — so a soft-deleted source
	 * or an artifact id never surfaces as a source.
	 */
	async list(): Promise<readonly string[]> {
		const ids = await this.scanConfigIds();
		const out: string[] = [];
		for (const id of ids) {
			const row = await this.store.resolveCurrent(MEMORY_ARTIFACTS_TABLE, id);
			if (row === null) continue;
			if (row.status === ARTIFACT_DELETED) continue;
			if (row.kind !== SOURCE_CONFIG_KIND) continue;
			out.push(id);
		}
		out.sort();
		return out;
	}

	/**
	 * Poll-and-union the DISTINCT ids of `source_config` rows for this tenant. A bare
	 * scan can miss an id on a stale segment but never invents one, so the union
	 * across polls converges UP to the true set (the same property the store's
	 * `scanIdsForSource` relies on; here we scan by `kind` since a config row's
	 * `source_id` IS its own id).
	 */
	private async scanConfigIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		const tbl = this.resolveTable ? this.resolveTable(MEMORY_ARTIFACTS_TABLE) : MEMORY_ARTIFACTS_TABLE;
		const sql =
			`SELECT DISTINCT id FROM "${sqlIdent(tbl)}" ` +
			`WHERE kind = ${sLiteral(SOURCE_CONFIG_KIND)}`;
		for (let poll = 0; poll < REGISTRY_LIST_POLLS; poll++) {
			const res = await this.storage.query(sql, this.scope);
			if (isOk(res)) {
				for (const row of res.rows as StorageRow[]) {
					const id = row.id;
					if (typeof id === "string" && id !== "") ids.add(id);
				}
			}
		}
		return ids;
	}
}

/** Parse a stored `source_config` row's `metadata` JSON back into a {@link SourceConfig}, or null. */
function parseConfigFromRow(row: StorageRow): SourceConfig | null {
	const raw = row.metadata;
	let parsed: unknown;
	if (typeof raw === "string" && raw.length > 0) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
	} else if (raw && typeof raw === "object") {
		parsed = raw;
	}
	if (parsed === undefined || parsed === null || typeof parsed !== "object") {
		// Fall back to reconstructing from the explicit columns (a row that predates the
		// metadata write, or a backend that dropped the JSONB blob).
		return reconstructConfig(row);
	}
	const c = parsed as Record<string, unknown>;
	const kind = typeof c.kind === "string" ? c.kind : (typeof row.source_kind === "string" ? row.source_kind : "");
	const org = typeof c.org === "string" ? c.org : (typeof row.org_id === "string" ? row.org_id : "");
	if (kind === "" || org === "") return null;
	return {
		kind: kind as SourceConfig["kind"],
		org,
		workspace: typeof c.workspace === "string" && c.workspace.length > 0 ? c.workspace : "default",
		root: typeof c.root === "string" ? c.root : (typeof row.source_root === "string" ? row.source_root : ""),
		settings: c.settings && typeof c.settings === "object" ? (c.settings as Record<string, unknown>) : {},
	};
}

/** Reconstruct a minimal config from the explicit provenance columns (metadata-absent fallback). */
function reconstructConfig(row: StorageRow): SourceConfig | null {
	const kind = typeof row.source_kind === "string" ? row.source_kind : "";
	const org = typeof row.org_id === "string" ? row.org_id : "";
	if (kind === "" || org === "") return null;
	return {
		kind: kind as SourceConfig["kind"],
		org,
		workspace: typeof row.workspace_id === "string" && row.workspace_id.length > 0 ? row.workspace_id : "default",
		root: typeof row.source_root === "string" ? row.source_root : "",
		settings: {},
	};
}

/**
 * Build the {@link ProviderResolver} that maps a source `kind` to its real provider
 * (e-AC-4). The resolver is the ONLY place the kind→provider mapping lives; the
 * lifecycle is provider-agnostic.
 *
 * - `obsidian` → the REAL vault provider, configured with the DETERMINISTIC source
 *   id (so its derived rows carry the id the registry assigned) and the vault path
 *   from `settings.vaultPath` (or the generic `root`). A config with no vault path
 *   resolves to the honest unconfigured provider (its `index` fails loud inside the
 *   index JOB, never crashing the daemon — the job fails, the daemon serves on).
 * - `discord` / `github` → instantiated FAIL-SOFT without external credentials
 *   (e-AC-5): the credential-free provider forms report `unreachable`/empty rather
 *   than throwing at construction, so adding a Discord/GitHub source registers + lists
 *   cleanly and its index JOB yields nothing until a transport/token is wired. They
 *   are NOT dead code — they are reachable, just disabled-without-creds.
 * - `document` → no `/api/sources` provider (the document path is `/api/documents`);
 *   resolve null so a `document` source add 400s with a clear message.
 */
export function createSourceProviderResolver(): ProviderResolver {
	return {
		resolve(config: SourceConfig): SourceProvider | null {
			switch (config.kind) {
				case "obsidian": {
					const obsidian = toObsidianConfig(config);
					return obsidian !== null ? createObsidianProvider(obsidian) : createObsidianProvider();
				}
				case "discord":
					// Fail-soft, credential-free: the stub form reports `unreachable` and
					// yields nothing until a DiscordTransport is wired (no creds in this env).
					return createDiscordProvider();
				case "github":
					// Fail-soft, credential-free: with no `GithubProviderDeps` the provider
					// connects (reporting the not-wired reason) and index yields nothing.
					return createGithubProvider();
				case "document":
					// Documents flow through `/api/documents`, not `/api/sources`.
					return null;
				default:
					return null;
			}
		},
	};
}

/**
 * Lift a generic {@link SourceConfig} into the typed {@link ObsidianConfig} the
 * Obsidian provider needs, stamping the DETERMINISTIC source id so the provider's
 * derived rows carry the same id the registry assigns. Reads the vault path from
 * `settings.vaultPath` first, falling back to the generic `root`. Returns null when
 * no vault path is present (→ the honest unconfigured provider).
 */
function toObsidianConfig(config: SourceConfig): ObsidianConfig | null {
	const settings = config.settings ?? {};
	const fromSettings = typeof settings.vaultPath === "string" ? settings.vaultPath : "";
	const vaultPath = fromSettings.length > 0 ? fromSettings : config.root;
	if (vaultPath.length === 0) return null;
	return {
		vaultPath,
		sourceId: sourceIdFor(config),
		org: config.org,
		workspace: config.workspace.length > 0 ? config.workspace : "default",
	};
}

/** Construction deps for {@link buildSourcesApiDeps} — the seams the assembly threads in. */
export interface SourcesApiDepsOptions {
	/** The live storage client every lifecycle/registry/document statement runs through. */
	readonly storage: StorageQuery;
	/** The daemon's default tenancy scope the registry + document worker are bound to (local-mode loopback). */
	readonly scope: QueryScope;
	/** The daemon's OWN durable `memory_jobs` queue — reused (NOT a second queue) for index + ingest jobs. */
	readonly queue: JobQueueService;
	/** The daemon's embed client (real or no-op) the document worker attaches chunk vectors with (fail-soft). */
	readonly embed: EmbedClient;
	/** Optional canonical→physical table resolver (identity in prod; a live itest injects a per-run prefix). */
	readonly resolveTable?: (canonical: string) => string;
}

/**
 * Build the full {@link SourcesApiDeps} the composition root threads into
 * `mountProductDataApi` so `/api/sources` AND `/api/documents` go live (e-AC-1).
 * This is the assembly helper PRD-013 said was "not yet constructible there": it
 * constructs the durable {@link DeeplakeSourceRegistry}, the
 * {@link createSourceProviderResolver} (e-AC-4), and the REAL 013b document worker
 * ({@link createDocumentWorker}, e-AC-3) — all over the daemon's OWN storage client,
 * tenancy scope, and durable queue (reusing `daemon.services.queue`, NOT a second
 * queue, per the PRD's preferred wiring). The document worker runs its
 * chunk/embed/index lifecycle synchronously on submit (the worker exposes the steps),
 * so it ingests without standing up a separate runner.
 *
 * Tenancy: the registry + worker are bound to the daemon's `scope` (the single
 * local-mode tenant). The API's per-request header resolver still 400s fail-closed on
 * a missing org; in local mode the loopback request resolves to this tenant.
 */
export function buildSourcesApiDeps(options: SourcesApiDepsOptions): SourcesApiDeps {
	const { storage, scope, queue, embed, resolveTable } = options;
	const registry = new DeeplakeSourceRegistry(storage, scope, resolveTable);
	const documentWorker = createDocumentWorker({
		storage,
		scope,
		queue,
		embed,
		...(resolveTable !== undefined ? { resolveTable } : {}),
	});
	return {
		storage,
		queue,
		registry,
		providers: createSourceProviderResolver(),
		documentWorker,
	};
}
