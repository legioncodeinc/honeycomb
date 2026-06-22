/**
 * The HARNESSES page — PRD-039b (overview) + PRD-039c (per-harness detail).
 *
 * Mounted at the PRD-037 `#/harnesses` slot. The shell's `Outlet` resolves BOTH `#/harnesses` and a
 * deep `#/harnesses/<name>` to THIS component (the registry prefix-match, 037c), so the page reads the
 * active hash and renders:
 *   - `#/harnesses`         → the OVERVIEW (039b): six per-harness KPI cards + an installed/active
 *                             matrix, hydrated from `GET /api/diagnostics/harnesses` (039a) via the
 *                             shared wire — no hardcoded list, uninstalled rendered honestly as greyed
 *                             "not installed". Each card / matrix row drills into `#/harnesses/<name>`.
 *   - `#/harnesses/<name>`  → the DETAIL (039c): the harness's summary header (from the SAME 039a
 *                             status), its live activity filtered from the existing `/api/logs` stream
 *                             (client-side per c-OQ-1 — no second log pipe), and capability panels
 *                             DRIVEN BY the server-folded descriptor (c-OQ-2). A harness lacking a
 *                             capability OMITS that panel (c-AC-3) — Cursor shows Agents, Claude Code
 *                             does not.
 *
 * Every value is hydrated from the daemon's live endpoint through the shared wire (one source, D-3);
 * every visual value is an existing `var(--…)` DS token + an existing primitive (`Kpi`/`Badge`/`Panel`).
 * NO new dependency, NO CDN React, NO secret in the page/route/streamed lines (PRD-037 D-9 inherited).
 */

import React from "react";

import { Badge, Kpi } from "../primitives.js";
import { AGENT_DOT, AGENT_DOT_FALLBACK, LiveLog, Panel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { PageFrame, usePoll } from "../page-frame.js";
import { useHashRoute } from "../router.js";
import { formatLogLine, type HarnessCapabilitiesWire, type HarnessStatusWire, type LogRecordWire } from "../wire.js";

/** How often the overview/detail re-hydrate the 039a status (ms) — light refresh, stopped on unmount. */
const STATUS_POLL_MS = 5000;
/** How often the detail page re-reads `/api/logs` for the filtered live stream (ms). */
const STREAM_POLL_MS = 2500;
/** How many recent log lines the detail live stream keeps. */
const MAX_STREAM_LINES = 12;

/** The harness-detail route prefix the page parses the `<name>` param out of. */
const DETAIL_PREFIX = "/harnesses/";

/** Parse the harness `<name>` from the active hash route, or `null` for the overview route. */
export function harnessNameFromRoute(route: string): string | null {
	if (!route.startsWith(DETAIL_PREFIX)) return null;
	const name = route.slice(DETAIL_PREFIX.length).split("/")[0] ?? "";
	return name === "" ? null : name;
}

/** The colour dot for a harness id (the shared `AGENT_DOT` language, extended to six — OQ-4). */
function HarnessDot({ name }: { name: string }): React.JSX.Element {
	return <span style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: AGENT_DOT[name] ?? AGENT_DOT_FALLBACK }} />;
}

/** The status a harness reads at-a-glance: `not installed` < `idle` < `active` (b-AC-3). */
export type HarnessUiStatus = "active" | "idle" | "not installed";

/**
 * Derive the at-a-glance status (b-AC-3): `not installed` when `!installed`; else `active` when the
 * endpoint's `active` flag is set (mirrors 039a rather than re-deriving from the count, D-3); else
 * `idle`. The endpoint already sets `active = turnsCaptured > 0`, so this stays consistent.
 */
export function uiStatus(h: HarnessStatusWire): HarnessUiStatus {
	if (!h.installed) return "not installed";
	return h.active ? "active" : "idle";
}

/** The Badge tone per UI status (honey/verified for active, neutral for idle, muted for uninstalled). */
const STATUS_TONE: Record<HarnessUiStatus, "verified" | "neutral"> = {
	active: "verified",
	idle: "neutral",
	"not installed": "neutral",
};

/**
 * Render a last-seen value as a relative "4m ago" string (b-AC-1), or "never" when null. `nowMs` is
 * injectable so a test renders deterministically. Absolute time rides the title (hover) at the call site.
 */
export function relativeLastSeen(lastSeen: string | null, nowMs: number = Date.now()): string {
	if (lastSeen === null || lastSeen === "") return "never";
	const then = Date.parse(lastSeen);
	if (!Number.isFinite(then)) return lastSeen; // un-parseable → show the raw value honestly
	const deltaMs = Math.max(0, nowMs - then);
	const sec = Math.floor(deltaMs / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}

/** A label for a UI status badge (the visible status text). */
const STATUS_LABEL: Record<HarnessUiStatus, string> = {
	active: "active",
	idle: "idle",
	"not installed": "not installed",
};

// ── Overview (039b) ──────────────────────────────────────────────────────────

/** One per-harness KPI card (039b): name + dot, a turns Kpi, last-seen, a status badge. Click drills in. */
function HarnessCard({ h, onOpen }: { h: HarnessStatusWire; onOpen: (name: string) => void }): React.JSX.Element {
	const status = uiStatus(h);
	const greyed = status === "not installed";
	return (
		<button
			type="button"
			data-testid={`harness-card-${h.name}`}
			data-harness={h.name}
			onClick={() => onOpen(h.name)}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 12,
				padding: 16,
				textAlign: "left",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				cursor: "pointer",
				// Honest greying for an uninstalled harness (not omitted, not faked — b-AC-3).
				opacity: greyed ? 0.6 : 1,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 9 }}>
				<HarnessDot name={h.name} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{h.name}</span>
				<span style={{ flex: 1 }} />
				<Badge tone={STATUS_TONE[status]} mono dot>
					{STATUS_LABEL[status]}
				</Badge>
			</div>
			<Kpi label="turns captured" value={h.turnsCaptured.toLocaleString()} accent={h.active ? "verified" : "neutral"} style={{ padding: 0, background: "transparent", border: "none" }} />
			<span
				title={h.lastSeen ?? "never"}
				style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}
			>
				last seen {relativeLastSeen(h.lastSeen)}
			</span>
		</button>
	);
}

/** A ✓ / — cell for the installed/active matrix (b-AC-2). */
function Mark({ on }: { on: boolean }): React.JSX.Element {
	return <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: on ? "var(--verified)" : "var(--text-tertiary)" }}>{on ? "✓" : "—"}</span>;
}

/** The compact installed/active matrix (b-AC-2): one row per harness, click drills in. */
function HarnessMatrix({ harnesses, onOpen }: { harnesses: readonly HarnessStatusWire[]; onOpen: (name: string) => void }): React.JSX.Element {
	return (
		<Panel title="Fleet" eyebrow={`${harnesses.length} harnesses`}>
			<div role="table" aria-label="installed/active matrix" style={{ display: "flex", flexDirection: "column" }}>
				<div role="row" style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 1.2fr 0.8fr", gap: 10, padding: "6px 6px", borderBottom: "1px solid var(--border-subtle)" }}>
					{["harness", "installed", "active", "last seen", "turns"].map((c) => (
						<span key={c} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
							{c}
						</span>
					))}
				</div>
				{harnesses.map((h) => (
					<div
						key={h.name}
						role="row"
						data-testid={`harness-row-${h.name}`}
						data-harness={h.name}
						onClick={() => onOpen(h.name)}
						style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 1.2fr 0.8fr", gap: 10, alignItems: "center", padding: "9px 6px", cursor: "pointer", borderTop: "1px solid var(--border-subtle)", opacity: h.installed ? 1 : 0.6 }}
					>
						<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<HarnessDot name={h.name} />
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)" }}>{h.name}</span>
						</span>
						<Mark on={h.installed} />
						<Mark on={h.active} />
						<span title={h.lastSeen ?? "never"} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{relativeLastSeen(h.lastSeen)}</span>
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>{h.turnsCaptured.toLocaleString()}</span>
					</div>
				))}
			</div>
		</Panel>
	);
}

/** The overview body (039b): the KPI card grid + the matrix, hydrated from the live endpoint. */
function HarnessesOverview({ harnesses, onOpen }: { harnesses: readonly HarnessStatusWire[]; onOpen: (name: string) => void }): React.JSX.Element {
	return (
		<PageFrame title="Harnesses" eyebrow={`${harnesses.length} · fleet`}>
			{harnesses.length === 0 ? (
				<Panel title="Harnesses">
					<div style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No harness telemetry yet.</div>
				</Panel>
			) : (
				<>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
						{harnesses.map((h) => (
							<HarnessCard key={h.name} h={h} onOpen={onOpen} />
						))}
					</div>
					<HarnessMatrix harnesses={harnesses} onOpen={onOpen} />
				</>
			)}
		</PageFrame>
	);
}

// ── Detail (039c) ────────────────────────────────────────────────────────────

/** One labeled key/value row inside a capability panel. */
function CapRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", minWidth: 130 }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", textAlign: "right" }}>{children}</span>
		</div>
	);
}

/**
 * The capability panels for a harness (039c). The set is COMPUTED from the descriptor — a harness
 * without a capability OMITS its panel (c-AC-3): Cursor renders the Agents panel, Claude Code does not.
 * The Runtime panel is always present (every harness has a runtime path + host CLI + lifecycle events).
 */
function CapabilityPanels({ cap }: { cap: HarnessCapabilitiesWire }): React.JSX.Element {
	const hostCli = `${cap.hostCli.bin}${cap.hostCli.args.length > 0 ? " " + cap.hostCli.args.join(" ") : ""}`.trim();
	return (
		<>
			{/* Runtime — always present (the shim statics). */}
			<Panel title="Runtime" eyebrow={cap.runtimePath || "—"} style={{ marginBottom: 16 }}>
				<CapRow label="runtime path">{cap.runtimePath || "—"}</CapRow>
				<CapRow label="context channel">{cap.contextChannel || "—"}</CapRow>
				<CapRow label="host CLI">{hostCli || "—"}</CapRow>
				{cap.hostCli.fallbackBin !== undefined && cap.hostCli.fallbackBin !== "" && (
					<CapRow label="fallback CLI">{cap.hostCli.fallbackBin}</CapRow>
				)}
				<CapRow label="lifecycle events">{cap.lifecycleEvents.length > 0 ? cap.lifecycleEvents.join(", ") : "—"}</CapRow>
			</Panel>

			{/* Agents — ONLY when the descriptor declares it (Cursor). Claude Code omits this entirely. */}
			{cap.agents !== undefined && (
				<div data-testid="cap-agents" style={{ marginBottom: 16 }}>
					<Panel title="Agents" eyebrow="cursor-agent">
						<CapRow label="agent kind">{cap.agents.kind}</CapRow>
						<CapRow label="binary">{cap.agents.binary}</CapRow>
						{cap.agents.fallbackBin !== undefined && cap.agents.fallbackBin !== "" && (
							<CapRow label="fallback">{cap.agents.fallbackBin}</CapRow>
						)}
						{cap.workspaceRoots === true && <CapRow label="workspace roots">yes</CapRow>}
					</Panel>
				</div>
			)}

			{/* MCP registration — ONLY for Hermes. */}
			{cap.mcpRegistration === true && (
				<div data-testid="cap-mcp" style={{ marginBottom: 16 }}>
					<Panel title="MCP" eyebrow="registered">
						<CapRow label="honeycomb tools">honeycomb_search · honeycomb_read · honeycomb_index</CapRow>
					</Panel>
				</div>
			)}

			{/* Contracted tools — ONLY for OpenClaw. */}
			{cap.contractedTools === true && (
				<div data-testid="cap-contracted" style={{ marginBottom: 16 }}>
					<Panel title="Contracted tools" eyebrow="registered">
						<CapRow label="tool registration">contracted (no pre-tool hook)</CapRow>
					</Panel>
				</div>
			)}

			{/* AGENTS.md context — ONLY for pi. */}
			{cap.agentsMdContext === true && (
				<div data-testid="cap-agentsmd" style={{ marginBottom: 16 }}>
					<Panel title="Context surface" eyebrow="AGENTS.md">
						<CapRow label="injection">static AGENTS.md block</CapRow>
					</Panel>
				</div>
			)}

			{/* User-visible login — ONLY for Codex. */}
			{cap.userVisibleLogin === true && (
				<div data-testid="cap-login" style={{ marginBottom: 16 }}>
					<Panel title="Context surface" eyebrow="login line">
						<CapRow label="injection">user-visible login line</CapRow>
					</Panel>
				</div>
			)}
		</>
	);
}

/**
 * Filter the `/api/logs` records to a harness's activity (c-OQ-1, client-side). The request-log
 * record carries `method`/`path`/`status` (NO `agent` tag — logs/api.ts), so the only honest signal
 * is the harness name appearing in the request PATH (e.g. a per-harness install/sync route). A record
 * is kept iff its path mentions the harness; when none match, the live panel shows its waiting state —
 * NEVER a fabricated line. The records carry no secret by construction, so the filtered lines inherit
 * that guarantee (c-AC-2).
 */
export function filterRecordsForHarness(records: readonly LogRecordWire[], name: string): LogRecordWire[] {
	if (name === "") return [];
	const needle = name.toLowerCase();
	return records.filter((r) => (r.path ?? "").toLowerCase().includes(needle));
}

/** The detail body (039c): the summary header, the capability panels, and the filtered live stream. */
function HarnessDetail({
	name,
	status,
	lines,
	onBack,
}: {
	name: string;
	status: HarnessStatusWire | null;
	lines: readonly string[];
	onBack: () => void;
}): React.JSX.Element {
	const back = (
		<button
			type="button"
			onClick={onBack}
			style={{ height: 28, padding: "0 12px", background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 12, cursor: "pointer" }}
		>
			‹ Harnesses
		</button>
	);

	// A harness id not in the live six (a stale/typo deep link) renders an honest "unknown" state
	// rather than a blank — the registry resolves the route, but the data may not carry it.
	if (status === null) {
		return (
			<PageFrame title={name} eyebrow="harness" right={back}>
				<Panel title="Unknown harness">
					<div style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
						No telemetry for <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{name}</code> — it is not one of the six canonical harnesses.
					</div>
				</Panel>
			</PageFrame>
		);
	}

	const s = uiStatus(status);
	return (
		<PageFrame title={name} eyebrow="harness" right={back}>
			{/* Summary header KPIs from the SAME 039a status (one source — D-3). */}
			<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
				<HarnessDot name={name} />
				<Badge tone={STATUS_TONE[s]} mono dot>
					{STATUS_LABEL[s]}
				</Badge>
				<span style={{ flex: 1 }} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }} title={status.lastSeen ?? "never"}>
					last seen {relativeLastSeen(status.lastSeen)}
				</span>
			</div>
			<div className="kpirow" style={{ marginBottom: 18 }}>
				<Kpi label="Turns" value={status.turnsCaptured.toLocaleString()} accent={status.active ? "verified" : "neutral"} />
				<Kpi label="Installed" value={status.installed ? "yes" : "no"} accent={status.installed ? "honey" : "neutral"} />
				<Kpi label="Runtime" value={status.runtimePath || "—"} accent="dream" />
			</div>

			{/* Capability panels — driven by the descriptor; a missing capability omits its panel (c-AC-3). */}
			<CapabilityPanels cap={status.capabilities} />

			{/* Live activity — the existing /api/logs stream, filtered to this harness (c-AC-2). */}
			<LiveLog lines={lines} />
		</PageFrame>
	);
}

// ── The routed page (overview vs detail off the hash) ─────────────────────────

/**
 * The Harnesses page (039b/039c). Hydrates the six `HarnessStatus`es from the shared wire (039a — the
 * single backbone) and renders the OVERVIEW for `#/harnesses` or the DETAIL for `#/harnesses/<name>`,
 * deciding off the active hash route. The detail page additionally polls the existing `/api/logs`
 * records and filters them to the harness for its live stream (no second log pipe — D-4 / c-OQ-1).
 */
export function HarnessesPage({ wire }: PageProps): React.JSX.Element {
	const { route, navigate } = useHashRoute();
	const detailName = harnessNameFromRoute(route);

	const [harnesses, setHarnesses] = React.useState<readonly HarnessStatusWire[]>([]);
	const [lines, setLines] = React.useState<readonly string[]>([]);

	// Hydrate the six statuses (the backbone). A light poll keeps last-seen fresh; stops on unmount.
	usePoll(async () => setHarnesses(await wire.harnesses()), STATUS_POLL_MS);

	// On a detail route, poll /api/logs and filter the records to this harness (client-side — c-OQ-1).
	// On the overview route `detailName` is null, so this poll is inert (it sets an empty feed).
	usePoll(async () => {
		if (detailName === null) {
			setLines([]);
			return;
		}
		const records = await wire.logs(MAX_STREAM_LINES * 4);
		const filtered = filterRecordsForHarness(records, detailName);
		setLines(filtered.slice(-MAX_STREAM_LINES).reverse().map(formatLogLine));
	}, STREAM_POLL_MS);

	const onOpen = React.useCallback((name: string): void => navigate(`/harnesses/${name}`), [navigate]);
	const onBack = React.useCallback((): void => navigate("/harnesses"), [navigate]);

	if (detailName !== null) {
		const status = harnesses.find((h) => h.name === detailName) ?? null;
		return <HarnessDetail name={detailName} status={status} lines={lines} onBack={onBack} />;
	}
	return <HarnessesOverview harnesses={harnesses} onOpen={onOpen} />;
}

/**
 * The 037c DYNAMIC registry resolver (parent D-6): given the live 039a harness list, compute the
 * per-harness sub-items (`#/harnesses/<name>`) the dynamic group renders. Exported so the registry
 * entry carries it; a narrow `unknown` → `HarnessStatusWire[]` narrowing keeps the registry the
 * CONTRACT while THIS page owns the data shape (037c `DynamicGroup.resolve` is `(live: unknown)`).
 */
export function resolveHarnessSubItems(live: unknown): readonly { route: string; label: string }[] {
	if (!Array.isArray(live)) return [];
	return live
		.map((h) => (h !== null && typeof h === "object" && "name" in h ? String((h as { name: unknown }).name) : ""))
		.filter((name) => name !== "")
		.map((name) => ({ route: `/harnesses/${name}`, label: name }));
}
