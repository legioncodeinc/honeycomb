/**
 * GitHub source provider — PRD-013e (Wave 2 fill).
 *
 * The GitHub provider READS a repo's issues, pull requests, and discussions over
 * GraphQL and its selected Markdown docs over REST, yielding each as a
 * {@link SourceArtifact} behind the shared {@link SourceProvider} seam. It NEVER
 * writes back to GitHub (read-only evidence) and it does NOT touch the lifecycle
 * engine, the catalog, or the contracts — the lifecycle turns each emitted artifact
 * into durable, provenanced, purgeable rows (every SQL value escaped THERE, never
 * here — this module builds no SQL). Provider-specific GraphQL/REST code lives ONLY
 * in this file (CONVENTIONS §7).
 *
 * ── The e-AC contract this file owns ────────────────────────────────────────
 *   - e-AC-1: `sources add github --repo Org/Repo --token-ref GITHUB_TOKEN
 *             --resource-type issues --resource-type docs` → issues/PRs/discussions
 *             over GRAPHQL + selected Markdown docs over REST. The token resolves
 *             from the secret REF via the {@link SecretResolver} seam — NEVER a raw
 *             token in config or a log.
 *   - e-AC-2: a NON-Markdown file is SKIPPED; only Markdown is ingested, bounded by
 *             `maxItemsPerRepo` + path globs.
 *   - e-AC-3: a `maxItemsPerRepo` bound → no more than that many items per repo.
 *   - e-AC-4: (SECURITY) the resolved token only ever reaches the configured GitHub
 *             API host. It is NEVER injected into a non-GitHub remote — the
 *             {@link githubTokenForRemote} guard returns the token ONLY for a
 *             github.com (or the configured GitHub host) remote, and `undefined`
 *             for anything else, so a token cannot be exfiltrated to an arbitrary
 *             remote (the token-exfiltration guard).
 *   - e-AC-5: a partial GraphQL failure → a `failure` {@link SourceArtifact}; the
 *             lifecycle writes it alongside the indexed corpus and NEVER deletes an
 *             existing row (D-4 / a-AC-7).
 *   - e-AC-6: every indexed item carries the provenance quartet (`source_kind`
 *             'github', `source_path` = `issues/#42`, `docs/README.md`, …) + scope
 *             (org / workspace) — a-AC-3 / D-1.
 *
 * ── Token-exfiltration guard (e-AC-4), in one place ─────────────────────────
 * The token is resolved once, in {@link createGithubProvider}'s `connect`, through
 * the SecretResolver seam. Every API call routes through the {@link GitHubApi} seam,
 * whose host is pinned to the configured GitHub host. The ONLY function that pairs a
 * token with a host is {@link githubTokenForRemote}: it hands back the token for a
 * GitHub host and `undefined` otherwise. A caller that wants to talk to a non-GitHub
 * remote (a git sync of a mirror, a webhook, …) therefore gets NO Authorization — the
 * token never leaves github.com. The token is NEVER placed on an emitted artifact,
 * its metadata, its provenance, or any log field.
 */

import type {
	IndexScope,
	Provenance,
	ProviderHealth,
	SourceArtifact,
	SourceConfig,
	SourceProvider,
} from "../contracts.js";
import type { SecretResolver } from "../../inference/contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// GitHub host pinning + the token-exfiltration guard (e-AC-4)
// ────────────────────────────────────────────────────────────────────────────

/** The default GitHub API host. A GitHub Enterprise install overrides via config. */
export const DEFAULT_GITHUB_HOST = "github.com" as const;

/**
 * True when `host` is the configured GitHub host (case-insensitive, port-stripped).
 * The bare host, an `api.<host>` API subdomain, and any `*.<host>` subdomain all
 * pass so the GraphQL (`api.github.com/graphql`) + REST endpoints resolve as the
 * GitHub host. Anything else — an arbitrary git remote, an attacker-controlled
 * mirror — is NOT a GitHub host and gets no token (e-AC-4).
 */
export function isGithubHost(host: string, configuredHost: string = DEFAULT_GITHUB_HOST): boolean {
	const normalize = (h: string): string => h.trim().toLowerCase().replace(/:\d+$/, "");
	const target = normalize(configuredHost);
	const candidate = normalize(host);
	if (candidate === "" || target === "") return false;
	return candidate === target || candidate === `api.${target}` || candidate.endsWith(`.${target}`);
}

/**
 * THE token-exfiltration guard (e-AC-4). Returns the resolved token ONLY when
 * `remote`'s host is the configured GitHub host, and `undefined` for ANY other
 * remote. This is the single chokepoint that pairs a token with a destination: a
 * non-GitHub remote (a mirror push, a webhook, an arbitrary URL pasted into config)
 * receives `undefined`, so no Authorization header is ever built for it. A bare
 * hostname, a `git@host:org/repo` SCP-style remote, or a full URL are all accepted.
 */
export function githubTokenForRemote(
	remote: string,
	token: string,
	configuredHost: string = DEFAULT_GITHUB_HOST,
): string | undefined {
	const host = extractHost(remote);
	if (host === null) return undefined;
	return isGithubHost(host, configuredHost) ? token : undefined;
}

/**
 * Extract the host from a remote string: a full URL (`https://github.com/o/r`), an
 * SCP-style git remote (`git@github.com:o/r.git`), or a bare host (`github.com`).
 * Returns null when no host can be parsed (fail-closed → the guard denies the token).
 */
export function extractHost(remote: string): string | null {
	const trimmed = remote.trim();
	if (trimmed === "") return null;
	// SCP-style: user@host:path
	const scp = /^[^/@]+@([^/:]+):/.exec(trimmed);
	if (scp !== null) return scp[1] ?? null;
	// URL form (http/https/ssh/git).
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		try {
			return new URL(trimmed).hostname;
		} catch {
			return null;
		}
	}
	// Bare host or host/path — take the first path segment as the host.
	const bare = trimmed.split("/")[0];
	return bare !== undefined && bare !== "" ? bare : null;
}

// ────────────────────────────────────────────────────────────────────────────
// The GitHubApi SEAM — GraphQL (issues/PRs/discussions) + REST (Markdown docs).
// The real impl wraps `fetch`; the test fakes it. Provider-specific transport
// lives behind THIS interface so the provider stays pure + testable with no creds.
// ────────────────────────────────────────────────────────────────────────────

/** A repo coordinate parsed from `Org/Repo`. */
export interface RepoRef {
	/** The repository owner (org or user). */
	readonly owner: string;
	/** The repository name. */
	readonly name: string;
}

/** One issue / pull request / discussion fetched over GraphQL (e-AC-1). */
export interface GithubItem {
	/** The item kind — `issue` | `pull` | `discussion`. */
	readonly type: "issue" | "pull" | "discussion";
	/** The item number within the repo (`#42`). */
	readonly number: number;
	/** The item title. */
	readonly title: string;
	/** The item body (Markdown). */
	readonly body: string;
	/** The author login (provenance/audit detail, never a secret). */
	readonly author?: string;
	/** The item URL (audit detail). */
	readonly url?: string;
}

/** One repo file entry fetched over REST (e-AC-2 — only Markdown is ingested). */
export interface GithubFile {
	/** The repo-relative path (`docs/README.md`). */
	readonly path: string;
}

/** A Markdown doc with its content, fetched over REST. */
export interface GithubDoc {
	/** The repo-relative path. */
	readonly path: string;
	/** The file content (Markdown). */
	readonly content: string;
}

/**
 * A partial-fetch failure surfaced by the transport (e-AC-5). The seam returns these
 * INLINE rather than throwing-and-aborting, so a single failed page becomes a
 * failure artifact while the rest of the scan proceeds. The reason is human-readable
 * and carries NO token.
 */
export interface GithubFetchFailure {
	/** A short scope for the failed unit (`issues`, `docs/CHANGELOG.md`, …). */
	readonly path: string;
	/** Why it failed (status text, parse error) — never contains a token. */
	readonly reason: string;
	/** Optional structured detail (status code, page cursor). */
	readonly detail?: Record<string, unknown>;
}

/** The result of a GraphQL items fetch: the items pulled + any partial failures. */
export interface GithubItemsResult {
	/** The successfully fetched items. */
	readonly items: readonly GithubItem[];
	/** Partial failures to write as failure artifacts (e-AC-5). */
	readonly failures: readonly GithubFetchFailure[];
}

/** The result of a REST doc listing: the file tree + any partial failures. */
export interface GithubFilesResult {
	/** Every file path in the listed tree (Markdown filtering happens in the provider). */
	readonly files: readonly GithubFile[];
	/** Partial failures to write as failure artifacts (e-AC-5). */
	readonly failures: readonly GithubFetchFailure[];
}

/**
 * The GitHub transport SEAM (GraphQL + REST). Provider-specific HTTP lives behind
 * this so the provider is pure and the test drives a fake. EVERY method is bound to
 * the configured GitHub host (the impl pins `api.github.com` / the Enterprise host);
 * the token-exfiltration guard ({@link githubTokenForRemote}) governs whether a
 * token is ever paired with a destination, and the seam NEVER receives a non-GitHub
 * URL from the provider. The transport returns partial failures inline (e-AC-5)
 * instead of throwing-and-aborting an entire index.
 */
export interface GitHubApi {
	/**
	 * The GitHub host this transport talks to (e.g. `github.com`). Pinned at
	 * construction; the provider asserts the token is only ever used against it.
	 */
	readonly host: string;
	/**
	 * Fetch issues / pull requests / discussions over GraphQL for the selected
	 * resource types (e-AC-1). The token authorizes the call; the impl attaches it
	 * ONLY to the GitHub host. Returns the items + any partial-page failures (e-AC-5).
	 */
	fetchItems(args: {
		readonly repo: RepoRef;
		readonly token: string;
		readonly resourceTypes: readonly GithubResourceType[];
	}): Promise<GithubItemsResult>;
	/**
	 * List the repo's file tree over REST (e-AC-2). The provider filters to Markdown
	 * + path globs after; the transport just returns the tree (+ partial failures).
	 */
	listFiles(args: { readonly repo: RepoRef; readonly token: string }): Promise<GithubFilesResult>;
	/**
	 * Fetch one Markdown doc's content over REST (e-AC-1). Returns null on a missing
	 * file (the provider records a failure). The token reaches only the GitHub host.
	 */
	fetchDoc(args: { readonly repo: RepoRef; readonly token: string; readonly path: string }): Promise<GithubDoc | null>;
}

// ────────────────────────────────────────────────────────────────────────────
// Config — read out of SourceConfig.settings (provider-agnostic contract).
// ────────────────────────────────────────────────────────────────────────────

/** The resource types `--resource-type` selects (e-AC-1). */
export const GITHUB_RESOURCE_TYPES = Object.freeze(["issues", "docs"] as const);
/** A selectable GitHub resource type. */
export type GithubResourceType = (typeof GITHUB_RESOURCE_TYPES)[number];

/** The default item cap per repo when `maxItemsPerRepo` is unset (e-AC-3). */
export const DEFAULT_MAX_ITEMS_PER_REPO = 1000;

/** The resolved GitHub provider settings, read from {@link SourceConfig.settings}. */
export interface GithubSettings {
	/** The repo `{ owner, name }` parsed from `--repo Org/Repo`. */
	readonly repo: RepoRef;
	/** The secret reference for the token (`--token-ref GITHUB_TOKEN`). NEVER the raw token. */
	readonly tokenRef: string;
	/** The selected resource types (`issues`, `docs`). Defaults to both. */
	readonly resourceTypes: readonly GithubResourceType[];
	/** The per-repo item cap (e-AC-3). */
	readonly maxItemsPerRepo: number;
	/** The doc path globs (e-AC-2). Defaults to all Markdown. */
	readonly docGlobs: readonly string[];
	/** The configured GitHub host (Enterprise override). Defaults to github.com. */
	readonly host: string;
	/** The org the source is mounted into (from the config scope). */
	readonly org: string;
	/** The workspace the source is mounted into (from the config scope). */
	readonly workspace: string;
	/** The source instance id (set by the registry; falls back to `owner/repo`). */
	readonly sourceId: string;
}

/** Parse `Org/Repo` into a {@link RepoRef}; returns null on a malformed value. */
export function parseRepoRef(repo: unknown): RepoRef | null {
	if (typeof repo !== "string") return null;
	const parts = repo.trim().split("/");
	if (parts.length !== 2) return null;
	const [owner, name] = parts;
	if (owner === undefined || name === undefined || owner === "" || name === "") return null;
	return { owner, name };
}

/**
 * Read + validate the GitHub settings out of a {@link SourceConfig}. The contract is
 * provider-agnostic (`settings` is a schemaless blob), so the provider reads its OWN
 * keys here and fails closed on a missing repo or token-ref. The token-ref is a
 * REFERENCE string — a raw token is never accepted into config (the security thesis).
 */
export function readGithubSettings(config: SourceConfig): GithubSettings | null {
	const s = config.settings;
	const repo = parseRepoRef(s.repo ?? config.root);
	if (repo === null) return null;
	const tokenRef = typeof s.tokenRef === "string" && s.tokenRef !== "" ? s.tokenRef : null;
	if (tokenRef === null) return null;

	const resourceTypes = normalizeResourceTypes(s.resourceTypes);
	const maxItemsPerRepo = normalizeCap(s.maxItemsPerRepo);
	const docGlobs = normalizeGlobs(s.docGlobs);
	const host = typeof s.host === "string" && s.host.trim() !== "" ? s.host.trim() : DEFAULT_GITHUB_HOST;
	const sourceId = typeof s.sourceId === "string" && s.sourceId !== "" ? s.sourceId : `${repo.owner}/${repo.name}`;

	return {
		repo,
		tokenRef,
		resourceTypes,
		maxItemsPerRepo,
		docGlobs,
		host,
		org: config.org,
		workspace: config.workspace,
		sourceId,
	};
}

/** Coerce the configured resource types to the valid set; default to both. */
function normalizeResourceTypes(raw: unknown): readonly GithubResourceType[] {
	const valid = (v: unknown): v is GithubResourceType =>
		typeof v === "string" && (GITHUB_RESOURCE_TYPES as readonly string[]).includes(v);
	if (Array.isArray(raw)) {
		const picked = raw.filter(valid);
		if (picked.length > 0) return [...new Set(picked)];
	}
	if (valid(raw)) return [raw];
	return [...GITHUB_RESOURCE_TYPES];
}

/** Coerce the cap to a positive integer; default to {@link DEFAULT_MAX_ITEMS_PER_REPO}. */
function normalizeCap(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ITEMS_PER_REPO;
	return Math.floor(n);
}

/** Coerce the doc globs to a string list; default to all Markdown. */
function normalizeGlobs(raw: unknown): readonly string[] {
	if (Array.isArray(raw)) {
		const globs = raw.filter((g): g is string => typeof g === "string" && g !== "");
		if (globs.length > 0) return globs;
	}
	// Default: all Markdown, both extensions `isMarkdownPath` accepts.
	return ["**/*.md", "**/*.markdown"];
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown + glob filtering (e-AC-2)
// ────────────────────────────────────────────────────────────────────────────

/** True when `path` is a Markdown file (`.md` / `.markdown`, case-insensitive). e-AC-2. */
export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown)$/i.test(path.trim());
}

/**
 * True when `path` matches at least one of the doc globs (e-AC-2). A minimal glob:
 * `**` matches any path-segment span, `*` matches within a segment, everything else
 * is literal. Kept dependency-free (no minimatch) — the supported pattern set is
 * small and the rule is explicit.
 */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
	const norm = path.replace(/^\.?\//, "");
	return globs.some((glob) => globToRegExp(glob).test(norm));
}

/** Compile a minimal glob to a RegExp. Pure. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**` → match across path segments. The `**/` form (a leading-dirs
				// prefix like `**/*.md`) collapses to "zero or more leading dirs" so it
				// also matches a file at the root; a bare/trailing `**` (e.g. `docs/**`)
				// matches anything below, including a direct child file.
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (".+?^${}()|[]\\".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	return new RegExp(`^${re}$`);
}

// ────────────────────────────────────────────────────────────────────────────
// Provenance + source_path construction (e-AC-6)
// ────────────────────────────────────────────────────────────────────────────

/** The `source_root` for a GitHub source: `owner/repo`. */
export function repoRoot(repo: RepoRef): string {
	return `${repo.owner}/${repo.name}`;
}

/** The `source_path` for an issue/PR/discussion (`issues/#42`, `pulls/#7`, …). */
export function itemPath(item: Pick<GithubItem, "type" | "number">): string {
	const segment = item.type === "issue" ? "issues" : item.type === "pull" ? "pulls" : "discussions";
	return `${segment}/#${item.number}`;
}

/** Build the provenance quartet + scope for a GitHub unit (e-AC-6 / a-AC-3). */
function provenanceFor(cfg: GithubSettings, sourcePath: string): Provenance {
	return {
		sourceId: cfg.sourceId,
		sourceKind: "github",
		sourcePath,
		sourceRoot: repoRoot(cfg.repo),
		org: cfg.org,
		workspace: cfg.workspace,
	};
}

/** Build a provenanced artifact for an issue / PR / discussion (e-AC-6). */
export function itemArtifact(item: GithubItem, cfg: GithubSettings): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, itemPath(item)),
		kind: "issue",
		title: item.title,
		content: item.body,
		summary: "",
		metadata: {
			type: item.type,
			number: item.number,
			...(item.author !== undefined ? { author: item.author } : {}),
			...(item.url !== undefined ? { url: item.url } : {}),
		},
	};
}

/** Build a provenanced artifact for a Markdown doc (e-AC-2 / e-AC-6). */
export function docArtifact(doc: GithubDoc, cfg: GithubSettings): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, `docs/${doc.path}`),
		kind: "document",
		title: doc.path,
		content: doc.content,
		summary: "",
		metadata: { path: doc.path },
	};
}

/** Build a FAILURE artifact for a partial fetch failure (e-AC-5). */
export function failureArtifact(failure: GithubFetchFailure, cfg: GithubSettings): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, failure.path),
		kind: "issue",
		title: `github fetch failure: ${failure.path}`,
		content: failure.reason,
		failure: {
			reason: failure.reason,
			...(failure.detail !== undefined ? { detail: failure.detail } : {}),
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The provider
// ────────────────────────────────────────────────────────────────────────────

/** Construction deps for the GitHub provider (injected — CONVENTIONS §1). */
export interface GithubProviderDeps {
	/** The GitHub transport seam (GraphQL + REST). The test fakes it; the daemon wires `fetch`. */
	readonly api: GitHubApi;
	/** The secret resolver — resolves `--token-ref` to the token at use-time (NEVER a raw token). */
	readonly secrets: SecretResolver;
}

/**
 * The GitHub provider. Conforms to {@link SourceProvider}: `connect` resolves the
 * token from the secret ref (e-AC-1) and reports health; `index` pulls issues/PRs/
 * discussions over GraphQL + selected Markdown docs over REST, bounded by
 * `maxItemsPerRepo` + globs (e-AC-2/3), yielding a provenanced {@link SourceArtifact}
 * per item (e-AC-6) and a `failure` artifact per partial failure (e-AC-5). The token
 * resolves once and is held in the provider's closure ONLY — never on an artifact,
 * its metadata, or a log. It only ever reaches the GitHub host (e-AC-4).
 *
 * The `deps` argument is REQUIRED to actually index. Omitting it (the legacy stub
 * shape used by a daemon that has not wired the transport) yields an honest
 * `unreachable` health + an empty index, so nothing silently half-runs.
 */
export function createGithubProvider(deps?: GithubProviderDeps): SourceProvider {
	// Resolved-at-connect state, held in this closure ONLY (never on an artifact/log).
	let token: string | null = null;
	let settings: GithubSettings | null = null;
	let lastError: string | null = null;

	async function* index(_scope: IndexScope): AsyncIterable<SourceArtifact> {
		if (deps === undefined || settings === null || token === null) {
			// Not connected / not wired → nothing to yield (connect reported the reason).
			return;
		}
		const cfg = settings;
		const tok = token;
		const cap = cfg.maxItemsPerRepo;
		let yielded = 0;

		// ── Issues / PRs / discussions over GraphQL (e-AC-1) ──────────────────
		if (cfg.resourceTypes.includes("issues")) {
			const result = await deps.api.fetchItems({ repo: cfg.repo, token: tok, resourceTypes: cfg.resourceTypes });
			for (const item of result.items) {
				if (yielded >= cap) break; // e-AC-3: never exceed the per-repo cap.
				yield itemArtifact(item, cfg);
				yielded += 1;
			}
			for (const failure of result.failures) {
				yield failureArtifact(failure, cfg); // e-AC-5 — a data point, not an abort.
			}
		}

		// ── Selected Markdown docs over REST (e-AC-1 / e-AC-2) ────────────────
		if (cfg.resourceTypes.includes("docs") && yielded < cap) {
			const listing = await deps.api.listFiles({ repo: cfg.repo, token: tok });
			for (const file of listing.files) {
				if (yielded >= cap) break; // e-AC-3.
				if (!isMarkdownPath(file.path)) continue; // e-AC-2: NON-Markdown SKIPPED.
				if (!matchesAnyGlob(file.path, cfg.docGlobs)) continue; // e-AC-2: bounded by globs.
				const doc = await deps.api.fetchDoc({ repo: cfg.repo, token: tok, path: file.path });
				if (doc === null) {
					yield failureArtifact({ path: file.path, reason: `doc ${file.path} could not be fetched` }, cfg);
					continue;
				}
				yield docArtifact(doc, cfg);
				yielded += 1;
			}
			for (const failure of listing.failures) {
				yield failureArtifact(failure, cfg);
			}
		}
	}

	return {
		kind: "github",

		async connect(config: SourceConfig): Promise<ProviderHealth> {
			if (deps === undefined) {
				return { state: "unreachable", detail: "github provider transport not wired" };
			}
			settings = readGithubSettings(config);
			if (settings === null) {
				lastError = "github source config missing repo or token-ref";
				return { state: "unreachable", detail: lastError };
			}
			// Defense in depth (e-AC-4): the transport host MUST be the configured GitHub
			// host before the token is ever resolved/used. A mismatch refuses to proceed,
			// so a misconfigured transport can never receive the token.
			if (!isGithubHost(deps.api.host, settings.host)) {
				lastError = `transport host ${deps.api.host} is not the configured GitHub host`;
				settings = null;
				return { state: "unreachable", detail: lastError };
			}
			// Resolve the token from the secret REF (e-AC-1). The raw value never enters
			// config; it lives in this closure only and is scoped to the GitHub host (e-AC-4).
			try {
				token = await deps.secrets.resolve(settings.tokenRef);
			} catch {
				// NEVER log the ref's resolved value; report only that resolution failed.
				lastError = `could not resolve token reference ${settings.tokenRef}`;
				return { state: "unreachable", detail: lastError };
			}
			return { state: "connected" };
		},

		index,

		async health(): Promise<ProviderHealth> {
			if (deps === undefined) {
				return { state: "unreachable", detail: "github provider transport not wired" };
			}
			if (token === null || settings === null) {
				return { state: "unreachable", detail: lastError ?? "github provider not connected" };
			}
			return { state: "connected" };
		},

		async close(): Promise<void> {
			// Drop the resolved token from memory on purge/teardown. No network resources held.
			token = null;
		},
	};
}
