/**
 * Daemon-served dashboard contracts + seams — PRD-020b Wave 1 (the view-data layer).
 *
 * ── THE THESIS (FR-1..FR-9 / a-AC-1 / a-AC-2 / D-2 / D-6) ────────────────────
 *   The dashboard renders KPIs, sessions, settings, the codebase graph, rules, and
 *   skill-sync state — ALL read through the daemon. It is a THIN CLIENT: every view
 *   pulls its view-model from the {@link DashboardDataSource} SEAM (daemon-served),
 *   never opening DeepLake and holding NO storage logic (a-AC-7). When the daemon is
 *   unreachable, the dashboard surfaces a clear {@link Connectivity} state rather than
 *   hanging or showing blank panels (FR-8 / a-AC-2). `src/dashboard` is a
 *   NON_DAEMON_ROOT (D-2; `tests/daemon/storage/invariant.test.ts`).
 *
 * ── D-6 — CANONICAL view layer shared with the Cursor webview ────────────────
 *   These view-models + the view-builders that render them are the CANONICAL
 *   implementation 020c's extension webview EMBEDS (a-AC-5 / c-AC-6). Both surfaces
 *   read the SAME {@link DashboardData} from the SAME daemon data contract — no
 *   duplicate view code. The view-builders are pure (data → render tree), so the CLI
 *   `dashboard` verb and the Cursor webview render identically.
 *
 * ── What Wave 1 ships ────────────────────────────────────────────────────────
 *   The {@link DashboardData} view-model contract (the six view-models), the
 *   {@link DashboardDataSource} seam + {@link createFakeDashboardDataSource} fake, the
 *   {@link Connectivity} state type, and one honest-stub view-builder per view (in
 *   sibling modules). Wave 2 fills the view-builders + the daemon-side
 *   `mountDashboardApi` endpoints (scaffolded in `src/daemon/`). Every export is STABLE.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-020b: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The six view-models (FR-2..FR-6) — what the daemon serves, what the views render
// ─────────────────────────────────────────────────────────────────────────────

/** The KPIs view-model (FR-2): org-level memory metrics. */
export interface KpisView {
	/** Total memories stored (org-scoped). */
	readonly memoryCount: number;
	/**
	 * Total captured sessions.
	 *
	 * NOTE (PRD-035a): in Hivemind's capture model each captured harness TURN becomes one
	 * `sessions`-table row, so this is a turn count. {@link turnCount} carries the same value
	 * under the honest presentation name; `sessionCount` is kept (additive, not renamed) so an
	 * older daemon/newer page — or a PRD-022 consumer reading this shape — degrades safely.
	 */
	readonly sessionCount: number;
	/**
	 * Total captured turns (PRD-035a) — the SAME count as {@link sessionCount}, surfaced under the
	 * presentation-honest name the dashboard renders ("Turns", not "Sessions"). Populated by
	 * `fetchKpisView` from the same `COUNT(*) FROM "sessions"`. Additive: the DeepLake `sessions`
	 * table is NOT renamed (a schema concern, out of scope — PRD-035a D-3).
	 */
	readonly turnCount: number;
	/**
	 * Estimated token savings — a CORPUS-MASS PROXY, not a measurement (PRD-035b). It is
	 * `Σ LENGTH(content) / 4` over the stored memory corpus: the total distilled context AVAILABLE
	 * to be reused, NOT tokens actually injected into any model context. Honest reading: "how much
	 * distilled context the corpus could serve", an upper-bound potential. For the MEASURED meter of
	 * tokens actually served by recall responses + prime digests, read {@link injectedTokens}.
	 */
	readonly estimatedSavings: number;
	/**
	 * MEASURED injected tokens (ISS-010): Σ `memory_injections.tokens` — tokens actually SERVED by
	 * recall responses + prime digests, metered at the serving call sites. Still an upper bound on
	 * tokens the harness ultimately injected (the hook dedupes hits across turns, so served >=
	 * injected), but unlike {@link estimatedSavings} it counts real serving events, not corpus mass.
	 * `0` until the first metered injection lands (or on a storage error — the read is fail-soft).
	 */
	readonly injectedTokens: number;
	/**
	 * Count of TEAM-SHARED skills (PRD-036c) — skills actually shared with the team via the
	 * `synced_assets` substrate (current-version, non-tombstone skill rows), NOT the union total and
	 * NOT local-only disk skills. The "Team skills" KPI binds to THIS defined count so its label and
	 * number can never desync from an incidental panel-array `.length` (036c D-2).
	 */
	readonly teamSkillCount: number;
	/** Free-form additional org metrics, label → value (kept open for Wave-2 additions). */
	readonly extra?: Readonly<Record<string, number>>;
}

/** One captured session row in the sessions view (FR-3). */
export interface SessionRow {
	/** The session id. */
	readonly sessionId: string;
	/** The project path the session ran in. */
	readonly project: string;
	/** When the session started (ISO). */
	readonly startedAt: string;
	/** The captured event count. */
	readonly eventCount: number;
	/** The session status (e.g. `captured`, `summarized`). */
	readonly status: string;
}

/** The sessions view-model (FR-3): captured sessions with metadata. */
export interface SessionsView {
	/** The session rows, newest first. */
	readonly sessions: readonly SessionRow[];
}

/** The settings view-model (FR-4): active org + workspace configuration. */
export interface SettingsView {
	/** The active org id. */
	readonly orgId: string;
	/** The active org display name. */
	readonly orgName: string;
	/** The active workspace. */
	readonly workspace: string;
	/** Selected daemon/runtime settings exposed to the operator (label → value). */
	readonly settings: Readonly<Record<string, string>>;
}

/** A node in the codebase-graph canvas (FR-5). */
export interface GraphNode {
	/** The node id (stable across renders). */
	readonly id: string;
	/** The display label (e.g. a symbol or file name). */
	readonly label: string;
	/** The node kind (e.g. `file`, `function`, `class`). */
	readonly kind: string;
}

/** An edge in the codebase-graph canvas (FR-5). */
export interface GraphEdge {
	/** The source node id. */
	readonly from: string;
	/** The target node id. */
	readonly to: string;
	/** The edge kind (e.g. `imports`, `calls`). */
	readonly kind: string;
}

/**
 * Bounded-view metadata (the memory-aware graph cap). A real codebase snapshot is tens of
 * thousands of nodes; shipping/rendering all of them froze the browser. The daemon now ships only a
 * bounded, importance-ranked SUBSET and reports here what the full graph held vs what was sent, so the
 * UI can state honestly "showing N of M" rather than silently dropping nodes. When a graph fit under the
 * budget whole, `truncated` is `false` and `shownNodes === totalNodes` (the shipped `nodes`/`edges` ARE
 * the full graph). See {@link GraphView.meta} for which producers populate it.
 */
export interface GraphViewMeta {
	/** Total nodes in the underlying snapshot (before the cap). */
	readonly totalNodes: number;
	/** Total edges in the underlying snapshot (before the cap). */
	readonly totalEdges: number;
	/** Nodes actually shipped in {@link GraphView.nodes} (≤ totalNodes). */
	readonly shownNodes: number;
	/** Edges actually shipped in {@link GraphView.edges} (≤ totalEdges). */
	readonly shownEdges: number;
	/** True when the cap dropped nodes/edges — the shown set is a subset, not the whole graph. */
	readonly truncated: boolean;
}

/**
 * The codebase-graph view-model (FR-5 / a-AC-3 / a-AC-6). `built` is false when no graph
 * has been built for the workspace → the view shows the empty-state prompt to run
 * `honeycomb graph build` rather than an error (a-AC-6). When `built`, the canvas renders
 * from the nodes/edges the daemon's graph endpoints serve.
 *
 * The served nodes/edges are BOUNDED (the graph memory cap): for a large snapshot the daemon ships only the
 * most-connected subset and reports the full-vs-shown counts in {@link meta}. The view is never the
 * raw tens-of-thousands-node snapshot, so no consumer can be handed a payload that freezes the browser.
 */
export interface GraphView {
	/** True when a graph has been built for the workspace (FR-5 / a-AC-6). */
	readonly built: boolean;
	/** The graph nodes (empty when not built; a bounded subset for a large graph — see {@link meta}). */
	readonly nodes: readonly GraphNode[];
	/** The graph edges (empty when not built; only edges between shown nodes for a large graph). */
	readonly edges: readonly GraphEdge[];
	/**
	 * Bounded-view metadata (the graph memory cap). The codebase-graph endpoint (`GET /api/graph`)
	 * ALWAYS populates it when `built` — `truncated` tells whether the cap dropped nodes. Other producers
	 * (the memory-graph view, the `built:false` empty state) may OMIT it; consumers must treat it as
	 * optional and fall back to `nodes`/`edges` lengths when it is absent.
	 */
	readonly meta?: GraphViewMeta;
}

/**
 * THE MEMORY-GRAPH VIEW-MODEL (PRD-041b — D-1 / FR-1 / AC-1). The knowledge graph of memories and
 * entities (PRD-008 ontology), shaped IDENTICALLY to {@link GraphView} so the SAME dashboard
 * `GraphCanvas` + pure `layout(...)` render it unchanged — it is a documented, greppable alias of the
 * `GraphView` shape, NOT a structural fork. The mapping (when data exists): PRD-008 `entities` →
 * {@link GraphNode}s whose `kind` carries the ontology kind (entity / aspect / attribute); PRD-008
 * `entity_dependencies` (and later supersession / mention) → {@link GraphEdge}s whose `kind` carries
 * the relation (`depends_on` / `supersedes` / `mentions` / …).
 *
 * ── NOW (the foundation this PRD ships — provable end-to-end against an EMPTY graph) ──
 *   - this documented view-model contract (the named type below);
 *   - a daemon endpoint (`GET /api/memory-graph`, `fetchMemoryGraphView`) that serves it for the
 *     active scope, returning the honest `{ built: false, nodes: [], edges: [] }` empty state when
 *     the PRD-008 ontology tables are empty/absent — the SAME `built` contract {@link GraphView} uses;
 *   - the Codebase ↔ Memory toggle + shared rendering (the same canvas draws either source).
 *
 * ── DEFERRED until PRD-008 (In-Work) data is populated/served — each is an Open Question, NOT a stub ──
 *   - populating real entities/edges (the endpoint returns `built: false` until rows exist — OQ-2);
 *   - which ontology objects become nodes (entities only, or also aspects/attributes — OQ-1);
 *   - ontology-kind-specific legend/iconography;
 *   - supersession-lineage affordances (showing a claim's superseded history) + the provenance UI
 *     (the graph "is never authoritative on its own" — PRD-008 / D-5 / OQ-4);
 *   - edge-threshold tuning for which `depends_on` edges are visible/traversable (PRD-008 AC-3 / OQ-3).
 *
 * The implementation contains NO stub that fakes a populated graph — the foundation is honest about
 * the empty state and never implies a memory graph exists when it does not (041b AC-5).
 *
 * ── ISS-002 (WHY-EMPTY honesty, SP-3) ─────────────────────────────────────────
 * A `built:false` response now ALSO carries an ADDITIVE `reason` from the closed
 * {@link MemoryGraphEmptyReason} set, so the page (and an operator curl) can tell "the gate is
 * off" apart from "the gate is on but nothing has been extracted yet" apart from "the read
 * itself failed". Every pre-ISS-002 field is byte-identical (old hive parses this response with
 * a bare `.catch` — the shape only GAINS optional fields, never changes or loses one).
 */

/**
 * WHY a memory-graph response is `built:false` (ISS-002 — the closed set):
 *   - `graph_off`       — the RESOLVED graph gate is off (env override, vault `graph.enabled`
 *                          saved false, or memory formation itself off / worker not built);
 *   - `no_entities_yet` — the gate is ON but zero entity rows exist (nothing extracted or
 *                          persisted yet — including the not-yet-created-table case);
 *   - `query_error`     — the entities read FAILED (a real storage/connection error, NOT the
 *                          benign missing-table case). Previously indistinguishable from empty.
 */
export type MemoryGraphEmptyReason = "graph_off" | "no_entities_yet" | "query_error";

/** See the docblock above {@link MemoryGraphEmptyReason} — GraphView plus the additive ISS-002 fields. */
export interface MemoryGraphView extends GraphView {
	/** Present ONLY when `built:false`: why the graph is empty (ISS-002, additive). */
	readonly reason?: MemoryGraphEmptyReason;
	/** With `no_entities_yet`: how many memories exist to be scanned (cheap COUNT, additive). */
	readonly memoriesScanned?: number;
	/** With `no_entities_yet`: how many entity rows the read found (always 0 on this path, additive). */
	readonly entitiesFound?: number;
}

/** One org-wide rule in the rules view (FR-6 / a-AC-4). */
export interface RuleRow {
	/** The rule id. */
	readonly id: string;
	/** The rule's human title. */
	readonly title: string;
	/** True when the rule is active. */
	readonly active: boolean;
}

/** The rules view-model (FR-6 / a-AC-4): the org-wide rules from `honeycomb_rules`. */
export interface RulesView {
	/** The active org rules. */
	readonly rules: readonly RuleRow[];
}

/** One skill in the skill-sync view (FR-6). */
export interface SkillSyncRow {
	/** The skill name. */
	readonly name: string;
	/** The skill scope (`org` | `team` | `personal` | `repository` | `user`). */
	readonly scope: string;
	/**
	 * The sync state. One of `local` | `shared` | `synced` | `pulled` | `pending` (PRD-036b).
	 *
	 * `local` (PRD-036b) is a NEW allowed value: a skill installed on disk (discovered by the
	 * 036a scanner) but NOT present in the team substrate. The field stays a `string`, so this is
	 * a documentation + value-set extension, NOT a breaking type change — the Cursor webview, which
	 * shares this contract, keeps rendering (036b D-2). On a collision (a skill both on disk and in
	 * the substrate) the SUBSTRATE state wins, never `local` (036b D-1).
	 */
	readonly syncState: string;
}

/** The skill-sync view-model (FR-6): pulled + shared team skills. */
export interface SkillSyncView {
	/** The skills and their sync state. */
	readonly skills: readonly SkillSyncRow[];
}

/**
 * THE FULL DASHBOARD VIEW-MODEL (FR-2..FR-6 / a-AC-1). The six view-models the daemon
 * serves and the views render. This is the CANONICAL contract 020c's webview embeds (D-6):
 * the same shape feeds the daemon-served dashboard and the Cursor webview, so both surfaces
 * render identically with no duplicate view code.
 */
export interface DashboardData {
	/** KPIs (FR-2). */
	readonly kpis: KpisView;
	/** Sessions (FR-3). */
	readonly sessions: SessionsView;
	/** Settings (FR-4). */
	readonly settings: SettingsView;
	/** Codebase graph (FR-5). */
	readonly graph: GraphView;
	/** Org rules (FR-6). */
	readonly rules: RulesView;
	/** Skill-sync state (FR-6). */
	readonly skillSync: SkillSyncView;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity — the clear daemon-down state (FR-8 / a-AC-2 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CONNECTIVITY STATE (FR-8 / a-AC-2). When the daemon is reachable the dashboard
 * renders the views; when it is NOT, it surfaces this state (a banner with the daemon URL
 * + a retry affordance) instead of hanging or showing blank panels. The state reuses the
 * SAME daemon-reachability probe the D1/D2 health dimensions use (020d), so the message is
 * consistent across surfaces. `reachable: false` carries the `url` + a `retry` affordance.
 */
export type Connectivity =
	| { readonly reachable: true; readonly url: string }
	| { readonly reachable: false; readonly url: string; readonly retry: true; readonly detail?: string };

/** Build a reachable connectivity state. */
export function reachable(url: string): Connectivity {
	return { reachable: true, url };
}

/** Build an unreachable connectivity state (banner + retry, FR-8 / a-AC-2). */
export function unreachable(url: string, detail?: string): Connectivity {
	return { reachable: false, url, retry: true, ...(detail !== undefined ? { detail } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DashboardDataSource — the daemon-served data seam (FR-7 / a-AC-1 / D-2 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DATA SEAM (FR-7 / a-AC-1 / D-2). Every view reads its view-model ONLY through this.
 * The real impl fetches each view from the daemon's dashboard endpoints (`/api/diagnostics/kpis`,
 * `/api/diagnostics/sessions`, `/api/diagnostics/settings`, `/api/diagnostics/rules`,
 * `/api/diagnostics/skills`, `/api/graph`); the fake replays
 * a canned {@link DashboardData} / connectivity for view tests. The source NEVER opens
 * DeepLake — the daemon does, behind these endpoints. The SAME source feeds the Cursor
 * webview (D-6), so both surfaces share the data contract.
 */
export interface DashboardDataSource {
	/** Probe daemon reachability (reuses the 020d D1/D2 probe) → the connectivity state (FR-8). */
	probe(): Promise<Connectivity>;
	/** Fetch the full dashboard view-model from the daemon (FR-7 / a-AC-1). */
	fetchAll(): Promise<DashboardData>;
}

/** Options seeding the fake: the canned data + an optional unreachable connectivity. */
export interface FakeDashboardDataSourceOptions {
	/** The canned dashboard data (defaults to an empty-but-valid shape). */
	readonly data?: DashboardData;
	/** Force an unreachable probe (daemon-down test, a-AC-2). Defaults to reachable. */
	readonly down?: boolean;
	/** The daemon url the connectivity state reports. */
	readonly url?: string;
}

/** An empty-but-valid {@link DashboardData} (the fake default + a Wave-2 loading placeholder). */
export const EMPTY_DASHBOARD_DATA: DashboardData = Object.freeze({
	kpis: { memoryCount: 0, sessionCount: 0, turnCount: 0, estimatedSavings: 0, injectedTokens: 0, teamSkillCount: 0 },
	sessions: { sessions: [] },
	settings: { orgId: "", orgName: "", workspace: "", settings: {} },
	graph: { built: false, nodes: [], edges: [] },
	rules: { rules: [] },
	skillSync: { skills: [] },
});

/**
 * Build a fake {@link DashboardDataSource} (the seam Wave-2 view tests drive). Replays a
 * canned {@link DashboardData} and a reachable/unreachable connectivity, so a test asserts
 * the views render from the data (a-AC-1), the daemon-down banner shows (a-AC-2), and the
 * no-graph empty-state fires (a-AC-6) — all without a live daemon.
 */
export function createFakeDashboardDataSource(options: FakeDashboardDataSourceOptions = {}): DashboardDataSource {
	const url = options.url ?? "http://127.0.0.1:3850";
	const data = options.data ?? EMPTY_DASHBOARD_DATA;
	const down = options.down ?? false;
	return {
		async probe(): Promise<Connectivity> {
			return down ? unreachable(url, "daemon not reachable") : reachable(url);
		},
		async fetchAll(): Promise<DashboardData> {
			if (down) return notImplemented("fetchAll called while daemon down — caller must branch on probe() first");
			return data;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-036a — local installed-asset discovery inventory (the on-disk scanner output)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One asset (skill or agent) discovered ON DISK by the local scanner (PRD-036a). This is the
 * shared view-model contract: PRD-036b unions a list of these with the `synced_assets`/`skills`
 * substrate rows, and PRD-042 (the Sync page) renders them. The scanner is READ-ONLY — it never
 * writes, installs, or mutates an asset.
 *
 * Dedupe (036a D-2): the same logical skill installed under multiple harness roots collapses into
 * ONE `DiscoveredAsset`, keyed `(assetType, name)`, with `sourceHarnesses` + `paths` accumulating
 * every install location — so a panel/KPI never double-counts the same logical asset.
 */
export interface DiscoveredAsset {
	/** The logical asset name (skill dir name, or agent file basename without `.md`). Sanitized. */
	readonly name: string;
	/** Short description from the asset's frontmatter `description:` / first `#` heading ("" if none). */
	readonly description: string;
	/** `"skill" | "agent"` — aligned with `SYNCED_ASSET_TYPES` so the 036b join is type-clean. */
	readonly assetType: "skill" | "agent";
	/** Derived scope: `local`/`repository` (project root) | `user` (global root). */
	readonly scope: string;
	/** Every harness this asset is installed in (deduped union, e.g. `["claude-code","cursor"]`). */
	readonly sourceHarnesses: readonly string[];
	/** The on-disk path(s) backing this asset (one per harness install). */
	readonly paths: readonly string[];
}

/** The normalized local-discovery inventory (PRD-036a): discovered skills + agents, deduped. */
export interface LocalAssetInventory {
	/** The discovered skills (`<root>/<name>/SKILL.md` dirs), deduped by name. */
	readonly skills: readonly DiscoveredAsset[];
	/** The discovered agents (`*.md` files under an agents root), deduped by name. */
	readonly agents: readonly DiscoveredAsset[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-060e — the composite ROI VIEW-MODEL (the data half: e-AC-2/6/11/12/13/14/15)
//
// The `/roi` page is a PURE FUNCTION of the {@link RoiView} below: every section
// carries an EXPLICIT status discriminant so a measured `$0` is visibly different
// from `unknown`, all money is INTEGER cents (dollars never appear here — formatting
// is the render edge), modeled savings carries its ASSUMPTION as a data field, and the
// daemon (NOT the component) computes the org/team/agent/project rollups. The component
// switches each section on its `status` and never fetches or groups.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-section status discriminant (e-AC-2). Every section of the {@link RoiView}
 * carries ONE of these so the page renders the right treatment per section rather than a
 * single page-wide state:
 *   - `ok`              — a confident, complete figure (measured-or-fully-read).
 *   - `partial`         — populated but degraded (some inputs read, some missing; e.g. "Claude Code only").
 *   - `absent`          — no data yet (the page shows a dash glyph, NOT `$0.00`).
 *   - `unreachable`     — an input could not be read (billing flap → dash + scoped retry).
 *   - `unauthenticated` — no credentials for the input (a Settings-CTA state, redacted).
 * A measured zero is `ok` with a zero figure — DISTINCT from `absent`.
 */
export type RoiSectionStatus = "ok" | "partial" | "absent" | "unreachable" | "unauthenticated";

/**
 * The cost basis a net/cost line rests on (e-AC-15, mirrors PRD-060f `cost_basis`):
 *   - `measured`  — a billed/metered fact (org/workspace infra read from billing).
 *   - `allocated` — an estimated split of a shared cost down to a team/user; carries the
 *                   SAME `est.`-class subordination as a modeled line, never a measured fact.
 *   - `none`      — no cost line applies (e.g. a savings-only rollup).
 * The page renders an `allocated` net distinctly and flags a MIXED-basis rollup.
 */
export type RoiCostBasisTag = "measured" | "allocated" | "none";

/**
 * The modeled assumption carried on the wire as a DATA FIELD (e-AC-8, the daemon-side
 * mirror of 060b's {@link import("../daemon/runtime/dashboard/roi-savings.js").MemoryInjectionAssumption}).
 * The page's ⓘ popover + page-foot footnote read `assumptionText` VERBATIM from this single
 * source — the page never hardcodes the copy. `signedOff` is `false` until the operator signs
 * off (the page may mark the estimate provisional).
 */
export interface RoiAssumption {
	/** The model-kind machine id (so the page can branch if more models are added). */
	readonly kind: string;
	/** The human-readable assumption string the disclosure surfaces verbatim (the ONE source). */
	readonly assumptionText: string;
	/** Whether the assumption is an operator-signed-off decision (`false` until sign-off). */
	readonly signedOff: boolean;
}

/**
 * The MEASURED + MODELED savings section (e-AC-3). Measured cache savings is the defensible
 * headline (integer cents, `measured` tone); modeled memory-injection savings is the
 * subordinate `est.` line carrying its {@link RoiAssumption}. `blendedCentsPerMtok` is the
 * effective $/Mtok rate — `null` UNTIL token capture is live (the page shows a placeholder,
 * never a fabricated `$0.00`, e-AC-11).
 */
export interface RoiSavingsSection {
	/** The per-section status (e-AC-2): `absent` until any capture lands. */
	readonly status: RoiSectionStatus;
	/** MEASURED cache savings in INTEGER cents (the defensible, billed-fact headline). */
	readonly measuredCents: number;
	/** MODELED memory-injection savings in INTEGER cents (the subordinate `est.` line). */
	readonly modeledCents: number;
	/** The modeled estimate's assumption, carried as data (e-AC-8) — the single disclosure source. */
	readonly assumption: RoiAssumption;
	/** The effective blended rate in cents-per-Mtok, or `null` until capture is live (e-AC-11). */
	readonly blendedCentsPerMtok: number | null;
}

/**
 * The INFRA COST section (e-AC-6, from 060c's billing read-model). `cents` is the measured
 * DeepLake infra cost in INTEGER cents; the `status` carries 060c's billing discriminant so
 * the page distinguishes a billed `$0` (`ok`) from "couldn't read billing" (`unreachable`) /
 * "no credentials" (`unauthenticated`). `costBasis` is `measured` (org/workspace infra is
 * always measured here; a per-team/user allocated share lives on a rollup, not this line).
 */
export interface RoiInfraSection {
	/** The per-section status (e-AC-2/6): how the page tells billed-$0 from couldn't-read. */
	readonly status: RoiSectionStatus;
	/** The measured infra cost in INTEGER cents (`0` when absent — read the STATUS, not the number). */
	readonly cents: number;
	/** The cost basis on this line (e-AC-15): `measured` for org/workspace infra. */
	readonly costBasis: RoiCostBasisTag;
}

/** One pollination contributor split line (the readable per-contributor breakdown the page shows). */
export interface RoiPollinationLine {
	/** The contributor label (e.g. `haiku-skillify`, `deeplake-query`, `deeplake-embedding`). */
	readonly label: string;
	/** This contributor's cost in INTEGER cents. */
	readonly cents: number;
}

/**
 * The POLLINATION COST section (e-AC-6, from 060d's composer). `cents` is the itemized
 * pollination total in INTEGER cents (Haiku skillify + DeepLake GPU sessions); `status` is
 * 060d's worst-of-contributors discriminant mapped onto {@link RoiSectionStatus} so a
 * confident total appears only when both halves are confident. `lines` is the readable split.
 */
export interface RoiPollinationSection {
	/** The per-section status (e-AC-2): the worst of the two contributing halves (060d). */
	readonly status: RoiSectionStatus;
	/** The itemized pollination total in INTEGER cents. */
	readonly cents: number;
	/** The per-contributor split (Haiku + per session_type) the page renders. */
	readonly lines: readonly RoiPollinationLine[];
}

/**
 * The NET-ROI section (e-AC-6, PARTIAL-NET semantics — ISS-011). The net
 * (`saved − (infra + pollination)`) is computed when the savings input is confident
 * (`ok`/`partial`) AND each cost input is usable (`ok`/`partial`/`absent` — an `absent` cost
 * contributes `0`). When ANY contributing input is less than fully `ok` the section is
 * `status: "partial"` with `partial: true` and the degraded inputs named in
 * {@link missingInputs}, so the page can render the net WITH its caveat instead of a dash.
 * `computed: false` remains ONLY for a truly uncomputable net: savings itself
 * absent/unreachable/unauthenticated, or a cost input unreachable/unauthenticated (a cost we
 * KNOW we failed to read would understate the bill — the dishonest direction). Because the
 * net folds a MODELED savings term it inherits `est.` (`modeled: true`); `costBasis` reflects
 * whether the cost half is measured or carries an allocated share.
 */
export interface RoiNetSection {
	/** The per-section status (e-AC-2/6): `ok` when every input was fully `ok`; `partial` when computed from degraded inputs. */
	readonly status: RoiSectionStatus;
	/** True iff the net was actually computed; `false` ⇒ render a dash, not the number. */
	readonly computed: boolean;
	/** The net in INTEGER cents (`0` when `computed: false` — read the STATUS / `computed`, not this). */
	readonly netCents: number;
	/** True — the net folds a modeled term, so it ALWAYS carries `est.` (e-AC-3 net-hero inheritance). */
	readonly modeled: boolean;
	/** The cost basis on the net (e-AC-15): `allocated` when a per-team/user infra share fed it. */
	readonly costBasis: RoiCostBasisTag;
	/** True iff the net was computed from DEGRADED inputs (ISS-011) — render the caveat, not a clean figure. */
	readonly partial: boolean;
	/** The inputs that were less than fully `ok` (`"savings"` / `"infra"` / `"pollination"`), for the caveat copy. */
	readonly missingInputs: readonly string[];
}

/** One ROLLUP dimension the page's dimension switch offers (e-AC-13). */
export type RoiRollupDimension = "org" | "team" | "agent" | "project";

/** One row in a rollup: a dimension key + its summed measured/net cents + the basis flag. */
export interface RoiRollupRow {
	/** The dimension key (the org id / team id / agent id / project id). */
	readonly key: string;
	/** A human label for the key (falls back to the key when no friendlier name resolves). */
	readonly label: string;
	/** Σ measured cache savings for this key, in INTEGER cents. */
	readonly measuredSavingsCents: number;
	/** Σ net (saved − cost) for this key, in INTEGER cents (allocated cost carries `est.`). */
	readonly netCents: number;
	/** Σ infra cost attributed to this key, in INTEGER cents. */
	readonly infraCostCents: number;
	/** The cost basis for THIS row (e-AC-15): `allocated` when its infra share is an estimate. */
	readonly costBasis: RoiCostBasisTag;
	/** Number of sessions (ledger rows) folded into this row. */
	readonly sessions: number;
}

/**
 * One rollup VIEW (e-AC-13): all rows for a single dimension, plus a MIXED-BASIS flag. The
 * daemon computes these as read-time `GROUP BY`s over `roi_metrics` (the component does NO
 * grouping). `mixedBasis` is `true` when the rows span more than one `cost_basis`
 * (`COUNT(DISTINCT cost_basis) > 1`) — the page flags it rather than silently blending.
 */
export interface RoiRollup {
	/** The dimension this rollup groups by (e-AC-13). */
	readonly dimension: RoiRollupDimension;
	/** The grouped rows (one per distinct dimension key). */
	readonly rows: readonly RoiRollupRow[];
	/** True when the rows mix `measured` + `allocated` bases (e-AC-15 mixed-basis flag). */
	readonly mixedBasis: boolean;
}

/**
 * THE COMPOSITE ROI VIEW-MODEL (e-AC-2). The `/roi` page is a PURE FUNCTION of this — every
 * section carries its own {@link RoiSectionStatus}, all money is INTEGER cents, modeled
 * savings carries its assumption as data, the daemon computes the {@link rollups}, and the
 * per-user availability flag is `false` until verified backend claims land (060f gate, today
 * always false). The `scopedAcrossDevices` flag tells the page the figure aggregates across
 * devices (a `shared` read) vs only this machine (an `isolated` read), so the page can caption
 * the scope honestly (e-AC-12).
 */
export interface RoiView {
	/** The measured + modeled savings section (e-AC-3). */
	readonly savings: RoiSavingsSection;
	/** The infra cost section (e-AC-6, from 060c). */
	readonly infra: RoiInfraSection;
	/** The pollination cost section (e-AC-6, from 060d). */
	readonly pollination: RoiPollinationSection;
	/** The net-ROI section (e-AC-6) — computed ONLY from complete inputs, never fabricated. */
	readonly net: RoiNetSection;
	/** The org / team / agent / project rollups (e-AC-13), computed by the daemon as `GROUP BY`s. */
	readonly rollups: readonly RoiRollup[];
	/**
	 * The PER-USER availability flag (e-AC-14): `false` until verified backend user-claims are
	 * live (060f gate). It is `false` today — the page shows the "per-user requires verified
	 * login" empty state and NEVER a `$0` or a self-asserted name when this is false.
	 */
	readonly perUserAvailable: boolean;
	/**
	 * True when the read aggregated ACROSS DEVICES (a `shared` read_policy returned workspace-wide
	 * rows); false when it returned only this machine's rows (an `isolated` read). The page captions
	 * the scope honestly from this (e-AC-12). NOT a tenancy decision — the daemon already scoped the read.
	 */
	readonly scopedAcrossDevices: boolean;
	/** The rate-table "as of" stamp (060b) so a stale rate is auditable on the page. */
	readonly ratesAsOf: string;
}

/** One point in a trend series (e-AC-10): a period label + an INTEGER-cents value + its measured/modeled tag. */
export interface RoiTrendPoint {
	/** The period label (e.g. an ISO date / `YYYY-MM` bucket). */
	readonly period: string;
	/** The value at this period in INTEGER cents. */
	readonly cents: number;
}

/**
 * One trend SERIES (e-AC-10): a named line whose `modeled` tag drives the dashed (modeled) vs
 * solid (measured) stroke. Money is INTEGER cents at every point. The page renders these as an
 * inline-SVG chart (no charting dependency); this contract is purely the data the chart consumes.
 */
export interface RoiTrendSeries {
	/** The series label (e.g. `measured-savings`, `modeled-savings`, `infra-cost`, `net`). */
	readonly label: string;
	/** True ⇒ the chart draws a DASHED stroke (modeled / `est.`); false ⇒ SOLID (measured). */
	readonly modeled: boolean;
	/** The series points, oldest-first, in INTEGER cents. */
	readonly points: readonly RoiTrendPoint[];
}

/**
 * THE TREND VIEW-MODEL (e-AC-10) backing `GET /api/diagnostics/roi/trend`. `series` are the
 * measured-vs-modeled lines (dashed/solid). `status` carries the same {@link RoiSectionStatus}
 * vocabulary so an absent trend (no history before capture started) renders honestly rather
 * than a fabricated flat line; `startedAt` marks when savings tracking began (or `''` when none).
 */
export interface RoiTrendView {
	/** The overall trend status (e-AC-2 vocabulary): `absent` until a history exists. */
	readonly status: RoiSectionStatus;
	/** The measured/modeled series the inline-SVG chart draws (e-AC-10). */
	readonly series: readonly RoiTrendSeries[];
	/** When savings tracking began (ISO), or `''` when there is no history yet ("savings tracked from <date>"). */
	readonly startedAt: string;
}

/**
 * The honest-empty {@link RoiView} the page renders before the first load resolves, on any
 * failure, or on a genuine first-run/empty workspace (e-AC-5). Every section is `absent`
 * (the page shows a DASH glyph, NOT `$0.00`), the net is NOT computed, `blendedCentsPerMtok`
 * is `null`, `perUserAvailable` is `false`, and the rollups are empty. The daemon degrades to
 * THIS rather than throwing, and the wire degrades to it on a malformed/absent body.
 */
export const EMPTY_ROI_VIEW: RoiView = Object.freeze({
	savings: {
		status: "absent" as const,
		measuredCents: 0,
		modeledCents: 0,
		assumption: { kind: "", assumptionText: "", signedOff: false },
		blendedCentsPerMtok: null,
	},
	infra: { status: "absent" as const, cents: 0, costBasis: "none" as const },
	pollination: { status: "absent" as const, cents: 0, lines: [] },
	net: {
		status: "absent" as const,
		computed: false,
		netCents: 0,
		modeled: true,
		costBasis: "none" as const,
		partial: false,
		missingInputs: [],
	},
	rollups: [],
	perUserAvailable: false,
	scopedAcrossDevices: false,
	ratesAsOf: "",
});

/** The honest-empty {@link RoiTrendView} the page renders before first load / on failure / before capture (e-AC-10). */
export const EMPTY_ROI_TREND: RoiTrendView = Object.freeze({
	status: "absent" as const,
	series: [],
	startedAt: "",
});
