/**
 * The dashboard web app's WIRE LAYER — PRD-024 Wave 2 (AC-2..AC-6).
 *
 * The browser app is a THIN CLIENT: it hydrates entirely from the daemon's already-served
 * JSON endpoints (D-2, no canned `data.js`). This module is the single typed boundary
 * between the untyped `fetch` Response and the kit's React props:
 *
 *   - It declares a zod schema PER endpoint, mirroring the daemon-side view-model contracts
 *     in `src/dashboard/contracts.ts` (D-5 — reuse the shapes, do not re-derive them). The
 *     WIRE truth (what `src/daemon/runtime/dashboard/api.ts` + the recall/logs routes
 *     actually return) is what these schemas validate, NOT the canned `data.js` shapes.
 *   - It parses every payload through zod, so a malformed/partial response degrades to a
 *     safe empty/zero state rather than throwing into React (AC-2 empty states).
 *   - No `any` crosses the fetch boundary: each fetcher returns a typed, validated value.
 *
 * Wire endpoints (all loopback, all already served — this app NEVER rebuilds them):
 *   GET  /api/diagnostics/kpis|sessions|settings|rules|skills   → the dashboard view-models
 *   GET  /api/graph                                             → the codebase graph view
 *   POST /api/memories/recall                                   → recall hits
 *   GET  /api/logs                                              → the request-log ring buffer
 *   GET  /health                                                → daemon liveness
 *   POST /api/diagnostics/dream                                 → the Wave-1 Dream trigger
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint paths (single source — the host serves these under the daemon origin).
// ─────────────────────────────────────────────────────────────────────────────

/** The diagnostics view-model endpoints (served under `/api/diagnostics/*` + `/api/graph`). */
export const ENDPOINTS = Object.freeze({
	kpis: "/api/diagnostics/kpis",
	sessions: "/api/diagnostics/sessions",
	settings: "/api/diagnostics/settings",
	rules: "/api/diagnostics/rules",
	skills: "/api/diagnostics/skills",
	graph: "/api/graph",
	// PRD-041b — the memory-graph view-model (the knowledge graph of memories/entities). Served off
	// the diagnostics group (`/api/diagnostics/memory-graph`), mirroring `/api/graph`. Returns the SAME
	// `GraphView` shape so the existing `GraphCanvas` renders it unchanged; `built:false` until PRD-008
	// data is populated (the page shows its honest "no memory graph yet" empty state).
	memoryGraph: "/api/diagnostics/memory-graph",
	recall: "/api/memories/recall",
	// PRD-040 — the memory-management surface. `memories` is BOTH the list (GET /api/memories)
	// and the store (POST /api/memories) endpoint; `getMemory`/`modify`/`forget` are built by
	// appending `/:id`[`/modify`|`/forget`] to it. `compact` is the version-history reaper trigger.
	memories: "/api/memories",
	compact: "/api/diagnostics/compact",
	logs: "/api/logs",
	// PRD-039a — the harness registry + last-seen telemetry endpoint (the data backbone the
	// Harnesses page 039b/039c reads). Served under the diagnostics group (`/api/diagnostics/harnesses`).
	harnesses: "/api/diagnostics/harnesses",
	health: "/health",
	dream: "/api/diagnostics/dream",
	// PRD-032c — the vault `setting`-class surface (Wave 1 `vault/api.ts`) + the names-only
	// secrets surface (PRD-012a `secrets/api.ts`, used ONLY for presence, never a value).
	vaultSettings: "/api/settings",
	secrets: "/api/secrets",
} as const);

/** PRD-040a — the default first-page size the Memories list requests (the daemon clamps to 500). */
export const DEFAULT_MEMORY_LIST_LIMIT = 50 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas — mirror `src/dashboard/contracts.ts` (D-5) over the WIRE truth.
// Every field defaults so a partial payload degrades to a safe empty/zero state.
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/diagnostics/kpis` → {@link import("../contracts.js").KpisView}. */
export const KpisSchema = z.object({
	memoryCount: z.number().catch(0),
	sessionCount: z.number().catch(0),
	// PRD-035a: the honest "Turns" count (same value as `sessionCount`). `.catch(0)` tolerance so an
	// OLD daemon payload that carries only `sessionCount` degrades safely (the app falls back to it).
	turnCount: z.number().catch(0),
	estimatedSavings: z.number().catch(0),
	// PRD-036c: the team-shared skill count the "Team skills" KPI binds to. `.catch(0)` so an older
	// payload without it reads 0 rather than throwing into React.
	teamSkillCount: z.number().catch(0),
});
export type KpisWire = z.infer<typeof KpisSchema>;

/** One row of `GET /api/diagnostics/sessions` → {@link import("../contracts.js").SessionRow}. */
export const SessionRowSchema = z.object({
	sessionId: z.string().catch(""),
	project: z.string().catch(""),
	startedAt: z.string().catch(""),
	eventCount: z.number().catch(0),
	status: z.string().catch("captured"),
});
export const SessionsSchema = z.object({
	sessions: z.array(SessionRowSchema).catch([]),
});
export type SessionRowWire = z.infer<typeof SessionRowSchema>;

/** `GET /api/diagnostics/settings` → {@link import("../contracts.js").SettingsView}. */
export const SettingsSchema = z.object({
	orgId: z.string().catch(""),
	orgName: z.string().catch(""),
	workspace: z.string().catch(""),
	settings: z.record(z.string(), z.string()).catch({}),
});
export type SettingsWire = z.infer<typeof SettingsSchema>;

/** A graph node/edge → {@link import("../contracts.js").GraphNode} / `GraphEdge`. */
export const GraphNodeSchema = z.object({
	id: z.string().catch(""),
	label: z.string().catch(""),
	kind: z.string().catch(""),
});
export const GraphEdgeSchema = z.object({
	from: z.string().catch(""),
	to: z.string().catch(""),
	kind: z.string().catch(""),
});
export const GraphSchema = z.object({
	built: z.boolean().catch(false),
	nodes: z.array(GraphNodeSchema).catch([]),
	edges: z.array(GraphEdgeSchema).catch([]),
});
export type GraphWire = z.infer<typeof GraphSchema>;

/** One rule of `GET /api/diagnostics/rules` → {@link import("../contracts.js").RuleRow}. */
export const RuleRowSchema = z.object({
	id: z.string().catch(""),
	title: z.string().catch(""),
	active: z.boolean().catch(false),
});
export const RulesSchema = z.object({
	rules: z.array(RuleRowSchema).catch([]),
});
export type RuleRowWire = z.infer<typeof RuleRowSchema>;

/** One skill of `GET /api/diagnostics/skills` → {@link import("../contracts.js").SkillSyncRow}. */
export const SkillRowSchema = z.object({
	name: z.string().catch(""),
	scope: z.string().catch(""),
	syncState: z.string().catch("pending"),
});
export const SkillsSchema = z.object({
	skills: z.array(SkillRowSchema).catch([]),
});
export type SkillRowWire = z.infer<typeof SkillRowSchema>;

/**
 * One recall hit on the wire — the `/api/memories/recall` response shape from
 * `src/daemon/runtime/memories/recall.ts`. PRD-027 Wave 1 made the hit carry a REAL
 * `{ source, id, text, score, kind, secondary }`: `score` is the fused RRF relevance
 * (the engine already emits hits ranked DESC by it), `kind` is the provenance class
 * (`"memory"` distilled vs `"session"` raw dump), and `secondary` is `true` iff the hit
 * is a drill-down raw session row. The client renders the ENGINE score + ENGINE order —
 * it NEVER fabricates a score (D-4 / AC-4 removed the old `1 - i*0.06` synthesis).
 *
 * The score/kind/secondary fields `.catch()` to safe defaults so an OLDER daemon that
 * predates Wave 1 (no score on the wire) still renders (degrade gracefully). The LIVE
 * daemon now always sends them. The kit's `MemoryCard` wants
 * `{ memoryKey, snippet, source, score, scope, verified }`; we MAP the wire hit to those
 * props in {@link recall} (id→memoryKey, text→snippet, ENGINE `score`→score, the arm name→
 * scope hint, `kind`/`secondary`→the distilled-vs-drill-down demotion).
 */
export const RecallHitSchema = z.object({
	source: z.string().catch(""),
	id: z.string().catch(""),
	text: z.string().catch(""),
	// PRD-027 Wave 1 (AC-4): the ENGINE's fused relevance + provenance. `.catch()` defaults
	// keep an older daemon (pre-score) renderable — a missing score degrades to 0, not a throw.
	score: z.number().catch(0),
	kind: z.enum(["memory", "session"]).catch("memory"),
	secondary: z.boolean().catch(false),
});
export const RecallResponseSchema = z.object({
	hits: z.array(RecallHitSchema).catch([]),
	sources: z.array(z.string()).catch([]),
	degraded: z.boolean().catch(true),
});

/** A rendered recalled memory (the shape the `MemoryCard` consumes). */
export interface RecalledMemory {
	readonly memoryKey: string;
	readonly snippet: string;
	readonly source: string;
	/** The ENGINE's fused RRF relevance score (NOT a client fabrication — PRD-027 AC-4). */
	readonly score: number;
	readonly scope: string;
	readonly verified: boolean;
	/** Provenance class from the engine: distilled `"memory"` vs raw-dump `"session"`. */
	readonly kind: "memory" | "session";
	/** `true` iff a drill-down raw session row (the card visually demotes these). */
	readonly secondary: boolean;
}

/**
 * PRD-040 — one memory row on the wire. MIRRORS the daemon read-model
 * `src/daemon/runtime/memories/reads.ts` `MemoryRecord` (the original thin shape PLUS the
 * OQ-1 additive detail metadata). Every field `.catch()`-defaults so a partial/older payload —
 * a daemon serving only the thin `{ id, type, content, confidence, agentId, createdAt,
 * updatedAt }`, or a malformed body — degrades to a safe value rather than throwing into React.
 * The five OQ-1 fields (`visibility`/`sourceType`/`sourceId`/`version`/`hasEmbedding`) are
 * `.catch()`-defaulted EXACTLY so an older/thin daemon still renders the detail view (with those
 * fields blank/false). No secret rides this shape — scope tag, provenance, a version, a boolean.
 */
export const MemoryRecordSchema = z.object({
	id: z.string().catch(""),
	type: z.string().catch(""),
	content: z.string().catch(""),
	confidence: z.number().catch(0),
	agentId: z.string().catch(""),
	createdAt: z.string().catch(""),
	updatedAt: z.string().catch(""),
	// OQ-1 additive metadata — `.catch()`-defaulted so the thin shape still parses.
	visibility: z.string().catch(""),
	sourceType: z.string().catch(""),
	sourceId: z.string().catch(""),
	version: z.number().catch(0),
	hasEmbedding: z.boolean().catch(false),
});
export type MemoryRecordWire = z.infer<typeof MemoryRecordSchema>;

/** `GET /api/memories` body: `{ memories: MemoryRecord[] }`. A bad shape degrades to `[]`. */
export const MemoryListResponseSchema = z.object({
	memories: z.array(MemoryRecordSchema).catch([]),
});

/** `GET /api/memories/:id` body: `{ memory: MemoryRecord }`. A 404 is handled at the call site (→ null). */
export const MemoryGetResponseSchema = z.object({
	memory: MemoryRecordSchema,
});

/** `POST /api/memories` (store) ack: `{ id, action }` (201). `id` is null when the daemon dedup-skips. */
export const StoreAckSchema = z.object({
	id: z.string().nullable().catch(null),
	action: z.string().catch(""),
});
export type StoreAckWire = z.infer<typeof StoreAckSchema>;

/** `POST /api/memories/:id/modify` + `/forget` ack: `{ id, action, audited }`. */
export const WriteAckSchema = z.object({
	id: z.string().nullable().catch(null),
	action: z.string().catch(""),
	audited: z.boolean().catch(false),
});
export type WriteAckWire = z.infer<typeof WriteAckSchema>;

/**
 * PRD-040c — one per-table compaction summary on the wire, MIRRORING the daemon
 * `CompactTableResult` (`src/daemon/runtime/maintenance/compact-api.ts`): the table name + the
 * reap counts + an `errored` count (>0 ⇒ "attempted, not completed"). Every field `.catch()`es
 * so a partial body still renders. No secret — table names + integer counts only.
 */
export const CompactTableResultSchema = z.object({
	table: z.string().catch(""),
	keysScanned: z.number().catch(0),
	keysCompacted: z.number().catch(0),
	rowsReaped: z.number().catch(0),
	keysSkipped: z.number().catch(0),
	errored: z.number().catch(0),
});
export type CompactTableResultWire = z.infer<typeof CompactTableResultSchema>;

/** `POST /api/diagnostics/compact` body: `{ ok, summaries, skippedTables }`. Degrades to an empty summary. */
export const CompactSummarySchema = z.object({
	ok: z.boolean().catch(false),
	summaries: z.array(CompactTableResultSchema).catch([]),
	skippedTables: z.array(z.string()).catch([]),
});
export type CompactSummaryWire = z.infer<typeof CompactSummarySchema>;

/** One `/api/logs` record (the `RequestLogRecord` the ring buffer serves; no secret in it). */
export const LogRecordSchema = z.object({
	time: z.string().catch(""),
	method: z.string().catch(""),
	path: z.string().catch(""),
	status: z.number().catch(0),
	durationMs: z.number().optional(),
	mode: z.string().optional(),
	org: z.string().optional(),
	workspace: z.string().optional(),
});
export const LogsResponseSchema = z.object({
	records: z.array(LogRecordSchema).catch([]),
	count: z.number().catch(0),
});
export type LogRecordWire = z.infer<typeof LogRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-039 — the harness registry + last-seen telemetry (the data backbone). Mirrors
// `src/daemon/runtime/dashboard/harness-api.ts` (`HarnessStatus`) + the folded 039c
// capability descriptor. Every field defaults so a partial/malformed payload degrades
// to a safe zeroed state, NEVER a throw into React (AC-8 defensive parsing). NO secret
// rides this shape by construction — ids, booleans, a count, an ISO timestamp, statics.
// ─────────────────────────────────────────────────────────────────────────────

/** Cursor's `cursor-agent` agents descriptor (039c) — present for Cursor, absent for Claude Code. */
export const HarnessAgentsSchema = z.object({
	kind: z.string().catch(""),
	binary: z.string().catch(""),
	fallbackBin: z.string().optional(),
});

/** One harness's host-CLI descriptor (mirrors the shim `HostCli`). */
export const HarnessHostCliSchema = z.object({
	bin: z.string().catch(""),
	args: z.array(z.string()).catch([]),
	fallbackBin: z.string().optional(),
});

/**
 * The data-driven capability descriptor folded into each `HarnessStatus` server-side (039c / c-OQ-2).
 * The OPTIONAL fields are the genuine shim divergences — a missing field omits that harness's panel
 * on the detail page (c-AC-3), never a blank. Each field `.catch()`es so a partial body still renders.
 */
export const HarnessCapabilitiesSchema = z.object({
	name: z.string().catch(""),
	runtimePath: z.string().catch(""),
	contextChannel: z.string().catch(""),
	hostCli: HarnessHostCliSchema.catch({ bin: "", args: [] }),
	lifecycleEvents: z.array(z.string()).catch([]),
	agents: HarnessAgentsSchema.optional(),
	workspaceRoots: z.boolean().optional(),
	mcpRegistration: z.boolean().optional(),
	contractedTools: z.boolean().optional(),
	agentsMdContext: z.boolean().optional(),
	userVisibleLogin: z.boolean().optional(),
});
export type HarnessCapabilitiesWire = z.infer<typeof HarnessCapabilitiesSchema>;

/** One harness's status row (mirrors the daemon `HarnessStatus`). `lastSeen` is null when never seen. */
export const HarnessStatusSchema = z.object({
	name: z.string().catch(""),
	installed: z.boolean().catch(false),
	active: z.boolean().catch(false),
	lastSeen: z.string().nullable().catch(null),
	turnsCaptured: z.number().catch(0),
	runtimePath: z.string().catch(""),
	capabilities: HarnessCapabilitiesSchema.catch({
		name: "",
		runtimePath: "",
		contextChannel: "",
		hostCli: { bin: "", args: [] },
		lifecycleEvents: [],
	}),
});
export const HarnessStatusResponseSchema = z.object({
	harnesses: z.array(HarnessStatusSchema).catch([]),
});
export type HarnessStatusWire = z.infer<typeof HarnessStatusSchema>;

/** The Wave-1 Dream ack (`POST /api/diagnostics/dream` → 202 + this body). */
export const DreamAckSchema = z.object({
	triggered: z.boolean().catch(false),
	status: z.string().catch("skipped"),
	reason: z.string().optional(),
});
export type DreamAck = z.infer<typeof DreamAckSchema>;

/**
 * The PRD-029 per-subsystem `/health` `reasons` block (D-2 render). This MIRRORS the
 * Wave-1 daemon contract `HealthReasons` in `src/daemon/runtime/health.ts` verbatim — a
 * closed enum per subsystem, NO secret (D-5: no token/org/endpoint/header rides these,
 * only subsystem names + coarse states). The dashboard is LOCAL-mode so the daemon's
 * `/health` body carries this block; on a non-local public body it is absent (the strip
 * renders nothing — handled at the call site by a `null` reasons).
 *
 * Each field `.catch()`es to its HEALTHY value so a malformed/partial `reasons` degrades
 * to "looks ok" rather than throwing into React — the body crosses the untyped IO boundary
 * exactly like every other endpoint here. An UNKNOWN enum value (a future daemon adds a
 * state) also `.catch()`es to the healthy default, never a throw.
 */
export const HealthReasonsSchema = z.object({
	storage: z.enum(["reachable", "unreachable"]).catch("reachable"),
	embeddings: z.enum(["on", "off"]).catch("on"),
	schema: z.enum(["ok", "missing_table"]).catch("ok"),
});
export type HealthReasonsWire = z.infer<typeof HealthReasonsSchema>;

/**
 * The `/health` body the daemon serves (the coarse bit + the additive PRD-029 `reasons`).
 * `reasons` is OPTIONAL — absent on the mode-gated public team/hybrid body, present in
 * local (which the dashboard always is). The whole body `.catch()`es a bad shape so a
 * malformed `/health` degrades to "no reasons" (coarse pill only), never a throw.
 *
 * NOTE the coarse liveness the app's view-swap keys off (`daemonUp`) comes from the HTTP
 * `res.ok` (a 503-on-degraded still parses a body), NOT from this `status` field — so the
 * reasons are purely ADDITIVE render data and never change the existing up/down behaviour.
 */
export const HealthBodySchema = z.object({
	status: z.string().catch("ok"),
	reasons: HealthReasonsSchema.optional(),
});

/** The result of a `/health` probe: coarse liveness + the parsed per-subsystem reasons (or null). */
export interface HealthProbe {
	/** Daemon liveness — `true` iff the HTTP response was ok (drives the view-swap, unchanged). */
	readonly up: boolean;
	/** The per-subsystem reasons (PRD-029), or `null` when the body omits/malforms them. */
	readonly reasons: HealthReasonsWire | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-032c — the vault `setting`-class surface (`GET`/`POST /api/settings`) + the
// curated provider→model catalog. Every field defaults so a partial/malformed payload
// degrades to a safe empty state, NEVER a throw into React (AC-5 defensive parsing).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One provider entry in the catalog `GET /api/settings` returns — MIRRORS the Wave-1
 * `ProviderEntry` in `src/daemon/runtime/vault/catalog.ts` (D-6). `models` is the curated,
 * ordered model list (`models[0]` is the selector default); `openEnded` marks OpenRouter,
 * whose model id is a free-form passthrough (the panel renders a text input for it).
 */
export const ProviderEntrySchema = z.object({
	id: z.string().catch(""),
	label: z.string().catch(""),
	models: z.array(z.string()).catch([]),
	openEnded: z.boolean().catch(false),
});
export type ProviderEntryWire = z.infer<typeof ProviderEntrySchema>;

/**
 * A single `setting` value on the wire — the vault `setting` class stores a JSON SCALAR
 * (string | number | boolean), so the panel renders exactly those. A non-scalar (a future
 * structured setting) would register its own class; here a bad value `.catch()`es to a
 * harmless empty string so the panel never throws.
 */
export const SettingValueWireSchema = z.union([z.string(), z.number(), z.boolean()]).catch("");
export type SettingValueWire = z.infer<typeof SettingValueWireSchema>;

/**
 * The `GET /api/settings` body the Wave-1 daemon serves: `{ settings, catalog }`. `settings`
 * is the current key→value map of the `setting` class (the active provider/model + the
 * dreaming toggle + dashboard prefs); `catalog` is the static provider→model list. NO secret
 * is in this body by construction (the surface reads only the `setting` class). Each field
 * `.catch()`es to an empty default so a partial body degrades to "nothing selected".
 */
export const VaultSettingsSchema = z.object({
	settings: z.record(z.string(), SettingValueWireSchema).catch({}),
	catalog: z.array(ProviderEntrySchema).catch([]),
});
export type VaultSettingsWire = z.infer<typeof VaultSettingsSchema>;

/**
 * The `GET /api/secrets` body (PRD-012a, names-only) — `{ names: string[] }`. The panel reads
 * this ONLY to show a provider key's PRESENCE ("set ✓" / "not set") by name; there is NO
 * value-returning route and the panel never asks for one (AC-5 / D-4). A malformed body
 * `.catch()`es to an empty name list (every provider reads as "not set", never a throw).
 */
export const SecretNamesSchema = z.object({
	names: z.array(z.string()).catch([]),
});
export type SecretNamesWire = z.infer<typeof SecretNamesSchema>;

/** The empty vault-settings view the panel shows before the first load (or on failure). */
export const EMPTY_VAULT_SETTINGS: VaultSettingsWire = Object.freeze({ settings: {}, catalog: [] });

// ─────────────────────────────────────────────────────────────────────────────
// The typed fetch client. Every method validates its payload through zod, so the
// React tree never sees an untyped/garbage value (AC-2 empty states are free).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The non-tenant SESSION headers every dashboard request stamps (PRD-024 Wave 3).
 *
 * The `/api/memories` group sits behind the runtime-path + session middleware
 * (`src/daemon/runtime/middleware/runtime-path.ts`), which REQUIRES
 * `x-honeycomb-runtime-path: plugin|legacy` AND a non-empty `x-honeycomb-session`. The
 * dashboard web app is a legitimate loopback thin client — exactly like the CLI/SDK/MCP, which
 * stamp these — so it must send them too. They carry NO tenant identity (no org GUID) and NO
 * credential (D-4), so they are safe to stamp client-side; the org comes from the daemon's
 * LOCAL default scope (the daemon-side Fix A). We deliberately do NOT send `x-honeycomb-org`:
 * sending a wrong/empty org would trip the cross-tenant guard.
 *
 * The session id is a FIXED, clearly-labeled loopback viewer id ("dashboard-web"): a single
 * long-lived viewer that idempotently re-claims its OWN session (the claim map is per-session),
 * never conflicting with a harness which uses real session ids. A fixed id keeps the bundle
 * deterministic and the contract testable (no `Math.random`/`Date.now`).
 */
export const DASHBOARD_SESSION_HEADERS = Object.freeze({
	"x-honeycomb-runtime-path": "plugin",
	"x-honeycomb-session": "dashboard-web",
} as const);

/** The injectable fetch surface (the global in prod; a mock in unit tests). */
export type FetchLike = typeof fetch;

/** Construction options for {@link createWireClient}. */
export interface WireClientOptions {
	/** The daemon origin the app talks to (defaults to same-origin, i.e. empty prefix). */
	readonly origin?: string;
	/** The fetch implementation (defaults to the global `fetch`). */
	readonly fetchImpl?: FetchLike;
}

/** GET + zod-parse a JSON endpoint, returning the parsed value or `null` on any failure. */
async function getJson<T>(
	fetchImpl: FetchLike,
	url: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		const res = await fetchImpl(url, { headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS } });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		const parsed = schema.safeParse(body);
		return parsed.success ? parsed.data : null;
	} catch {
		// A network error / abort / non-JSON body → null; the caller renders the empty state.
		return null;
	}
}

/**
 * POST a JSON body + zod-parse the response, returning the parsed value or `null` on any non-2xx /
 * network / parse failure. The single shared writer for the PRD-040 mutations (add/modify/forget/
 * compact) so the four call sites do not duplicate the fetch+guard boilerplate (jscpd discipline).
 * Every request stamps the session headers; no `any` crosses the boundary (the body is `unknown`).
 */
async function postJson<T>(
	fetchImpl: FetchLike,
	url: string,
	body: unknown,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const parsed = schema.safeParse(await res.json());
		return parsed.success ? parsed.data : null;
	} catch {
		// A network error / abort / non-JSON body → null; the caller surfaces "save failed" + re-reads.
		return null;
	}
}

/** The arm name → a human scope hint for a recalled memory (honest, derived from the wire). */
function scopeForSource(source: string): string {
	if (source === "memories") return "team";
	if (source === "memory") return "org";
	return "session";
}

/**
 * The dashboard web client. Each method hits one already-served endpoint, validates the
 * payload with zod, and returns a typed value (or a safe empty/zero state). The whole
 * surface is loopback `fetch` — no DeepLake, no secret, no token (D-4): the app reads only
 * what the daemon chooses to serve.
 */
export interface WireClient {
	kpis(): Promise<KpisWire>;
	sessions(): Promise<SessionRowWire[]>;
	settings(): Promise<SettingsWire>;
	rules(): Promise<RuleRowWire[]>;
	skills(): Promise<SkillRowWire[]>;
	graph(): Promise<GraphWire>;
	/**
	 * PRD-041b — read the MEMORY-GRAPH view-model (`GET /api/diagnostics/memory-graph`). Returns the
	 * SAME `GraphWire` shape as {@link graph} (the memory graph is a `GraphView`-shaped source), so the
	 * page feeds it to the SAME `GraphCanvas`. A malformed/absent body — or a `built:false` empty graph
	 * while PRD-008 data is unpopulated — degrades to {@link EMPTY_GRAPH} so the page renders its honest
	 * "no memory graph yet" empty state, never a throw. Validated through the shared `GraphSchema`.
	 */
	memoryGraph(): Promise<GraphWire>;
	recall(query: string): Promise<{ memories: RecalledMemory[]; degraded: boolean }>;
	/**
	 * PRD-040a — list the scoped tenant's memories (`GET /api/memories`, newest-first). `limit`
	 * bumps for "load more" (the daemon clamps to `MAX_LIST_LIMIT` 500). A malformed/absent body
	 * degrades to `[]` (the page renders its honest empty state). Stamps the session headers.
	 */
	listMemories(limit?: number): Promise<MemoryRecordWire[]>;
	/**
	 * PRD-040a — read one memory by id (`GET /api/memories/:id`). Returns `null` on a 404 (the id is
	 * unknown OR forgotten → the page renders "this memory was forgotten") or any failure.
	 */
	getMemory(id: string): Promise<MemoryRecordWire | null>;
	/**
	 * PRD-040b — add a memory (`POST /api/memories`, store). Returns the `{ id, action }` ack, or
	 * `null` on a non-2xx / network failure (the caller surfaces "save failed" and re-reads). The
	 * page never optimistically renders the input — it re-lists after the ack.
	 */
	addMemory(input: { content: string; type?: string; agentId?: string }): Promise<StoreAckWire | null>;
	/**
	 * PRD-040b — edit a memory (`POST /api/memories/:id/modify`, version-bumped + reason-gated).
	 * The `reason` is REQUIRED (the daemon rejects an empty one). Returns the `{ id, action,
	 * audited }` ack, or `null` on a non-2xx / network failure (the caller re-reads the unchanged
	 * persisted value). NEVER a hard-update — the daemon appends a new version.
	 */
	modifyMemory(id: string, input: { content: string; reason: string; agentId?: string }): Promise<WriteAckWire | null>;
	/**
	 * PRD-040b — forget a memory (`POST /api/memories/:id/forget`, reason-gated soft-delete → a
	 * tombstone version). Returns the ack, or `null` on failure. The page gates this behind a confirm.
	 */
	forgetMemory(id: string, input: { reason: string }): Promise<WriteAckWire | null>;
	/**
	 * PRD-040c — trigger version-history compaction (`POST /api/diagnostics/compact`). The optional
	 * `table` selects ONE allow-listed table (omitted ⇒ all). Returns the per-table summary, or
	 * `null` on failure ("compaction unavailable"). The page sends only a KNOWN table name or none —
	 * the daemon matches it against the allow-list, so no attacker-controlled identifier rides this.
	 */
	compact(table?: string): Promise<CompactSummaryWire | null>;
	logs(limit?: number): Promise<LogRecordWire[]>;
	/**
	 * PRD-039a — read the harness registry + last-seen telemetry (the data backbone). Returns the
	 * six canonical `HarnessStatus` rows the Harnesses page (039b/039c) renders; a failure degrades
	 * to an empty list (the page shows its honest empty/zero state, never a throw). No second source —
	 * this is the SINGLE backbone (parent D-3).
	 */
	harnesses(): Promise<HarnessStatusWire[]>;
	health(): Promise<HealthProbe>;
	dream(): Promise<DreamAck>;
	/** PRD-032c — read the vault `setting` class + the provider→model catalog (`GET /api/settings`). */
	vaultSettings(): Promise<VaultSettingsWire>;
	/**
	 * PRD-032c — write one `setting`-class record through the daemon (`POST /api/settings/:key`).
	 * Returns `true` iff the daemon accepted the write (2xx); the caller re-reads to reflect the
	 * PERSISTED value (it never trusts a local-only toggle). The panel NEVER opens the vault
	 * directly — every write goes through this loopback endpoint (PRD-020b posture).
	 */
	setSetting(key: string, value: SettingValueWire): Promise<boolean>;
	/**
	 * PRD-032c — read the names-only secret list (`GET /api/secrets`) for provider-key PRESENCE
	 * ("set ✓" / "not set") ONLY. There is no value-returning route; this returns NAMES, never a
	 * value (D-4 / AC-5).
	 */
	secretNames(): Promise<string[]>;
}

/** The empty/zero KPIs the UI shows before the first load resolves (or on failure). */
export const EMPTY_KPIS: KpisWire = { memoryCount: 0, sessionCount: 0, turnCount: 0, estimatedSavings: 0, teamSkillCount: 0 };

/** The empty settings the header shows before the first load resolves. */
export const EMPTY_SETTINGS: SettingsWire = { orgId: "", orgName: "", workspace: "", settings: {} };

/** The empty graph (renders the kit's "no graph built" empty-state). */
export const EMPTY_GRAPH: GraphWire = { built: false, nodes: [], edges: [] };

/**
 * Build the typed wire client (AC-2..AC-6). The `origin` is prefixed onto every path so the
 * same app works same-origin (served by the host) or against an explicit daemon URL; the
 * `fetchImpl` is injected so a unit test drives the app with a mocked fetch and no live
 * network (the test contract). No method ever throws — every failure degrades to an empty
 * value so the UI shows an honest empty state instead of crashing.
 */
export function createWireClient(options: WireClientOptions = {}): WireClient {
	const origin = options.origin ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = (path: string): string => `${origin}${path}`;

	return {
		async kpis(): Promise<KpisWire> {
			return (await getJson(fetchImpl, url(ENDPOINTS.kpis), KpisSchema)) ?? EMPTY_KPIS;
		},
		async sessions(): Promise<SessionRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.sessions), SessionsSchema);
			return v?.sessions ?? [];
		},
		async settings(): Promise<SettingsWire> {
			return (await getJson(fetchImpl, url(ENDPOINTS.settings), SettingsSchema)) ?? EMPTY_SETTINGS;
		},
		async rules(): Promise<RuleRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.rules), RulesSchema);
			return v?.rules ?? [];
		},
		async skills(): Promise<SkillRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.skills), SkillsSchema);
			return v?.skills ?? [];
		},
		async graph(): Promise<GraphWire> {
			return (await getJson(fetchImpl, url(ENDPOINTS.graph), GraphSchema)) ?? EMPTY_GRAPH;
		},
		async memoryGraph(): Promise<GraphWire> {
			// Same shape as the codebase graph (a `GraphView`-shaped source) — validated through the
			// shared GraphSchema. A failure / `built:false` empty graph degrades to EMPTY_GRAPH so the
			// page renders the honest "no memory graph yet" state (never a throw).
			return (await getJson(fetchImpl, url(ENDPOINTS.memoryGraph), GraphSchema)) ?? EMPTY_GRAPH;
		},
		async recall(query: string): Promise<{ memories: RecalledMemory[]; degraded: boolean }> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.recall), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					body: JSON.stringify({ query }),
				});
				if (!res.ok) return { memories: [], degraded: true };
				const parsed = RecallResponseSchema.safeParse(await res.json());
				if (!parsed.success) return { memories: [], degraded: true };
				// The engine already returns hits RANKED DESC by the fused RRF score (distilled
				// `[memory]` facts above raw `[sessions]` drill-downs). We render them in THAT
				// order verbatim — NO client-side re-sort — and carry the ENGINE `score` through
				// (PRD-027 AC-4 deleted the old `1 - i*0.06` fabrication). `kind`/`secondary` ride
				// along so the card can demote raw session rows. `scope`/`verified` stay derived
				// honestly from the arm name.
				const memories = parsed.data.hits.map((h, i) => ({
					memoryKey: h.id !== "" ? h.id : `hit-${i + 1}`,
					snippet: h.text,
					source: h.source,
					score: h.score,
					scope: scopeForSource(h.source),
					verified: h.source === "memories",
					kind: h.kind,
					secondary: h.secondary,
				}));
				return { memories, degraded: parsed.data.degraded };
			} catch {
				return { memories: [], degraded: true };
			}
		},
		async listMemories(limit = DEFAULT_MEMORY_LIST_LIMIT): Promise<MemoryRecordWire[]> {
			// GET the scoped tenant's memories (newest-first); a malformed/absent body degrades to []
			// so the page renders its honest empty state. The daemon clamps `limit` to MAX_LIST_LIMIT.
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.memories}?limit=${limit}`), MemoryListResponseSchema);
			return v?.memories ?? [];
		},
		async getMemory(id: string): Promise<MemoryRecordWire | null> {
			// A 404 (unknown OR forgotten id) → null via getJson's non-ok guard; the page renders the
			// honest "forgotten" state. The id is path-encoded so it is one safe segment.
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}`), MemoryGetResponseSchema);
			return v?.memory ?? null;
		},
		async addMemory(input: { content: string; type?: string; agentId?: string }): Promise<StoreAckWire | null> {
			// POST the store body (content + optional type/agent); the daemon's zod is the source of
			// truth (a 400 → null here, surfaced as "save failed"). The caller re-LISTS after a 201.
			const body: Record<string, string> = { content: input.content };
			if (input.type !== undefined) body.type = input.type;
			if (input.agentId !== undefined) body.agentId = input.agentId;
			return postJson(fetchImpl, url(ENDPOINTS.memories), body, StoreAckSchema);
		},
		async modifyMemory(id: string, input: { content: string; reason: string; agentId?: string }): Promise<WriteAckWire | null> {
			// POST content + the REQUIRED reason → a version-bumped, audited edit (never a hard-update).
			// A non-2xx (e.g. an empty reason the client should have caught) → null; the caller re-reads.
			const body: Record<string, string> = { content: input.content, reason: input.reason };
			if (input.agentId !== undefined) body.agentId = input.agentId;
			return postJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}/modify`), body, WriteAckSchema);
		},
		async forgetMemory(id: string, input: { reason: string }): Promise<WriteAckWire | null> {
			// POST the required reason → a reason-gated soft-delete (a tombstone version). null on failure.
			return postJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}/forget`), { reason: input.reason }, WriteAckSchema);
		},
		async compact(table?: string): Promise<CompactSummaryWire | null> {
			// POST the optional `{ table }` selector (omitted ⇒ all allow-listed tables). The daemon
			// matches it against its allow-list, so the page sends only a known name — no attacker SQL.
			const body = table !== undefined && table !== "" ? { table } : {};
			return postJson(fetchImpl, url(ENDPOINTS.compact), body, CompactSummarySchema);
		},
		async logs(limit = 40): Promise<LogRecordWire[]> {
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.logs}?limit=${limit}`), LogsResponseSchema);
			return v?.records ?? [];
		},
		async harnesses(): Promise<HarnessStatusWire[]> {
			// GET the six canonical harness statuses; a malformed/absent body degrades to the empty
			// list so the page renders its honest empty/zero state (never a throw). Single backbone (D-3).
			const v = await getJson(fetchImpl, url(ENDPOINTS.harnesses), HarnessStatusResponseSchema);
			return v?.harnesses ?? [];
		},
		async health(): Promise<HealthProbe> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.health), { headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS } });
				// Liveness is the HTTP status (a 503-on-degraded still has a parseable body);
				// the existing view-swap keys off this `up` flag, unchanged (PRD-029 is additive).
				const up = res.ok;
				// Parse the body for the additive PRD-029 `reasons`. Every failure mode — a
				// non-JSON body (the bare "" the 503 path and some 200s send), a malformed shape,
				// an absent `reasons` (the mode-gated public body) — degrades to `null` reasons
				// (coarse pill only), NEVER a throw. The IO boundary is fully defended.
				let reasons: HealthReasonsWire | null = null;
				try {
					const body: unknown = await res.json();
					const parsed = HealthBodySchema.safeParse(body);
					reasons = parsed.success ? parsed.data.reasons ?? null : null;
				} catch {
					reasons = null;
				}
				return { up, reasons };
			} catch {
				return { up: false, reasons: null };
			}
		},
		async dream(): Promise<DreamAck> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.dream), { method: "POST", headers: { ...DASHBOARD_SESSION_HEADERS } });
				const parsed = DreamAckSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : { triggered: false, status: "skipped", reason: "unavailable" };
			} catch {
				return { triggered: false, status: "skipped", reason: "unavailable" };
			}
		},
		async vaultSettings(): Promise<VaultSettingsWire> {
			// GET the `setting` class + catalog; a malformed/absent body degrades to the empty
			// view (nothing selected, no catalog) so the panel renders its empty state, never throws.
			return (await getJson(fetchImpl, url(ENDPOINTS.vaultSettings), VaultSettingsSchema)) ?? EMPTY_VAULT_SETTINGS;
		},
		async setSetting(key: string, value: SettingValueWire): Promise<boolean> {
			try {
				// POST /api/settings/:key with a JSON `{ value }` body — the Wave-1 handler's shape.
				// The key is path-encoded so a `dashboard.*` dotted key (or any caller key) is a safe
				// single path segment. The panel only ever sends its own known keys.
				const res = await fetchImpl(url(`${ENDPOINTS.vaultSettings}/${encodeURIComponent(key)}`), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					body: JSON.stringify({ value }),
				});
				// The daemon answers 201 on a successful write; any non-2xx (400 invalid value,
				// 502 store failure) reads as "not accepted" so the caller does not optimistically
				// reflect an un-persisted change — it re-reads and shows whatever actually persisted.
				return res.ok;
			} catch {
				return false;
			}
		},
		async secretNames(): Promise<string[]> {
			// Names-only (D-4): the panel uses this purely for provider-key PRESENCE. A failure
			// degrades to an empty list → every provider shows "not set" (never a throw, never a value).
			const v = await getJson(fetchImpl, url(ENDPOINTS.secrets), SecretNamesSchema);
			return v?.names ?? [];
		},
	};
}

/**
 * Format one `/api/logs` record into a single mono log line for the LiveLog panel. The
 * record carries NO token/secret/header (the logger redacts by construction); this
 * formatter introduces none either — it renders only time + method + path + status (AC-4).
 */
export function formatLogLine(r: LogRecordWire): string {
	const time = (r.time || "").slice(11, 19) || (r.time || "").slice(0, 8);
	const status = r.status > 0 ? ` ${r.status}` : "";
	return `${time}  ${r.method} ${r.path}${status}`.trimEnd();
}
