/**
 * The dashboard APP — PRD-024 Wave 2 (AC-1..AC-6).
 *
 * This is the live, daemon-served re-creation of `assets/ui_kits/dashboard/index.html`'s
 * `App` — same layout (header → KPI row → recall bar → memory cards → 2-col grid → live log
 * → connectivity banner), same DS tokens, same panels — but every value is hydrated from the
 * daemon's LIVE endpoints through {@link createWireClient} (D-2, no canned `data.js`), and
 * the interactions hit the REAL routes:
 *
 *   AC-2  on mount, fetch kpis/sessions/settings/rules/skills/graph and render them.
 *   AC-3  the recall bar POSTs `/api/memories/recall` and renders the hits as MemoryCards.
 *   AC-4  poll `/api/logs` and render the real daemon log lines (no secret introduced).
 *   AC-5  poll `/health`; on failure swap the whole view for the ConnectivityBanner; Retry
 *         re-probes and restores the view. Driven by the REAL health result, NOT a demo toggle.
 *   AC-6  the "Dream now" button POSTs the Wave-1 `/api/diagnostics/dream`; the 202 ack drives
 *         the graph `dreaming` pulse + a log line, and the queued pass streams in via /api/logs.
 *         A `{triggered:false,status:"skipped",reason}` ack is reflected HONESTLY (a "skipped"
 *         log line), never a fake forever-dreaming spinner.
 */

import React from "react";

import { Badge, Button, Input, Kpi, MemoryCard } from "./primitives.js";
import { ConnectivityBanner, GraphCanvas, LiveLog, RulesPanel, SessionsPanel, SettingsPanel, SkillSyncPanel } from "./panels.js";
import {
	createWireClient,
	EMPTY_GRAPH,
	EMPTY_KPIS,
	EMPTY_SETTINGS,
	EMPTY_VAULT_SETTINGS,
	formatLogLine,
	type GraphWire,
	type HealthReasonsWire,
	type KpisWire,
	type RecalledMemory,
	type RuleRowWire,
	type SessionRowWire,
	type SettingsWire,
	type SettingValueWire,
	type SkillRowWire,
	type VaultSettingsWire,
	type WireClient,
} from "./wire.js";

/** How often the live-log poll re-reads `/api/logs` (ms). Reasonable cadence, stopped on unmount. */
const LOG_POLL_MS = 2500;
/** How often the health poll probes `/health` (ms). */
const HEALTH_POLL_MS = 5000;
/** How many recent log lines the panel keeps. */
const MAX_LOG_LINES = 8;

/** The local-clock prefix for a client-originated log line (recall/dream notes). */
function clockPrefix(): string {
	return new Date().toTimeString().slice(0, 8);
}

/** Props for {@link App} — the injected wire client (defaults to a same-origin live client). */
export interface AppProps {
	/** The wire client (injected by a unit test with a mocked fetch; defaults to the live one). */
	readonly client?: WireClient;
	/** The base path the logo/assets are served under (the host serves them beside the page). */
	readonly assetBase?: string;
}

/** The header: mark · org/workspace · daemon health pill · Dream now. */
function Header({
	settings,
	daemonUp,
	dreaming,
	onDream,
	assetBase,
}: {
	settings: SettingsWire;
	daemonUp: boolean;
	dreaming: boolean;
	onDream: () => void;
	assetBase: string;
}): React.JSX.Element {
	return (
		<header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={34} height={34} alt="" />
			<div style={{ display: "flex", flexDirection: "column" }}>
				<span style={{ fontWeight: 700, fontSize: 19, letterSpacing: "-0.03em", color: "var(--text-primary)", lineHeight: 1.1 }}>honeycomb</span>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
					{settings.orgName || settings.orgId || "local"} · {settings.workspace || "default"}
				</span>
			</div>
			<span style={{ flex: 1 }} />
			<div
				title="daemon health"
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					height: 36,
					padding: "0 12px",
					background: "var(--bg-elevated)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-md)",
				}}
			>
				<span style={{ width: 8, height: 8, borderRadius: "50%", background: daemonUp ? "var(--verified)" : "var(--severity-critical)" }} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>{daemonUp ? "daemon :3850" : "offline"}</span>
			</div>
			<Button variant="dream" onClick={onDream} disabled={dreaming}>
				{dreaming ? "dreaming…" : "Dream now"}
			</Button>
		</header>
	);
}

/** The recall bar: a mono lg Input + a primary Recall button. Enter and click both fire. */
function RecallBar({
	query,
	setQuery,
	onRecall,
	busy,
}: {
	query: string;
	setQuery: (v: string) => void;
	onRecall: () => void;
	busy: boolean;
}): React.JSX.Element {
	return (
		<div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
			<div style={{ flex: 1 }}>
				<Input
					mono
					size="lg"
					value={query}
					placeholder="recall…  e.g. how do we deploy"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") onRecall();
					}}
				/>
			</div>
			<Button variant="primary" size="lg" onClick={onRecall} disabled={busy}>
				{busy ? "…" : "Recall"}
			</Button>
		</div>
	);
}

/**
 * The PRD-029 "lexical fallback" badge (AC-1). Rendered ONLY when the recall response carried
 * `degraded: true` (embeddings off/absent → the engine fell back to lexical BM25/ILIKE). It
 * renders subsystem STATE only — the single closed flag, NO token/org/header (AC-5) — using the
 * kit's `Badge` primitive in the `warning` tone so a degraded recall is honestly visible. When
 * `degraded` is false the caller renders nothing (no badge), so this component is unconditional.
 */
function LexicalFallbackBadge(): React.JSX.Element {
	// The `Badge` primitive takes no `title`, so the hover hint rides a wrapping span.
	return (
		<span title="recall fell back to lexical (embeddings off) — semantic ranking unavailable" style={{ display: "inline-flex" }}>
			<Badge tone="warning" mono dot>
				lexical fallback
			</Badge>
		</span>
	);
}

/** The display label + degraded predicate for one subsystem chip in {@link HealthStrip}. */
const SUBSYSTEMS: readonly { readonly key: keyof HealthReasonsWire; readonly label: string; readonly degraded: (r: HealthReasonsWire) => boolean }[] = [
	{ key: "storage", label: "storage", degraded: (r) => r.storage === "unreachable" },
	{ key: "embeddings", label: "semantic", degraded: (r) => r.embeddings === "off" },
	{ key: "schema", label: "schema", degraded: (r) => r.schema === "missing_table" },
];

/**
 * The PRD-029 per-subsystem health strip (D-2 render). Reads the `/health` `reasons` block and
 * renders one small chip per subsystem — `storage`, `semantic` (embeddings), `schema` — with its
 * coarse state, tinting a degraded subsystem (storage unreachable / embeddings off / a missing
 * table) `critical` and a healthy one `verified`. When `reasons` is `null` (the mode-gated public
 * body, which the LOCAL dashboard never gets — defensive) the whole strip renders NOTHING; the
 * coarse header pill carries liveness alone.
 *
 * AC-5: every chip renders a subsystem NAME + a closed-enum STATE only — there is no token, org,
 * endpoint, or header in the rendered payload (the `reasons` shape is closed string literals).
 */
function HealthStrip({ reasons }: { reasons: HealthReasonsWire | null }): React.JSX.Element | null {
	if (reasons === null) return null;
	return (
		<div
			data-testid="health-strip"
			style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
				subsystems
			</span>
			{SUBSYSTEMS.map((s) => {
				const down = s.degraded(reasons);
				const state = String(reasons[s.key]);
				return (
					<Badge key={s.key} tone={down ? "critical" : "verified"} mono dot>
						{s.label}: {state}
					</Badge>
				);
			})}
		</div>
	);
}

/**
 * The live dashboard app. On mount it hydrates every view from the daemon (AC-2), then runs a
 * health poll (AC-5) and a log poll (AC-4). Recall (AC-3) and Dream (AC-6) hit the live routes.
 * All polling is cleared on unmount.
 */
export function App({ client, assetBase = "assets" }: AppProps = {}): React.JSX.Element {
	const wire = React.useMemo<WireClient>(() => client ?? createWireClient(), [client]);

	// ── view state (hydrated from the wire) ──
	const [daemonUp, setDaemonUp] = React.useState(true);
	// PRD-029 D-2 (render): the per-subsystem `/health` reasons (null until the first probe
	// resolves, or when the mode-gated public body omits them — the strip then renders nothing).
	const [healthReasons, setHealthReasons] = React.useState<HealthReasonsWire | null>(null);
	const [settings, setSettings] = React.useState<SettingsWire>(EMPTY_SETTINGS);
	const [kpis, setKpis] = React.useState<KpisWire>(EMPTY_KPIS);
	const [sessions, setSessions] = React.useState<readonly SessionRowWire[]>([]);
	const [rules, setRules] = React.useState<readonly RuleRowWire[]>([]);
	const [skills, setSkills] = React.useState<readonly SkillRowWire[]>([]);
	const [graph, setGraph] = React.useState<GraphWire>(EMPTY_GRAPH);
	// PRD-032c: the vault `setting` class + catalog, and the names-only secret list (presence only).
	const [vaultSettings, setVaultSettings] = React.useState<VaultSettingsWire>(EMPTY_VAULT_SETTINGS);
	const [secretNames, setSecretNames] = React.useState<readonly string[]>([]);

	// ── recall state (AC-3) ──
	const [query, setQuery] = React.useState("how do we deploy");
	const [results, setResults] = React.useState<readonly RecalledMemory[]>([]);
	const [recallBusy, setRecallBusy] = React.useState(false);
	const [recalled, setRecalled] = React.useState(false);
	const [recallNonce, setRecallNonce] = React.useState(0);
	// PRD-029 AC-1: the recall response's `degraded` flag (true → lexical BM25/ILIKE fallback).
	// Drives the "lexical fallback" badge near the recall results. Only meaningful once recalled.
	const [recallDegraded, setRecallDegraded] = React.useState(false);

	// ── log + dream state (AC-4 / AC-6) ──
	const [logLines, setLogLines] = React.useState<readonly string[]>([]);
	const [notes, setNotes] = React.useState<readonly string[]>([]);
	const [dreaming, setDreaming] = React.useState(false);

	const daemonUrl = settings.settings.port ? `http://127.0.0.1:${settings.settings.port}` : "http://127.0.0.1:3850";

	/** Push a client-originated note (recall summary, dream ack) onto the live-log feed. */
	const pushNote = React.useCallback((text: string): void => {
		setNotes((prev) => [`${clockPrefix()}  ${text}`, ...prev].slice(0, MAX_LOG_LINES));
	}, []);

	/** Hydrate the diagnostics views + the PRD-032c vault settings from the live endpoints (AC-2 / AC-5). */
	const hydrate = React.useCallback(async (): Promise<void> => {
		const [s, k, sess, r, sk, g, vs, sn] = await Promise.all([
			wire.settings(),
			wire.kpis(),
			wire.sessions(),
			wire.rules(),
			wire.skills(),
			wire.graph(),
			// PRD-032c — the vault `setting` class + catalog, and the names-only secret list.
			wire.vaultSettings(),
			wire.secretNames(),
		]);
		setSettings(s);
		setKpis(k);
		setSessions(sess);
		setRules(r);
		setSkills(sk);
		setGraph(g);
		setVaultSettings(vs);
		setSecretNames(sn);
	}, [wire]);

	/**
	 * PRD-032c (AC-5): persist one vault `setting` through the daemon, then RE-READ so the panel
	 * reflects the PERSISTED value (never a local-only optimistic toggle). The write goes through
	 * the wire `/api/settings` POST (PRD-020b — the panel never opens the vault directly); on a
	 * rejected write (the daemon 400s an invalid value) we still re-read, so the UI shows the
	 * unchanged persisted value rather than a phantom local edit. Returns the daemon accept flag.
	 */
	const saveSetting = React.useCallback(
		async (key: string, value: SettingValueWire): Promise<boolean> => {
			const ok = await wire.setSetting(key, value);
			// Re-read the `setting` class (+ secret names) so the panel renders the persisted truth.
			const [vs, sn] = await Promise.all([wire.vaultSettings(), wire.secretNames()]);
			setVaultSettings(vs);
			setSecretNames(sn);
			return ok;
		},
		[wire],
	);

	// AC-2: hydrate once on mount.
	React.useEffect(() => {
		void hydrate();
	}, [hydrate]);

	// AC-4: poll /api/logs and render real daemon log lines. Stops on unmount.
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			const records = await wire.logs(MAX_LOG_LINES);
			if (!alive) return;
			setLogLines(records.slice(-MAX_LOG_LINES).reverse().map(formatLogLine));
		};
		void tick();
		const id = setInterval(() => void tick(), LOG_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire]);

	// AC-5: poll /health; the pill + the whole-view swap are driven by the REAL result.
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			const { up, reasons } = await wire.health();
			if (!alive) return;
			setDaemonUp(up);
			// PRD-029 D-2 (render): surface the per-subsystem reasons for the health strip.
			setHealthReasons(reasons);
			// When health recovers after a down spell, re-hydrate the views.
			if (up) void hydrate();
		};
		void tick();
		const id = setInterval(() => void tick(), HEALTH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, hydrate]);

	// AC-3: recall → POST /api/memories/recall → render the hits as MemoryCards.
	const recall = React.useCallback(async (): Promise<void> => {
		const q = query.trim();
		if (q === "" || recallBusy) return;
		setRecallBusy(true);
		const { memories, degraded } = await wire.recall(q);
		setResults(memories);
		setRecalled(true);
		// PRD-029 AC-1: remember whether the engine ran degraded (lexical fallback) for the badge.
		setRecallDegraded(degraded);
		setRecallNonce((n) => n + 1);
		const top = memories.length > 0 ? ` · ${memories[0]?.score.toFixed(2)} top` : "";
		pushNote(`recall    "${q}" → ${memories.length} hits${top}`);
		setRecallBusy(false);
	}, [query, recallBusy, wire, pushNote]);

	// AC-6: Dream now → POST the Wave-1 trigger; reflect the 202 ack honestly.
	const dream = React.useCallback(async (): Promise<void> => {
		if (dreaming) return;
		setDreaming(true);
		const ack = await wire.dream();
		if (ack.triggered) {
			// A real pass was queued (or one is already running): pulse the graph + note it.
			const detail = ack.status === "running" ? `already running · ${ack.reason ?? "pending"}` : "consolidating graph";
			pushNote(`dreaming  ${detail}`);
			// Let the pulse run briefly while the queued pass streams into /api/logs, then settle.
			setTimeout(() => setDreaming(false), 4200);
		} else {
			// Honestly reflect the skip (disabled / unavailable) — no fake forever spinner.
			pushNote(`dreaming  skipped · ${ack.reason ?? ack.status}`);
			setDreaming(false);
		}
	}, [dreaming, wire, pushNote]);

	// The live-log feed merges client notes (recall/dream) ahead of the polled daemon lines.
	const feed = React.useMemo(() => [...notes, ...logLines].slice(0, MAX_LOG_LINES), [notes, logLines]);

	// AC-5: when the daemon is unreachable, swap the WHOLE view for the connectivity banner.
	if (!daemonUp) {
		return (
			<div className="wrap">
				<Header settings={settings} daemonUp={false} dreaming={dreaming} onDream={dream} assetBase={assetBase} />
				<ConnectivityBanner
					url={daemonUrl}
					onRetry={() => {
						// Retry re-probes immediately; a reachable result restores the view + re-hydrates.
						void wire.health().then(({ up, reasons }) => {
							setDaemonUp(up);
							setHealthReasons(reasons);
							if (up) void hydrate();
						});
					}}
				/>
			</div>
		);
	}

	return (
		<div className="wrap">
			<Header settings={settings} daemonUp={daemonUp} dreaming={dreaming} onDream={dream} assetBase={assetBase} />

			{/* PRD-029 D-2 (render): the per-subsystem health strip, reading the /health reasons.
			    Renders nothing when reasons are absent (non-local public body — defensive). */}
			<HealthStrip reasons={healthReasons} />

			{/* KPIs (AC-2) — metrics sit at the top, right under the header */}
			<div className="kpirow" style={{ marginBottom: 22 }}>
				<Kpi label="Memories" value={kpis.memoryCount.toLocaleString()} accent="honey" />
				{/* PRD-035a: "Turns" (each captured harness turn is one `sessions` row). Reads the honest
				    `turnCount`, falling back to `sessionCount` if an older daemon omits it. */}
				<Kpi label="Turns" value={kpis.turnCount || kpis.sessionCount} accent="neutral" />
				<Kpi label="Est. savings" value={kpis.estimatedSavings.toLocaleString()} unit="tok" accent="verified" />
				{/* PRD-036c: the "Team skills" KPI binds to the DEFINED team-shared count from the daemon,
				    NOT the unioned panel array's `.length` (which includes local-only disk skills). */}
				<Kpi label="Team skills" value={kpis.teamSkillCount} accent="dream" />
			</div>

			<RecallBar query={query} setQuery={setQuery} onRecall={recall} busy={recallBusy} />

			{/* PRD-029 AC-1: the "lexical fallback" badge sits on the recall results header, shown
			    ONLY when the LAST recall ran degraded (embeddings off → lexical BM25/ILIKE). When
			    the recall ran with semantic ranking (degraded:false), NO badge renders. */}
			{recalled && recallDegraded && (
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
						recall
					</span>
					<LexicalFallbackBadge />
				</div>
			)}

			{/* recall results (AC-3) */}
			<div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }} key={recallNonce}>
				{results.length === 0
					? recalled && (
							<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No memories matched that query.</div>
						)
					: results.map((m, i) => (
							<div className="mem-enter" style={{ animationDelay: `${i * 55}ms` }} key={m.memoryKey}>
								<MemoryCard {...m} dreaming={dreaming && i === 1} />
							</div>
						))}
			</div>

			{/* main grid (AC-2) */}
			<div className="grid2" style={{ marginBottom: 16 }}>
				<div className="col">
					<SessionsPanel sessions={sessions} />
					<RulesPanel rules={rules} />
				</div>
				<div className="col">
					<GraphCanvas graph={graph} dreaming={dreaming} />
					{/* PRD-032c (AC-5): the vault Settings panel — provider→model selector + dreaming
					    toggle + names-only key presence. Every write goes through the daemon
					    `/api/settings` (saveSetting), and the panel reflects the PERSISTED vault value. */}
					<SettingsPanel catalog={vaultSettings.catalog} settings={vaultSettings.settings} secretNames={secretNames} onSave={saveSetting} />
					<SkillSyncPanel skills={skills} />
				</div>
			</div>

			{/* live log (AC-4 / AC-6) */}
			<LiveLog lines={feed} />
		</div>
	);
}
