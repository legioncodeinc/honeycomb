/**
 * The DASHBOARD page — PRD-037b D-6 (the lift-and-shift).
 *
 * This is the CURRENT `app.tsx` BODY moved VERBATIM onto the Dashboard route: KPI row → per-subsystem
 * health strip → recall bar → recalled-memory cards → 2-col grid (Sessions/Rules | Graph/Settings/
 * Skill-sync) → live log. ZERO content change (D-6 forbids reorganizing here — that is PRD-038's job;
 * 037 only changes WHERE this renders, never WHAT). The page hydrates from the SHARED `wire` the shell
 * passes via {@link PageProps} (it does NOT call `createWireClient` — the shell builds ONE), and reads
 * the shell-owned `dreaming` flag for the graph/card pulse (D-5: the "Dream now" action + the
 * org/workspace identity + the coarse daemon pill + the daemon-down swap all moved UP to the shell, so
 * this page renders NO header of its own).
 *
 * Every value is hydrated from the daemon's live endpoints through the wire client (the same zod
 * boundary the old app used); every visual value is an existing `var(--…)` DS token.
 */

import React from "react";

import { Badge, Button, Input, Kpi, MemoryCard } from "../primitives.js";
import { GraphCanvas, LiveLog, RulesPanel, SessionsPanel, SettingsPanel, SkillSyncPanel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import {
	EMPTY_GRAPH,
	EMPTY_KPIS,
	EMPTY_VAULT_SETTINGS,
	formatLogLine,
	type GraphWire,
	type HealthReasonsWire,
	type KpisWire,
	type RecalledMemory,
	type RuleRowWire,
	type SessionRowWire,
	type SettingValueWire,
	type SkillRowWire,
	type VaultSettingsWire,
} from "../wire.js";

/** How often the live-log poll re-reads `/api/logs` (ms). Reasonable cadence, stopped on unmount. */
const LOG_POLL_MS = 2500;
/** How often the health poll probes `/health` for the per-subsystem strip reasons (ms). */
const HEALTH_POLL_MS = 5000;
/** How many recent log lines the panel keeps. */
const MAX_LOG_LINES = 8;

/** The local-clock prefix for a client-originated log line (recall notes). */
function clockPrefix(): string {
	return new Date().toTimeString().slice(0, 8);
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
 * `degraded: true` (embeddings off/absent → lexical BM25/ILIKE). Renders subsystem STATE only — the
 * single closed flag, NO token/org/header (AC-5) — using the kit's `Badge` in the `warning` tone.
 */
function LexicalFallbackBadge(): React.JSX.Element {
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
 * The PRD-029 per-subsystem health strip (D-2 render). Reads the `/health` `reasons` block and renders
 * one small chip per subsystem — `storage`, `semantic` (embeddings), `schema` — tinting a degraded one
 * `critical` and a healthy one `verified`. When `reasons` is `null` (the mode-gated public body, which
 * the LOCAL dashboard never gets — defensive) the whole strip renders NOTHING.
 *
 * AC-5: every chip renders a subsystem NAME + a closed-enum STATE only — no token/org/endpoint/header.
 */
function HealthStrip({ reasons }: { reasons: HealthReasonsWire | null }): React.JSX.Element | null {
	if (reasons === null) return null;
	return (
		<div data-testid="health-strip" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
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
 * The Dashboard route content (the lift-and-shift, D-6). On mount it hydrates every view from the
 * shared `wire` (AC-2), polls `/api/logs` (AC-4) and `/health` for the strip reasons (PRD-029), and
 * runs recall (AC-3). The `dreaming` pulse is owned by the shell (D-5) and read from props. All
 * polling clears on unmount. NO header — the shell owns the chrome (D-5).
 */
export function DashboardPage({ wire, dreaming = false }: PageProps): React.JSX.Element {
	// ── view state (hydrated from the shared wire) ──
	const [healthReasons, setHealthReasons] = React.useState<HealthReasonsWire | null>(null);
	const [kpis, setKpis] = React.useState<KpisWire>(EMPTY_KPIS);
	const [sessions, setSessions] = React.useState<readonly SessionRowWire[]>([]);
	const [rules, setRules] = React.useState<readonly RuleRowWire[]>([]);
	const [skills, setSkills] = React.useState<readonly SkillRowWire[]>([]);
	const [graph, setGraph] = React.useState<GraphWire>(EMPTY_GRAPH);
	const [vaultSettings, setVaultSettings] = React.useState<VaultSettingsWire>(EMPTY_VAULT_SETTINGS);
	const [secretNames, setSecretNames] = React.useState<readonly string[]>([]);

	// ── recall state (AC-3) ──
	const [query, setQuery] = React.useState("how do we deploy");
	const [results, setResults] = React.useState<readonly RecalledMemory[]>([]);
	const [recallBusy, setRecallBusy] = React.useState(false);
	const [recalled, setRecalled] = React.useState(false);
	const [recallNonce, setRecallNonce] = React.useState(0);
	const [recallDegraded, setRecallDegraded] = React.useState(false);

	// ── log + recall-note state (AC-4) ──
	const [logLines, setLogLines] = React.useState<readonly string[]>([]);
	const [notes, setNotes] = React.useState<readonly string[]>([]);

	/** Push a client-originated note (recall summary) onto the live-log feed. */
	const pushNote = React.useCallback((text: string): void => {
		setNotes((prev) => [`${clockPrefix()}  ${text}`, ...prev].slice(0, MAX_LOG_LINES));
	}, []);

	/**
	 * Hydrate the diagnostics views + the vault settings from the live endpoints (AC-2), in ONE
	 * batched `Promise.all` round-trip (parity with the old app). The org/workspace `settings` view
	 * now renders in the SHELL header (D-5), so the page no longer keeps it — but the shell hydrates
	 * its own settings; this page hydrates only what its body renders.
	 */
	const hydrate = React.useCallback(async (): Promise<void> => {
		const [k, sess, r, sk, g, vs, sn] = await Promise.all([
			wire.kpis(),
			wire.sessions(),
			wire.rules(),
			wire.skills(),
			wire.graph(),
			wire.vaultSettings(),
			wire.secretNames(),
		]);
		setKpis(k);
		setSessions(sess);
		setRules(r);
		setSkills(sk);
		setGraph(g);
		setVaultSettings(vs);
		setSecretNames(sn);
	}, [wire]);

	/** PRD-032c (AC-5): persist one vault `setting` through the daemon, then RE-READ the persisted truth. */
	const saveSetting = React.useCallback(
		async (key: string, value: SettingValueWire): Promise<boolean> => {
			const ok = await wire.setSetting(key, value);
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

	// PRD-029 D-2: poll /health for the per-subsystem strip reasons (the SHELL owns liveness/up-down).
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			const { reasons } = await wire.health();
			if (!alive) return;
			setHealthReasons(reasons);
		};
		void tick();
		const id = setInterval(() => void tick(), HEALTH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire]);

	// AC-3: recall → POST /api/memories/recall → render the hits as MemoryCards.
	const recall = React.useCallback(async (): Promise<void> => {
		const q = query.trim();
		if (q === "" || recallBusy) return;
		setRecallBusy(true);
		const { memories, degraded } = await wire.recall(q);
		setResults(memories);
		setRecalled(true);
		setRecallDegraded(degraded);
		setRecallNonce((n) => n + 1);
		const top = memories.length > 0 ? ` · ${memories[0]?.score.toFixed(2)} top` : "";
		pushNote(`recall    "${q}" → ${memories.length} hits${top}`);
		setRecallBusy(false);
	}, [query, recallBusy, wire, pushNote]);

	// The live-log feed merges client notes (recall) ahead of the polled daemon lines.
	const feed = React.useMemo(() => [...notes, ...logLines].slice(0, MAX_LOG_LINES), [notes, logLines]);

	return (
		<>
			{/* PRD-029 D-2 (render): the per-subsystem health strip, reading the /health reasons. */}
			<HealthStrip reasons={healthReasons} />

			{/* KPIs (AC-2) — metrics sit at the top of the page content */}
			<div className="kpirow" style={{ marginBottom: 22 }}>
				<Kpi label="Memories" value={kpis.memoryCount.toLocaleString()} accent="honey" />
				<Kpi label="Turns" value={kpis.turnCount || kpis.sessionCount} accent="neutral" />
				<Kpi label="Est. savings" value={kpis.estimatedSavings.toLocaleString()} unit="tok" accent="verified" />
				<Kpi label="Team skills" value={kpis.teamSkillCount} accent="dream" />
			</div>

			<RecallBar query={query} setQuery={setQuery} onRecall={recall} busy={recallBusy} />

			{/* PRD-029 AC-1: the "lexical fallback" badge — shown ONLY when the LAST recall ran degraded. */}
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
					<SettingsPanel catalog={vaultSettings.catalog} settings={vaultSettings.settings} secretNames={secretNames} onSave={saveSetting} />
					<SkillSyncPanel skills={skills} />
				</div>
			</div>

			{/* live log (AC-4) */}
			<LiveLog lines={feed} />
		</>
	);
}
