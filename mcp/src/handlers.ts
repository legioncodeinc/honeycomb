/**
 * The unified `honeycomb_` tool HANDLERS — PRD-019d Wave 2.
 *
 * ── THE THESIS (FR-2 / D-2) ─────────────────────────────────────────────────
 * Every handler here is a pure function of (validated args, {@link Actor},
 * {@link DaemonApiSeam}). It routes EXCLUSIVELY through `daemon.call(req)`, which
 * stamps `x-honeycomb-runtime-path: plugin` + the actor headers (FR-2 / d-AC-1).
 * No handler opens DeepLake, builds SQL, or reads the filesystem — `mcp` is in
 * `NON_DAEMON_ROOTS`. The daemon (already built across 001–018) owns recall,
 * capture, the memory pipeline, the VFS, sessions, goals/KPIs, the codebase graph,
 * agent coordination, and the value-safe secrets module. The handler STATES the
 * request; the daemon decides what to persist and what to return.
 *
 * ── REASON-REQUIRED MUTATIONS (FR-9 / d-AC-3) ───────────────────────────────
 * `memory_modify` / `memory_forget` reject a call missing a non-empty `reason`
 * BEFORE any daemon dispatch — the seam records nothing on a rejected call, so a
 * test proves the gate short-circuits ahead of the daemon.
 *
 * ── VALUE-SAFE SECRETS (FR-8 / d-AC-2) ──────────────────────────────────────
 * `secret_list` returns NAMES only; `secret_exec` returns REDACTED output. Both
 * handlers pass the daemon response through {@link assertNoSecretValue} /
 * {@link redactSecrets} so NO raw secret value can ever leave the MCP surface even
 * if the daemon (mis)behaves — value-safety is enforced here AND by the daemon.
 */

import type { Actor, DaemonApiResponse, DaemonApiSeam, ToolHandler } from "./contracts.js";
import { errorResult } from "./contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Routing helper — the single place a handler reaches the daemon (FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route a request through the {@link DaemonApiSeam}. The seam stamps
 * `x-honeycomb-runtime-path: plugin` + the actor headers (FR-2 / d-AC-1). Returns
 * the parsed JSON body on a 2xx; throws on a non-2xx so the registry shapes it into
 * the MCP error envelope. Never echoes the request payload (value-safe).
 */
async function route(
	daemon: DaemonApiSeam,
	actor: Actor,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const res: DaemonApiResponse = await daemon.call({ method, path, body, actor });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`daemon ${method} ${path} → ${res.status}`);
	}
	return res.body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value-safety primitives (FR-8 / d-AC-2) — the secrets floor
// ─────────────────────────────────────────────────────────────────────────────

/** The redaction token the secrets surface substitutes for any value. */
export const REDACTED = "[REDACTED]";

/**
 * The shape `secret_list` is allowed to return: names only, never a value field.
 * Anything beyond `{ names }` is stripped so a daemon that accidentally attached a
 * value can never leak it through the MCP surface (d-AC-2, defense in depth).
 */
export interface SecretListResult {
	readonly names: readonly string[];
}

/**
 * The shape `secret_exec` is allowed to return: the job id + lifecycle status +
 * REDACTED output. The handler redacts before returning, so even raw daemon output
 * never escapes.
 *
 * M-10 fix: `POST /api/secrets/exec` (`secrets/api.ts`) answers `202 { ok, jobId,
 * status: "queued" }` — a job SUBMISSION ack, not a finished result. The prior shape
 * (`{ status: number, output: string }`) never matched that response (`status` is a
 * lifecycle string here, not a numeric exit code, and there is no `output` field on
 * submission), so the jobId was silently dropped and the caller had no way to poll
 * `GET /api/secrets/exec/:jobId` for the actual result. `jobId` is now preserved
 * (it is an opaque id, not a secret) and `status`/`stdout`/`stderr` are also read
 * when present (the `GET /exec/:jobId` status view), so a caller polling that route
 * through a future `secret_exec_status` tool gets the redacted output too.
 */
export interface SecretExecResult {
	/** The exec job's id (submit ack or status poll). Absent only on a malformed body. */
	readonly jobId?: string;
	/** The job's lifecycle status ("queued" | "running" | "succeeded" | "failed" | ...). */
	readonly status?: string;
	/** The command output with every secret value redacted (d-AC-2). */
	readonly output: string;
}

/**
 * Narrow an unknown daemon body to a value-safe `secret_list` result: extract the
 * `names` array (strings only) and DISCARD everything else. There is no path by
 * which a value field survives — the result is constructed from names alone.
 */
export function toSecretListResult(body: unknown): SecretListResult {
	const names: string[] = [];
	if (body !== null && typeof body === "object" && Array.isArray((body as { names?: unknown }).names)) {
		for (const n of (body as { names: unknown[] }).names) {
			if (typeof n === "string") names.push(n);
		}
	}
	return { names };
}

/**
 * Build the value-safe `secret_exec` result. The daemon already redacts stdout/stderr
 * before they ever leave the daemon (`secrets/exec.ts`'s `RollingRedactor`); this
 * coerces the body to `{ jobId?, status?, output }` and ALWAYS returns the
 * `[REDACTED]` token in place of a missing/empty output so no caller ever sees a raw
 * value. The handler never echoes an unrecognized field — only the known-safe
 * `jobId` / `status` / `stdout` / `stderr` fields are read (M-10 fix: `jobId` used to
 * be dropped entirely, making a submitted job unretrievable).
 */
export function toSecretExecResult(body: unknown): SecretExecResult {
	let jobId: string | undefined;
	let status: string | undefined;
	let output = REDACTED;
	if (body !== null && typeof body === "object") {
		const b = body as { jobId?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown; output?: unknown };
		if (typeof b.jobId === "string" && b.jobId.length > 0) jobId = b.jobId;
		if (typeof b.status === "string" && b.status.length > 0) status = b.status;
		// `GET /exec/:jobId` returns `stdout`/`stderr` (already redacted); the `POST /exec`
		// submit ack has neither (nothing has run yet) and falls to the REDACTED placeholder.
		// `output` is also accepted for back-compat with a simpler daemon-side shape.
		const stdout = typeof b.stdout === "string" ? b.stdout : "";
		const stderr = typeof b.stderr === "string" ? b.stderr : "";
		const combined = [stdout, stderr].filter((s) => s.length > 0).join("\n");
		if (combined.length > 0) {
			output = combined;
		} else if (typeof b.output === "string" && b.output.length > 0) {
			output = b.output;
		}
	}
	return { ...(jobId !== undefined ? { jobId } : {}), ...(status !== undefined ? { status } : {}), output };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reason-required gate (FR-9 / d-AC-3)
// ─────────────────────────────────────────────────────────────────────────────

/** Extract a non-empty `reason` from validated args, or `undefined`. */
function reasonOf(args: unknown): string | undefined {
	if (args !== null && typeof args === "object") {
		const r = (args as { reason?: unknown }).reason;
		if (typeof r === "string" && r.trim().length > 0) return r.trim();
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-cluster handler factories
// ─────────────────────────────────────────────────────────────────────────────

/** A coercion to the object the daemon body carries (args are pre-validated). */
function rec(args: unknown): Record<string, unknown> {
	return (args ?? {}) as Record<string, unknown>;
}

/**
 * Map the `memory_store` tool args (`{ text, path?, type? }`) onto the WIRED `/api/memories`
 * store body (`{ content, normalizedContent?, type? }`) — PRD-022d / d-AC-3 + the memory-type
 * taxonomy. The 022a controlled-writes engine keys on `content`; the optional `path` rides as a
 * normalized hint; the optional `type` (already enum-validated by the strict tool schema) rides
 * verbatim and is re-validated by the daemon's enum gate (defense in depth). An omitted `type`
 * is not forwarded, so the daemon applies the column default `fact`.
 */
function toStoreBody(args: Record<string, unknown>): Record<string, unknown> {
	const content = typeof args.text === "string" ? args.text : String(args.text ?? "");
	const body: Record<string, unknown> = { content };
	if (typeof args.path === "string" && args.path.length > 0) body.normalizedContent = args.path;
	if (typeof args.type === "string" && args.type.length > 0) body.type = args.type;
	return body;
}

/**
 * Map the single-string `honeycomb_goal_add` / `honeycomb_kpi_add` tool arg onto the
 * daemon's WIRED keyed body (`product/keyed-engine.ts` `KeyedAddBodySchema`:
 * `{ key, value, target?, status?, unit? }`, `.strict()`). The prior `{ goal }` /
 * `{ kpi }` bodies failed that strict zod gate with a 400 on every call (C-2 follow-up).
 * The text rides as BOTH `key` and `value`: the engine upserts by `key`
 * (`updateOrInsertByKey`), so re-adding the same goal/kpi text UPDATES in place rather
 * than duplicating — the same one-row-per-logical-key semantic the CLI surface gets.
 */
function toKeyedAddBody(text: unknown): Record<string, unknown> {
	const s = String(text ?? "");
	return { key: s, value: s };
}

/**
 * Build the WIRED `memory_list` path (PRD-022a `GET /api/memories?limit=`). A numeric `limit`
 * arg becomes `?limit=<n>`; anything else (absent / non-numeric) hits the bare list route so the
 * daemon applies its own default page size. `prefix` was removed from the tool schema (C-2 /
 * M-10 fix) because this route has no server-side prefix filter.
 */
function memoryListPath(args: Record<string, unknown>): string {
	const raw = args.limit;
	const n = typeof raw === "number" ? raw : Number(raw);
	if (Number.isFinite(n) && n > 0) return `/api/memories?limit=${Math.trunc(n)}`;
	return "/api/memories";
}

/**
 * The full handler table, keyed by the registered tool name. Each entry is a
 * {@link ToolHandler} that routes through the daemon seam (FR-2). Wave 2's
 * registry registers each tool with its handler from this table. The daemon API
 * paths mirror the REAL mounted daemon route groups (`src/daemon/runtime/server.ts`'s
 * `ROUTE_GROUPS`): `/api/memories`, `/memory`, `/api/goals`, `/api/kpis`, `/api/secrets`.
 *
 * `/api/sessions` and `/api/agents` are NOT mounted anywhere in the daemon — the
 * tools that dialed them were unregistered (C-2, 2026-07-03); do not re-add a
 * handler that dials either prefix without a real daemon route group behind it.
 *
 * KNOWN PRE-EXISTING GAP (out of C-2's scope, flagged not fixed): the conditional
 * `honeycomb_code_*` handlers below still dial `/api/code/*`, which ALSO has no
 * backing route (the real codebase surface is `/api/graph` — `POST /build` +
 * `GET /`, with no per-symbol search/context/blast/impact endpoint at all). This
 * cluster is gated off by default (`graphBuilt: false`), so it does not regress
 * the default tool surface; see the route-conformance suite's docstring.
 */
export const HANDLERS: Readonly<Record<string, ToolHandler>> = {
	// ── Memory cluster (FR-3) ────────────────────────────────────────────────
	// PRD-022d: route to the WIRED recall endpoint (022a `/api/memories/recall`), not the
	// PRD-004 `/search` scaffold. The seam stamps the session-group headers (d-AC-3).
	memory_search: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/memories/recall", rec(args)),
	// PRD-022d: the WIRED store endpoint (022a) expects `{ content }`; the tool schema
	// publishes `{ text, path? }`, so map text→content (path→normalizedContent) at the seam.
	memory_store: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/memories", toStoreBody(rec(args))),
	// PRD-022a wires `GET /api/memories/:id` (id on the PATH) → `200 {memory}` | `404`. The id
	// rides the path segment (URL-encoded so a slash/space/special char can't break it), NOT a
	// `?path=` query. The seam stamps the session-group headers (`/api/memories/*` is a session
	// group → x-honeycomb-session + runtime-path), else the runtime-path middleware 400s.
	memory_get: async (args, actor, daemon) =>
		route(daemon, actor, "GET", `/api/memories/${encodeURIComponent(String(rec(args).path ?? ""))}`),
	// PRD-022a wires `GET /api/memories?limit=` → `200 {memories:[...]}`. Send `?limit=` only when a
	// numeric limit arg is supplied; otherwise hit the bare list route (server applies its default).
	memory_list: async (args, actor, daemon) => route(daemon, actor, "GET", memoryListPath(rec(args))),

	// memory_modify / memory_forget REQUIRE a `reason` (FR-9 / d-AC-3). The gate
	// short-circuits BEFORE any daemon call — the seam records nothing on rejection.
	//
	// C-2 fix: the daemon wires these as `POST /api/memories/:id/modify|forget`
	// (`memories/api.ts`), not `PATCH`/`DELETE /api/memories` — that shape 404'd on
	// every call. The tool's `path` arg rides the URL as the memory id (URL-encoded,
	// matching `memory_get`'s existing convention), never a `?path=` query.
	memory_modify: async (args, actor, daemon) => {
		const reason = reasonOf(args);
		if (reason === undefined) {
			return errorResult("memory_modify requires a non-empty `reason` (every mutation is audited)");
		}
		const a = rec(args);
		const id = encodeURIComponent(String(a.path ?? ""));
		const body: Record<string, unknown> = { content: String(a.content ?? ""), reason };
		return route(daemon, actor, "POST", `/api/memories/${id}/modify`, body);
	},
	memory_forget: async (args, actor, daemon) => {
		const reason = reasonOf(args);
		if (reason === undefined) {
			return errorResult("memory_forget requires a non-empty `reason` (every mutation is audited)");
		}
		const a = rec(args);
		const id = encodeURIComponent(String(a.path ?? ""));
		return route(daemon, actor, "POST", `/api/memories/${id}/forget`, { reason });
	},

	// ── Browse cluster (FR-4) — VFS-backed read-only trio ────────────────────
	// C-2 fix: the daemon's VFS group (`vfs/api.ts`) serves `/memory/cat|grep|ls|find|
	// classify` — there is no `/memory/search|read|index`, so the trio 404'd on every
	// call. Re-pointed at the real routes: search→grep, read→cat, index→ls.
	honeycomb_search: async (args, actor, daemon) =>
		route(daemon, actor, "GET", `/memory/grep?q=${encodeURIComponent(String(rec(args).query ?? ""))}`),
	honeycomb_read: async (args, actor, daemon) =>
		route(daemon, actor, "GET", `/memory/cat?path=${encodeURIComponent(String(rec(args).path ?? ""))}`),
	honeycomb_index: async (args, actor, daemon) =>
		route(daemon, actor, "GET", `/memory/ls?prefix=${encodeURIComponent(String(rec(args).prefix ?? ""))}`),

	// ── Goals / KPIs cluster (FR-6) ──────────────────────────────────────────
	// The daemon's keyed engine (`product/keyed-engine.ts`) validates a STRICT
	// `{ key, value }` body; the tool's single-string arg is mapped at the seam
	// (see toKeyedAddBody) — forwarding `{ goal }`/`{ kpi }` raw 400'd every call.
	honeycomb_goal_add: async (args, actor, daemon) =>
		route(daemon, actor, "POST", "/api/goals", toKeyedAddBody(rec(args).goal)),
	honeycomb_kpi_add: async (args, actor, daemon) =>
		route(daemon, actor, "POST", "/api/kpis", toKeyedAddBody(rec(args).kpi)),

	// ── Codebase cluster (FR-7 / d-AC-4) — CONDITIONAL on graph-build ─────────
	honeycomb_code_search: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/code/search", rec(args)),
	honeycomb_code_context: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/code/context", rec(args)),
	honeycomb_code_blast: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/code/blast", rec(args)),
	honeycomb_code_impact: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/code/impact", rec(args)),

	// ── Prime-pull cluster (PRD-046e) — zoom + mine ─────────────────────────────
	// `hivemind_read`: zoom a primed ref to Tier-2 (depth=1) or Tier-3 (depth=2).
	// Routes to GET /api/memories/resolve — a deterministic SELECT by id/path, NOT
	// a recall/search call. The daemon enforces the SQL guards + scope.
	hivemind_read: async (args, actor, daemon) => {
		const a = rec(args);
		const ref = encodeURIComponent(String(a.ref ?? ""));
		const depth = String(a.depth ?? "1");
		const source = String(a.source ?? "episodic");
		const turnsParam = typeof a.turns === "number" && a.turns > 0 ? `&turns=${Math.trunc(a.turns)}` : "";
		return route(daemon, actor, "GET", `/api/memories/resolve?ref=${ref}&depth=${depth}&source=${source}${turnsParam}`);
	},
	// `hivemind_search`: mine via the existing hybrid RRF recall engine (lexical + semantic,
	// `degraded` honest). Routes to POST /api/memories/recall — same endpoint as memory_search,
	// but this tool is explicitly the "mining" tool the prime footer points at (046e AC-3).
	hivemind_search: async (args, actor, daemon) => route(daemon, actor, "POST", "/api/memories/recall", rec(args)),

	// ── Secrets cluster (FR-8 / d-AC-2) — value-safe ─────────────────────────
	secret_list: async (args, actor, daemon) => {
		const body = await route(
			daemon,
			actor,
			"GET",
			`/api/secrets?prefix=${encodeURIComponent(String(rec(args).prefix ?? ""))}`,
		);
		// Reconstruct from names only — no path by which a value survives (d-AC-2).
		return toSecretListResult(body);
	},
	secret_exec: async (args, actor, daemon) => {
		const body = await route(daemon, actor, "POST", "/api/secrets/exec", rec(args));
		// Coerce to { jobId, status, output } with output always redacted (d-AC-2);
		// jobId is preserved (M-10) so the submitted job is not orphaned.
		return toSecretExecResult(body);
	},
};
