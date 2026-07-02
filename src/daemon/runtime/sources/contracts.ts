/**
 * Source contracts — PRD-013a Wave 1 (the typed shapes every provider + the
 * lifecycle engine + the 4 Wave-2 Bees all code against).
 *
 * These are THE most load-bearing Wave-1 artifact: 013b (document worker), 013c
 * (Obsidian), 013d (Discord), and 013e (GitHub) each emit into the SAME
 * {@link SourceArtifact} shape behind the SAME {@link SourceProvider} seam, with
 * ZERO shared-file contention — so the contract must be right and stable. A new
 * provider only adds ingest code (a `SourceProvider`); purge, health, soft-delete,
 * and provenance behave identically across every source because they operate on
 * the artifact, never on provider-specific data.
 *
 * ── The thesis these contracts encode ───────────────────────────────────────
 *   1. A source is READ-ONLY evidence. A provider READS an external knowledge
 *      base; it NEVER writes back. The source files are NEVER modified.
 *   2. Every derived row carries PROVENANCE (the quartet + scope) so a hit traces
 *      back to the original vault / channel / repo and a purge is a clean scoped
 *      sweep by `source_id` (D-1 / a-AC-3).
 *   3. A partial failure is a DATA POINT, not a deletion: a provider emits a
 *      {@link SourceArtifact} with a `failure` marker (D-4 / a-AC-7), and the
 *      lifecycle writes it as a FAILURE ARTIFACT alongside the existing rows —
 *      never deleting one.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * zod validates at the UNTRUSTED boundary — a {@link SourceConfig} arriving from
 * the CLI / API, where a malformed field must be rejected. The interior shapes a
 * provider BUILDS ({@link SourceArtifact}, {@link Provenance}) are plain TS
 * interfaces: the provider constructs them from already-read source data, so a
 * runtime re-validation would be ceremony. The rule mirrors
 * `ontology/contracts.ts` + `pipeline/contracts.ts`.
 *
 * Every value these contracts carry is eventually interpolated into SQL by the
 * lifecycle engine through the `sqlStr`/`sLiteral`/`val.*` helpers — the contracts
 * hold the data, the engine escapes it.
 */

import { z } from "zod";

import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
	ARTIFACT_SUPERSEDED,
} from "../../storage/catalog/sources.js";

// ────────────────────────────────────────────────────────────────────────────
// SourceKind — the provider taxonomy (D-7). The fixed set a source's `kind` is
// drawn from. `document` is the lighter ad-hoc single-document path (013b);
// obsidian/discord/github are the Wave-2 providers (013c/d/e).
// ────────────────────────────────────────────────────────────────────────────

/** The fixed source-kind set (D-7). Frozen so the zod enum + guard read one source. */
export const SOURCE_KINDS = Object.freeze([
	"obsidian",
	"discord",
	"github",
	"document",
] as const);

/** A source kind drawn from the fixed set. */
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** zod enum over the fixed source-kind set (boundary validation for configs). */
export const SourceKindSchema = z.enum(SOURCE_KINDS);

/** True when `value` is one of the fixed source kinds. Narrows to {@link SourceKind}. */
export function isSourceKind(value: string): value is SourceKind {
	return (SOURCE_KINDS as readonly string[]).includes(value);
}

// ────────────────────────────────────────────────────────────────────────────
// Provenance — the quartet + scope every derived row carries (D-1 / FR-1 / a-AC-3).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The provenance every source-derived row carries (D-1 / FR-1 / a-AC-3). The
 * quartet (`sourceId`/`sourceKind`/`sourcePath`/`sourceRoot`) maps 1:1 onto the
 * catalog's `source_id`/`source_kind`/`source_path`/`source_root` columns; the
 * scope (`org`/`workspace`) maps onto `org_id`/`workspace_id`.
 *
 * - `sourceId`   the source instance id — the purge key. A deterministic row id
 *                INCLUDES it so a purge is a clean scoped sweep (D-1 / a-AC-2).
 * - `sourceKind` the provider kind ({@link SourceKind}).
 * - `sourcePath` the unit's path WITHIN the source (a vault-relative .md path, a
 *                channel/message ref, a repo item path). A source hit opens this.
 * - `sourceRoot` the source's root (the vault dir, the guild, the repo) — the
 *                anchor `sourcePath` is relative to.
 * - `org` /
 *   `workspace`  the tenancy the source is mounted into (FR-1).
 */
export interface Provenance {
	/** The source instance id — the purge key (deterministic ids include it). */
	readonly sourceId: string;
	/** The provider kind. */
	readonly sourceKind: SourceKind;
	/** The unit's path within the source (vault-relative, channel ref, repo path). */
	readonly sourcePath: string;
	/** The source's root (vault dir / guild / repo) `sourcePath` is relative to. */
	readonly sourceRoot: string;
	/** The org the source is mounted into. */
	readonly org: string;
	/** The workspace the source is mounted into. */
	readonly workspace: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SourceArtifact — the ONE shape every provider emits (FR-3 / a-AC-1).
// ────────────────────────────────────────────────────────────────────────────

/** Artifact kinds an ingest produces. Free-form per provider, but these are common. */
export const ARTIFACT_KINDS = Object.freeze([
	"note", // an Obsidian .md
	"message", // a Discord message
	"issue", // a GitHub issue / PR / discussion
	"document", // a submitted ad-hoc document (013b)
	"artifact", // a generic source unit
] as const);
/** An artifact kind. */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * A failure marker on an artifact (D-4 / a-AC-7). When PRESENT, the lifecycle
 * writes the artifact as a FAILURE ARTIFACT (`status: 'failure'`) + reports it,
 * and NEVER deletes an existing row. A provider sets this when a single unit fails
 * to fetch/parse while the rest of the scan succeeds — the failure is isolated to
 * its own row, the indexed corpus is untouched.
 */
export interface FailureArtifact {
	/** Human-readable reason the unit failed (logged + stored on the row). */
	readonly reason: string;
	/** Optional structured detail (status code, parse position, …). */
	readonly detail?: Record<string, unknown>;
}

/**
 * The shared artifact shape EVERY provider emits (FR-3 / a-AC-1 / D-7). A provider
 * reads its external source and yields a stream of these; the lifecycle engine
 * turns each into a `memory_artifacts` row (+ native graph rows + provenanced
 * chunks) — provider-agnostically. This is the seam's payload.
 *
 * - `provenance`   the quartet + scope (D-1 / a-AC-3). MANDATORY — an artifact
 *                  with no provenance is not a valid derived row.
 * - `kind`         the artifact kind.
 * - `title`        a short human label (the note title, the issue title, …).
 * - `content`      the raw evidence text (the keyword-searchable body).
 * - `summary`      an optional distilled summary (else "").
 * - `chunks`       the provenanced chunks this unit splits into (013b/013c). May be
 *                  empty (the lifecycle can chunk later); each carries its own
 *                  path/heading detail in `metadata`.
 * - `graphTriples` native graph rows mounted from the source topology into the
 *                  ontology (e.g. Obsidian wiki-links → dependency edges, 013c).
 *                  Optional; carried through to the graph layer with provenance.
 * - `metadata`     a genuinely-schemaless per-provider blob (→ JSONB column).
 * - `failure`      a {@link FailureArtifact} marker → written as a failure artifact,
 *                  no existing row deleted (D-4 / a-AC-7). Absent on a normal unit.
 */
export interface SourceArtifact {
	/** Provenance quartet + scope (MANDATORY — a-AC-3). */
	readonly provenance: Provenance;
	/** The artifact kind. */
	readonly kind: ArtifactKind;
	/** A short human label. */
	readonly title: string;
	/** The raw evidence text (keyword-searchable). */
	readonly content: string;
	/** An optional distilled summary. */
	readonly summary?: string;
	/** The provenanced chunks this unit splits into (may be empty). */
	readonly chunks?: readonly SourceChunk[];
	/** Native graph rows mounted from source topology (optional, 013c). */
	readonly graphTriples?: readonly HiveGraphTriple[];
	/** Genuinely-schemaless per-provider detail (→ JSONB). */
	readonly metadata?: Record<string, unknown>;
	/** A partial-failure marker → FAILURE ARTIFACT, no row deleted (D-4 / a-AC-7). */
	readonly failure?: FailureArtifact;
}

/**
 * One provenanced chunk of an artifact (FR-3 / 013b / 013c-AC-3). Carries the
 * chunk text + its own provenance (the parent artifact's, with `sourcePath`
 * possibly narrowed to a heading anchor) + schemaless `metadata` (heading, line
 * range). The lifecycle writes each as a `document_chunk` row; the document worker
 * (013b) computes the `content_hash` for shared-embedding dedup (b-AC-4) and the
 * embed seam attaches the 768-dim vector (fail-soft, b-AC-2).
 */
export interface SourceChunk {
	/** The chunk's provenance (parent's, `sourcePath` may carry a heading anchor). */
	readonly provenance: Provenance;
	/** The chunk text (the keyword-searchable body). */
	readonly content: string;
	/** The chunk's position within its artifact (for ordering). */
	readonly ordinal: number;
	/** Schemaless per-chunk detail (heading, line range, …) → JSONB. */
	readonly metadata?: Record<string, unknown>;
}

/**
 * A native graph triple mounted from source topology into the ontology (013c). The
 * source's structure (a vault's wiki-links, a repo's references) becomes graph
 * rows; the lifecycle carries the provenance through so the graph row is purgeable
 * by `source_id` (a-AC-2 — the additive provenance quartet on the graph tables).
 */
export interface HiveGraphTriple {
	/** The subject entity (canonical name). */
	readonly subject: string;
	/** The relationship/edge type. */
	readonly predicate: string;
	/** The object entity (canonical name). */
	readonly object: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SourceConfig — the boundary shape connect() validates (FR-2). Boundary: zod.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The source configuration a connect request carries (FR-2). A BOUNDARY type:
 * it arrives from the CLI / `POST /api/sources`, so it is validated via
 * {@link SourceConfigSchema} before a source is registered. The provider-specific
 * settings live in the schemaless `settings` blob (a vault path, a guild id, a
 * repo + token-ref) — the contract stays provider-agnostic; the provider reads its
 * own keys out of `settings`.
 *
 * - `kind`      the provider kind ({@link SourceKind}).
 * - `org` /
 *   `workspace` the tenancy to mount the source into (FR-1).
 * - `root`      the source root (vault dir, guild, `owner/repo`) — becomes
 *               `sourceRoot` on every derived row.
 * - `settings`  schemaless provider-specific config (path, token-ref, globs, …).
 */
export const SourceConfigSchema = z.object({
	kind: SourceKindSchema,
	org: z.string().min(1),
	workspace: z.string().default("default"),
	root: z.string().default(""),
	settings: z.record(z.string(), z.unknown()).default({}),
});

/** A validated source configuration (013a boundary). */
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

/**
 * Validate a candidate source config at the boundary, returning the typed
 * {@link SourceConfig} or `null` on an invalid body. Drop-invalid (never throw) so
 * a malformed CLI / API config is rejected without crashing the lifecycle — the
 * handler routes the null to a 400.
 */
export function parseSourceConfig(candidate: unknown): SourceConfig | null {
	const parsed = SourceConfigSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

// ────────────────────────────────────────────────────────────────────────────
// SourceProvider — the SEAM (D-7). Provider-specific code lives ONLY behind this.
// ────────────────────────────────────────────────────────────────────────────

/** The health a provider reports (FR-9). `connected` is the happy path. */
export const PROVIDER_HEALTH_STATES = Object.freeze(["connected", "degraded", "unreachable"] as const);
/** A provider health state. */
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

/** A provider's health snapshot (FR-9). */
export interface ProviderHealth {
	/** The coarse state. */
	readonly state: ProviderHealthState;
	/** Optional human detail (last error, checkpoint lag, …). */
	readonly detail?: string;
}

/**
 * A scope to index over (FR-6). For a full re-index `since` is unset; for an
 * incremental re-scan a provider uses `since` (a checkpoint) to fetch only what
 * changed. `paths` optionally narrows to specific units (a single edited file).
 */
export interface IndexScope {
	/** Index only units changed since this checkpoint (unset = full index). */
	readonly since?: string;
	/** Narrow to specific unit paths (unset = the whole source). */
	readonly paths?: readonly string[];
}

/**
 * THE provider seam (D-7). Provider-specific code (Obsidian vault reads, Discord
 * REST/gateway, GitHub GraphQL/REST) lives ONLY behind this interface; the
 * lifecycle engine calls it provider-agnostically and the tests fake it via
 * {@link createFakeSourceProvider}. A Wave-2 provider Bee implements EXACTLY this
 * and conforms its emitted artifacts to {@link SourceArtifact}.
 *
 * - `connect()`  establish whatever the provider needs (open a vault, auth a
 *                token) and report initial health. Idempotent.
 * - `index()`    READ the source and YIELD a stream of {@link SourceArtifact}s
 *                (an async iterable so a large source streams rather than buffering
 *                — the lifecycle consumes lazily). NEVER writes to the source.
 * - `health()`   report the current {@link ProviderHealth} (FR-9).
 * - `close()`    release resources (close a gateway connection on purge — d-AC-4).
 */
export interface SourceProvider {
	/** The kind this provider serves (matches the config's `kind`). */
	readonly kind: SourceKind;
	/** Establish the connection; report initial health. Idempotent. */
	connect(config: SourceConfig): Promise<ProviderHealth>;
	/** READ the source and yield artifacts (read-only; never writes the source). */
	index(scope: IndexScope): AsyncIterable<SourceArtifact>;
	/** Report current provider health (FR-9). */
	health(): Promise<ProviderHealth>;
	/** Release resources (close a gateway on purge — d-AC-4). Idempotent. */
	close(): Promise<void>;
}

/**
 * Build a deterministic FAKE provider that yields the supplied artifacts on
 * `index()` (the test double every lifecycle + Wave-2 test drives — there are NO
 * real vault/Discord/GitHub creds in this env). `connect`/`health` report
 * `connected`; `close` records that it was called (so a purge test asserts the
 * gateway was closed — d-AC-4). The `index` ignores the scope and yields the full
 * canned list, which is exactly what a deterministic test wants.
 *
 * Pass `health` to override the reported state (a degraded/unreachable provider
 * test), and `onClose` to observe close.
 */
export function createFakeSourceProvider(
	artifacts: readonly SourceArtifact[],
	options: {
		readonly kind?: SourceKind;
		readonly health?: ProviderHealth;
		readonly onClose?: () => void;
	} = {},
): SourceProvider & { readonly closed: () => boolean } {
	const kind = options.kind ?? "document";
	const health = options.health ?? { state: "connected" };
	let isClosed = false;
	return {
		kind,
		async connect(): Promise<ProviderHealth> {
			return health;
		},
		async *index(): AsyncIterable<SourceArtifact> {
			for (const a of artifacts) {
				yield a;
			}
		},
		async health(): Promise<ProviderHealth> {
			return health;
		},
		async close(): Promise<void> {
			isClosed = true;
			options.onClose?.();
		},
		closed: (): boolean => isClosed,
	};
}

/**
 * Re-export the catalog status literals so a caller (the lifecycle, a test) reads
 * the SAME values the rows are written with — never a hand-typed string. The
 * status advance (active → deleted / superseded / failure) is the catalog's
 * append-only soft-delete mechanism (D-2 / D-3).
 */
export { ARTIFACT_ACTIVE, ARTIFACT_DELETED, ARTIFACT_FAILURE, ARTIFACT_SUPERSEDED };
