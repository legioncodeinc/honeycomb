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
	recall: "/api/memories/recall",
	logs: "/api/logs",
	health: "/health",
	dream: "/api/diagnostics/dream",
} as const);

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas — mirror `src/dashboard/contracts.ts` (D-5) over the WIRE truth.
// Every field defaults so a partial payload degrades to a safe empty/zero state.
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/diagnostics/kpis` → {@link import("../contracts.js").KpisView}. */
export const KpisSchema = z.object({
	memoryCount: z.number().catch(0),
	sessionCount: z.number().catch(0),
	estimatedSavings: z.number().catch(0),
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
 * `src/daemon/runtime/memories/recall.ts` (`{ source, id, text }` per hit). The kit's
 * `MemoryCard` wants `{ memoryKey, snippet, source, score, scope, verified }`; we MAP the
 * wire hit to those props in {@link recall} (the wire has no score/scope/verified, so they
 * are derived honestly: id→memoryKey, text→snippet, the arm name→scope hint).
 */
export const RecallHitSchema = z.object({
	source: z.string().catch(""),
	id: z.string().catch(""),
	text: z.string().catch(""),
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
	readonly score: number;
	readonly scope: string;
	readonly verified: boolean;
}

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

/** The Wave-1 Dream ack (`POST /api/diagnostics/dream` → 202 + this body). */
export const DreamAckSchema = z.object({
	triggered: z.boolean().catch(false),
	status: z.string().catch("skipped"),
	reason: z.string().optional(),
});
export type DreamAck = z.infer<typeof DreamAckSchema>;

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
	recall(query: string): Promise<{ memories: RecalledMemory[]; degraded: boolean }>;
	logs(limit?: number): Promise<LogRecordWire[]>;
	health(): Promise<boolean>;
	dream(): Promise<DreamAck>;
}

/** The empty/zero KPIs the UI shows before the first load resolves (or on failure). */
export const EMPTY_KPIS: KpisWire = { memoryCount: 0, sessionCount: 0, estimatedSavings: 0 };

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
				const memories = parsed.data.hits.map((h, i) => ({
					// id → memoryKey, text → snippet, arm → source label. The wire carries no
					// score/verified; derive an honest descending rank and the verified=team flag.
					memoryKey: h.id !== "" ? h.id : `hit-${i + 1}`,
					snippet: h.text,
					source: h.source,
					score: Math.max(0, 1 - i * 0.06),
					scope: scopeForSource(h.source),
					verified: h.source === "memories",
				}));
				return { memories, degraded: parsed.data.degraded };
			} catch {
				return { memories: [], degraded: true };
			}
		},
		async logs(limit = 40): Promise<LogRecordWire[]> {
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.logs}?limit=${limit}`), LogsResponseSchema);
			return v?.records ?? [];
		},
		async health(): Promise<boolean> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.health), { headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS } });
				return res.ok;
			} catch {
				return false;
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
