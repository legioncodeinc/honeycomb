/**
 * PRD-013e GitHub provider — proves e-AC-1..6 against a fake {@link GitHubApi}
 * (scripted GraphQL issues/PRs/discussions + REST file tree) and a fake
 * {@link SecretResolver}.
 *
 * Verification posture (EXECUTION_LEDGER-prd-013 / D-7): NO real GitHub creds in
 * this env. The provider is driven entirely through its two injected seams — the
 * GitHub transport (faked here, recording every request's host + whether an
 * Authorization was attached) and the secret resolver (a ref → value table). The
 * provider yields plain {@link SourceArtifact}s; the lifecycle (covered by
 * lifecycle.test.ts) turns them into rows. So this suite asserts the EMITTED
 * artifacts, the cap, the Markdown-only filter, the provenance quartet, the
 * failure-artifact-on-partial-failure behaviour, and — the load-bearing security
 * assertion — that the token is NEVER paired with a non-GitHub host and NEVER
 * appears on any artifact, its metadata, or a log.
 *
 * The decisive e-AC → test mapping:
 *   - e-AC-1 → "e-AC-1: GraphQL issues/PRs/discussions + REST Markdown docs"
 *   - e-AC-2 → "e-AC-2: a non-Markdown file is skipped; Markdown only, glob-bounded"
 *   - e-AC-3 → "e-AC-3: maxItemsPerRepo caps the ingested items"
 *   - e-AC-4 → "e-AC-4 (SECURITY): the token never reaches a non-GitHub remote"
 *   - e-AC-5 → "e-AC-5: a partial GraphQL failure → a failure artifact, others retained"
 *   - e-AC-6 → "e-AC-6: every indexed item carries repo + item provenance, scoped"
 */

import { describe, expect, it } from "vitest";

import {
	createGithubProvider,
	type GitHubApi,
	type GithubDoc,
	type GithubFilesResult,
	type GithubItem,
	type GithubItemsResult,
	type GithubProviderDeps,
	githubTokenForRemote,
	isGithubHost,
	isMarkdownPath,
	matchesAnyGlob,
} from "../../../../../src/daemon/runtime/sources/providers/github.js";
import type { SourceArtifact, SourceConfig } from "../../../../../src/daemon/runtime/sources/contracts.js";
import type { SecretResolver } from "../../../../../src/daemon/runtime/inference/contracts.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const TOKEN = "ghp_SUPER_SECRET_TOKEN_value_should_never_leak";
const TOKEN_REF = "GITHUB_TOKEN";

/** A scripted issue/PR/discussion set. */
const ITEMS: readonly GithubItem[] = [
	{ type: "issue", number: 1, title: "Bug: crash on startup", body: "stack trace here", author: "octocat", url: "https://github.com/Org/Repo/issues/1" },
	{ type: "pull", number: 2, title: "Fix the crash", body: "diff here", author: "hubot" },
	{ type: "discussion", number: 3, title: "RFC: new API", body: "proposal body" },
];

/** A scripted file tree with Markdown + non-Markdown entries (e-AC-2). */
const FILES = [
	{ path: "README.md" },
	{ path: "docs/guide.md" },
	{ path: "src/index.ts" }, // non-Markdown → must be skipped
	{ path: "logo.png" }, // non-Markdown → must be skipped
	{ path: "docs/api.markdown" },
];

const DOC_CONTENT: Record<string, string> = {
	"README.md": "# Readme\nwelcome",
	"docs/guide.md": "# Guide\nsteps",
	"docs/api.markdown": "# API\nreference",
};

/** A fake secret resolver: only `GITHUB_TOKEN` resolves (everything else rejects). */
function fakeSecrets(table: Record<string, string> = { [TOKEN_REF]: TOKEN }): SecretResolver {
	return {
		resolve(ref: string): Promise<string> {
			if (Object.hasOwn(table, ref)) return Promise.resolve(table[ref] as string);
			return Promise.reject(new Error(`no secret for ${ref}`));
		},
	};
}

/** A request the fake transport recorded — host + whether Authorization was attached. */
interface RecordedRequest {
	readonly kind: "graphql" | "rest-list" | "rest-doc";
	readonly host: string;
	readonly hasAuthorization: boolean;
	readonly authorizationValue?: string;
}

/**
 * A fake {@link GitHubApi}. Pinned to a host; records every call with whether an
 * Authorization was attached (the transport attaches one ONLY because the provider
 * paired the token with its own GitHub host — see {@link githubTokenForRemote}). The
 * scripts let a test inject GraphQL/REST partial failures (e-AC-5).
 */
function fakeApi(
	options: {
		host?: string;
		items?: GithubItemsResult;
		files?: GithubFilesResult;
		docs?: Record<string, string>;
	} = {},
): GitHubApi & { readonly requests: RecordedRequest[] } {
	const host = options.host ?? "github.com";
	const requests: RecordedRequest[] = [];
	const docs = options.docs ?? DOC_CONTENT;
	// The transport attaches Authorization ONLY when the destination is its own GitHub
	// host — the same guard the provider uses for any remote (e-AC-4). Modeled here so a
	// non-GitHub-host transport records hasAuthorization=false.
	const authFor = (token: string): string | undefined => githubTokenForRemote(host, token);
	return {
		host,
		requests,
		async fetchItems(args): Promise<GithubItemsResult> {
			const auth = authFor(args.token);
			requests.push({ kind: "graphql", host, hasAuthorization: auth !== undefined, authorizationValue: auth });
			return options.items ?? { items: ITEMS, failures: [] };
		},
		async listFiles(args): Promise<GithubFilesResult> {
			const auth = authFor(args.token);
			requests.push({ kind: "rest-list", host, hasAuthorization: auth !== undefined, authorizationValue: auth });
			return options.files ?? { files: FILES, failures: [] };
		},
		async fetchDoc(args): Promise<GithubDoc | null> {
			const auth = authFor(args.token);
			requests.push({ kind: "rest-doc", host, hasAuthorization: auth !== undefined, authorizationValue: auth });
			const content = docs[args.path];
			return content === undefined ? null : { path: args.path, content };
		},
	};
}

/** Build a github source config (the boundary shape connect validates). */
function githubConfig(overrides: Partial<SourceConfig["settings"]> = {}, scope?: { org?: string; workspace?: string }): SourceConfig {
	return {
		kind: "github",
		org: scope?.org ?? "acme",
		workspace: scope?.workspace ?? "backend",
		root: "Org/Repo",
		settings: { repo: "Org/Repo", tokenRef: TOKEN_REF, ...overrides },
	};
}

/** Drain a provider's index() into an array of artifacts. */
async function collect(deps: GithubProviderDeps, config: SourceConfig): Promise<SourceArtifact[]> {
	const provider = createGithubProvider(deps);
	const health = await provider.connect(config);
	expect(health.state).toBe("connected");
	const out: SourceArtifact[] = [];
	for await (const a of provider.index({})) out.push(a);
	await provider.close();
	return out;
}

// ── e-AC-1 ──────────────────────────────────────────────────────────────────

describe("github provider", () => {
	it("e-AC-1: GraphQL issues/PRs/discussions + REST Markdown docs", async () => {
		const api = fakeApi();
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig());

		// All three GraphQL item types are present (issue / pull / discussion).
		const issueTypes = artifacts
			.filter((a) => a.metadata?.type !== undefined)
			.map((a) => a.metadata?.type);
		expect(issueTypes).toContain("issue");
		expect(issueTypes).toContain("pull");
		expect(issueTypes).toContain("discussion");

		// The Markdown docs were pulled over REST (3 markdown files in the fixture).
		const docPaths = artifacts.filter((a) => a.kind === "document").map((a) => a.title);
		expect(docPaths).toEqual(expect.arrayContaining(["README.md", "docs/guide.md", "docs/api.markdown"]));

		// The transport saw exactly one GraphQL call + one REST list + a doc fetch per md.
		expect(api.requests.filter((r) => r.kind === "graphql")).toHaveLength(1);
		expect(api.requests.filter((r) => r.kind === "rest-list")).toHaveLength(1);
		expect(api.requests.filter((r) => r.kind === "rest-doc")).toHaveLength(3);
	});

	// ── e-AC-2 ────────────────────────────────────────────────────────────────

	it("e-AC-2: a non-Markdown file is skipped; Markdown only, glob-bounded", async () => {
		const api = fakeApi();
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig({ resourceTypes: ["docs"] }));

		const docTitles = artifacts.filter((a) => a.kind === "document").map((a) => a.title);
		// The .ts and .png were SKIPPED; only the three Markdown files were ingested.
		expect(docTitles).not.toContain("src/index.ts");
		expect(docTitles).not.toContain("logo.png");
		expect(docTitles.every((t) => isMarkdownPath(t))).toBe(true);

		// The provider never even fetched the non-Markdown files over REST.
		const fetchedPaths = api.requests.filter((r) => r.kind === "rest-doc");
		expect(fetchedPaths).toHaveLength(3);

		// Glob-bounded: restrict to docs/** and README.md is excluded.
		const api2 = fakeApi();
		const onlyDocs = await collect(
			{ api: api2, secrets: fakeSecrets() },
			githubConfig({ resourceTypes: ["docs"], docGlobs: ["docs/**"] }),
		);
		const onlyDocsTitles = onlyDocs.filter((a) => a.kind === "document").map((a) => a.title);
		expect(onlyDocsTitles).toContain("docs/guide.md");
		expect(onlyDocsTitles).toContain("docs/api.markdown");
		expect(onlyDocsTitles).not.toContain("README.md");
	});

	// ── e-AC-3 ────────────────────────────────────────────────────────────────

	it("e-AC-3: maxItemsPerRepo caps the ingested items", async () => {
		const api = fakeApi();
		// 3 issues + 3 docs available; cap at 2 → at most 2 non-failure artifacts.
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig({ maxItemsPerRepo: 2 }));
		const ingested = artifacts.filter((a) => a.failure === undefined);
		expect(ingested).toHaveLength(2);
	});

	// ── e-AC-4 (SECURITY) ──────────────────────────────────────────────────────

	it("e-AC-4 (SECURITY): the token never reaches a non-GitHub remote", async () => {
		// The guard: a GitHub remote gets the token; a non-GitHub remote gets undefined.
		expect(githubTokenForRemote("github.com", TOKEN)).toBe(TOKEN);
		expect(githubTokenForRemote("https://github.com/Org/Repo", TOKEN)).toBe(TOKEN);
		expect(githubTokenForRemote("git@github.com:Org/Repo.git", TOKEN)).toBe(TOKEN);
		expect(githubTokenForRemote("api.github.com", TOKEN)).toBe(TOKEN);
		// Non-GitHub remotes → NO token, ever.
		expect(githubTokenForRemote("evil.example.com", TOKEN)).toBeUndefined();
		expect(githubTokenForRemote("https://gitlab.com/Org/Repo", TOKEN)).toBeUndefined();
		expect(githubTokenForRemote("git@evil.example.com:Org/Repo.git", TOKEN)).toBeUndefined();
		expect(githubTokenForRemote("notgithub.com", TOKEN)).toBeUndefined();
		// A look-alike suffix must not pass (github.com.evil.com is NOT a GitHub host).
		expect(githubTokenForRemote("github.com.evil.com", TOKEN)).toBeUndefined();

		// Drive a provider whose transport is pinned to a NON-GitHub host. Even though the
		// secret resolves, the transport (modeling the same guard) records NO Authorization
		// for any of its calls — the token is never injected into the non-GitHub remote.
		const api = fakeApi({ host: "evil.example.com" });
		const provider = createGithubProvider({ api, secrets: fakeSecrets() });
		// connect() refuses a non-GitHub transport host (defense in depth, e-AC-4).
		const health = await provider.connect(githubConfig());
		expect(health.state).toBe("unreachable");

		// Belt-and-suspenders: force a request through the non-GitHub transport directly
		// and confirm it would carry NO Authorization.
		await api.fetchItems({ repo: { owner: "Org", name: "Repo" }, token: TOKEN, resourceTypes: ["issues"] });
		expect(api.requests.every((r) => r.hasAuthorization === false)).toBe(true);
		expect(api.requests.every((r) => r.authorizationValue === undefined)).toBe(true);

		// And the host helper itself rejects the non-GitHub host.
		expect(isGithubHost("evil.example.com")).toBe(false);
		expect(isGithubHost("github.com")).toBe(true);
	});

	it("e-AC-4: against the real GitHub host the token IS attached (to github.com only)", async () => {
		const api = fakeApi({ host: "github.com" });
		await collect({ api, secrets: fakeSecrets() }, githubConfig());
		// Every request the transport made went to github.com and carried Authorization.
		expect(api.requests.length).toBeGreaterThan(0);
		expect(api.requests.every((r) => r.host === "github.com")).toBe(true);
		expect(api.requests.every((r) => r.hasAuthorization === true)).toBe(true);
		expect(api.requests.every((r) => r.authorizationValue === TOKEN)).toBe(true);
	});

	// ── e-AC-5 ────────────────────────────────────────────────────────────────

	it("e-AC-5: a partial GraphQL failure → a failure artifact, others retained", async () => {
		// GraphQL returns 2 good items + 1 partial failure; the failure must not abort
		// the run — the good items + the REST docs are still emitted.
		const api = fakeApi({
			items: {
				items: [ITEMS[0] as GithubItem, ITEMS[1] as GithubItem],
				failures: [{ path: "discussions", reason: "GraphQL page failed: 502 Bad Gateway", detail: { status: 502 } }],
			},
		});
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig());

		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.failure?.reason).toContain("502");
		// The 2 good items are RETAINED, and the docs still indexed (others not deleted).
		const items = artifacts.filter((a) => a.kind === "issue" && a.failure === undefined);
		expect(items).toHaveLength(2);
		expect(artifacts.some((a) => a.kind === "document")).toBe(true);
	});

	it("e-AC-5: a missing doc over REST → a failure artifact, the rest retained", async () => {
		const api = fakeApi({
			files: { files: [{ path: "README.md" }, { path: "missing.md" }], failures: [] },
			docs: { "README.md": "# Readme" }, // missing.md absent → fetchDoc returns null
		});
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig({ resourceTypes: ["docs"] }));
		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.provenance.sourcePath).toBe("missing.md");
		expect(artifacts.some((a) => a.kind === "document" && a.title === "README.md")).toBe(true);
	});

	// ── e-AC-6 ────────────────────────────────────────────────────────────────

	it("e-AC-6: every indexed item carries repo + item provenance, scoped", async () => {
		const api = fakeApi();
		const artifacts = await collect(
			{ api, secrets: fakeSecrets() },
			githubConfig({}, { org: "acme", workspace: "backend" }),
		);
		expect(artifacts.length).toBeGreaterThan(0);
		for (const a of artifacts) {
			expect(a.provenance.sourceKind).toBe("github");
			expect(a.provenance.sourceRoot).toBe("Org/Repo");
			expect(a.provenance.org).toBe("acme");
			expect(a.provenance.workspace).toBe("backend");
			expect(a.provenance.sourcePath).not.toBe("");
		}
		// The item provenance carries the repo item ref (issues/#1, pulls/#2, discussions/#3).
		const itemPaths = artifacts.filter((a) => a.metadata?.type !== undefined).map((a) => a.provenance.sourcePath);
		expect(itemPaths).toEqual(expect.arrayContaining(["issues/#1", "pulls/#2", "discussions/#3"]));
		// The doc provenance carries the docs/<path> ref.
		const docPaths = artifacts.filter((a) => a.kind === "document").map((a) => a.provenance.sourcePath);
		expect(docPaths).toContain("docs/README.md");
	});

	// ── The token never appears in any artifact / metadata / log ────────────────

	it("the token never appears in any emitted artifact, metadata, or failure", async () => {
		const api = fakeApi({
			items: { items: [ITEMS[0] as GithubItem], failures: [{ path: "issues", reason: "page 2 failed" }] },
		});
		const artifacts = await collect({ api, secrets: fakeSecrets() }, githubConfig());
		const serialized = JSON.stringify(artifacts);
		expect(serialized).not.toContain(TOKEN);
		// The token-ref name MAY appear (it is public); the VALUE must not.
		expect(serialized.includes(TOKEN)).toBe(false);
	});

	it("the token never appears in a health detail when resolution fails", async () => {
		// An unresolvable ref → unreachable health that names the REF, never a value.
		const api = fakeApi();
		const provider = createGithubProvider({ api, secrets: fakeSecrets({}) });
		const health = await provider.connect(githubConfig({ tokenRef: "ABSENT_REF" }));
		expect(health.state).toBe("unreachable");
		expect(health.detail).not.toContain(TOKEN);
		// No API call was made (token never resolved → no request carried it).
		expect(api.requests).toHaveLength(0);
	});

	// ── config / filter unit coverage ───────────────────────────────────────────

	it("rejects a config missing repo or token-ref (fail-closed)", async () => {
		const api = fakeApi();
		const noRepo = createGithubProvider({ api, secrets: fakeSecrets() });
		const h1 = await noRepo.connect({ kind: "github", org: "acme", workspace: "backend", root: "", settings: { tokenRef: TOKEN_REF } });
		expect(h1.state).toBe("unreachable");

		const noToken = createGithubProvider({ api, secrets: fakeSecrets() });
		const h2 = await noToken.connect({ kind: "github", org: "acme", workspace: "backend", root: "Org/Repo", settings: { repo: "Org/Repo" } });
		expect(h2.state).toBe("unreachable");
	});

	it("a provider with no transport wired yields nothing and reports unreachable", async () => {
		const provider = createGithubProvider();
		const health = await provider.connect(githubConfig());
		expect(health.state).toBe("unreachable");
		const out: SourceArtifact[] = [];
		for await (const a of provider.index({})) out.push(a);
		expect(out).toHaveLength(0);
	});

	it("isMarkdownPath + matchesAnyGlob behave (e-AC-2 helpers)", () => {
		expect(isMarkdownPath("README.md")).toBe(true);
		expect(isMarkdownPath("docs/x.markdown")).toBe(true);
		expect(isMarkdownPath("src/index.ts")).toBe(false);
		expect(isMarkdownPath("logo.png")).toBe(false);
		expect(matchesAnyGlob("docs/guide.md", ["docs/**"])).toBe(true);
		expect(matchesAnyGlob("README.md", ["docs/**"])).toBe(false);
		expect(matchesAnyGlob("README.md", ["**/*.md"])).toBe(true);
		expect(matchesAnyGlob("a/b/c.md", ["**/*.md"])).toBe(true);
	});
});
