/**
 * The DASHBOARD page — the zoned home (PRD-038, re-laying the PRD-037b lift-and-shift).
 *
 * PRD-037 lifted the old `app.tsx` body onto this route VERBATIM. PRD-038 reorganizes that body into
 * three named AREA landmarks so the home reads as zones, not one undifferentiated scroll (parent
 * D-1 / AC-1):
 *   1. `<section data-area="kpi-band">`     — the per-subsystem health strip + the four headline KPIs
 *                                             (Memories, Turns, Est. savings, Team skills — 038a).
 *   2. `<section data-area="recall-area">`  — the recall bar + recalled-memory cards + the PRD-029
 *                                             lexical-fallback badge, the centerpiece (038b, moved
 *                                             VERBATIM — same `wire.recall` POST, same render).
 *   3. `<section data-area="harness-area">` — the {@link HarnessStrip} (wired-in chips + per-harness
 *                                             KPI tiles + a short-tail `/api/logs` stream — 038c),
 *                                             then the existing 2-col grid + the full live log,
 *                                             reorganized into the zone (kept, not dropped).
 *
 * Behavior is UNCHANGED — recall, polling, and the KPI/grid panels are MOVED into the areas, not
 * rebuilt (parent D-2/D-3/D-4). The page hydrates from the SHARED `wire` the shell passes via
 * {@link PageProps} (it never calls `createWireClient` — the shell builds ONE) and reads the
 * shell-owned `pollinating` flag (D-6: the "Pollinate now" action, the identity, the coarse daemon pill, and
 * the daemon-down swap live in the shell, so this page renders NO header of its own). Every visual
 * value is an existing `var(--…)` DS token; no new token, primitive, or daemon route (AC-7/AC-8).
 */

import React from "react";

import { Badge, Button, Input, Kpi, MemoryCard } from "../primitives.js";
import { LiveLog, RulesPanel, SessionsPanel, SettingsPanel, SkillSyncPanel } from "../panels.js";
import { HarnessStrip } from "../harness-strip.js";
import { useScope } from "../scope-context.js";
import type { PageProps } from "../page-frame.js";
import {
	EMPTY_KPIS,
	EMPTY_VAULT_SETTINGS,
	formatLogLine,
	type HarnessStatusWire,
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
/** How often the harness-strip poll re-reads `/api/diagnostics/harnesses` for last-seen recency (ms). */
const HARNESS_POLL_MS = 5000;
/** How many recent log lines the panel keeps. */
const MAX_LOG_LINES = 8;
/** The short-tail cap for the harness-area live stream — tighter than the full log (038c-AC-2 / OQ-4). */
const MAX_STREAM_LINES = 5;

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
 * runs recall (AC-3). The `pollinating` pulse is owned by the shell (D-5) and read from props. All
 * polling clears on unmount. NO header — the shell owns the chrome (D-5).
 */
export function DashboardPage({ wire, pollinating = false }: PageProps): React.JSX.Element {
	// PRD-049e: the active dashboard scope — the selected project re-scopes the KPI band's
	// project-bearing counts (Memories / Turns / Est. savings). Absent → the workspace-wide view.
	const { scope } = useScope();

	// ── view state (hydrated from the shared wire) ──
	const [healthReasons, setHealthReasons] = React.useState<HealthReasonsWire | null>(null);
	const [kpis, setKpis] = React.useState<KpisWire>(EMPTY_KPIS);
	const [sessions, setSessions] = React.useState<readonly SessionRowWire[]>([]);
	const [rules, setRules] = React.useState<readonly RuleRowWire[]>([]);
	const [skills, setSkills] = React.useState<readonly SkillRowWire[]>([]);
	const [vaultSettings, setVaultSettings] = React.useState<VaultSettingsWire>(EMPTY_VAULT_SETTINGS);
	const [secretNames, setSecretNames] = React.useState<readonly string[]>([]);

	// ── harness-area state (038c) — the PRD-039 registry/telemetry backbone (`wire.harnesses()`) ──
	const [harnesses, setHarnesses] = React.useState<readonly HarnessStatusWire[]>([]);

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

	// PRD-049e: a monotonic request token guarding `hydrate` against a stale-overwrite race. Since the
	// hydrate effect now re-runs on `scope.project` change, a SLOWER response for the PREVIOUS project can
	// resolve AFTER the newer selection's and repaint the band with stale data. Each hydrate bumps this and
	// captures its own token; only the LATEST run commits its state (older in-flight runs bail post-await).
	const hydrateSeqRef = React.useRef(0);

	/**
	 * Hydrate the diagnostics views + the vault settings from the live endpoints (AC-2), in ONE
	 * batched `Promise.all` round-trip (parity with the old app). The org/workspace `settings` view
	 * now renders in the SHELL header (D-5), so the page no longer keeps it — but the shell hydrates
	 * its own settings; this page hydrates only what its body renders.
	 */
	const hydrate = React.useCallback(async (): Promise<void> => {
		const seq = ++hydrateSeqRef.current;
		const [k, sess, r, sk, vs, sn] = await Promise.all([
			wire.kpis(scope.project),
			wire.sessions(),
			wire.rules(),
			wire.skills(),
			wire.vaultSettings(),
			wire.secretNames(),
		]);
		// A newer hydrate (a faster project switch) superseded this one → drop this stale result wholesale
		// so the band never flickers back to the previous project's numbers.
		if (seq !== hydrateSeqRef.current) return;
		setKpis(k);
		setSessions(sess);
		setRules(r);
		setSkills(sk);
		setVaultSettings(vs);
		setSecretNames(sn);
	}, [wire, scope.project]);

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

	// 038c: poll the PRD-039 harness registry/telemetry for the wired-in strip + per-harness tiles.
	// A light poll keeps last-seen recency fresh; stops on unmount. A failure degrades to [] (wire-safe).
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			const rows = await wire.harnesses();
			if (!alive) return;
			setHarnesses(rows);
		};
		void tick();
		const id = setInterval(() => void tick(), HARNESS_POLL_MS);
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

	// 038c-AC-2: the harness-area short-tail stream — the SAME polled /api/logs lines, capped tighter
	// than the full log. `/api/logs` carries no per-line harness field (c-OQ-3), so it is unlabeled.
	const streamLines = React.useMemo(() => logLines.slice(0, MAX_STREAM_LINES), [logLines]);

	return (
		<>
			{/* ── AREA 1: the top KPI band (038a) ─────────────────────────────────────────────────── */}
			<section data-area="kpi-band" aria-label="Key metrics" style={{ marginBottom: 22 }}>
				{/* PRD-029 D-2 (render): the per-subsystem health strip, reading the /health reasons. */}
				<HealthStrip reasons={healthReasons} />

				{/* The four headline KPIs (038a-AC-2/AC-3) — corrected Turns/Est. savings/Team skills. */}
				<div className="kpirow">
					<Kpi label="Memories" value={kpis.memoryCount.toLocaleString()} accent="honey" />
					<Kpi label="Turns" value={kpis.turnCount || kpis.sessionCount} accent="neutral" />
					<Kpi label="Est. savings" value={kpis.estimatedSavings.toLocaleString()} unit="tok" accent="verified" />
					<Kpi label="Team skills" value={kpis.teamSkillCount} accent="pollinate" />
				</div>
			</section>

			{/* ── AREA 2: the center recall area (038b) — moved VERBATIM, restyled placement only ──── */}
			<section data-area="recall-area" aria-label="Memory search" style={{ marginBottom: 22 }}>
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

				{/* recall results (038b-AC-2/AC-3) */}
				<div style={{ display: "flex", flexDirection: "column", gap: 10 }} key={recallNonce}>
					{results.length === 0
						? recalled && (
								<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No memories matched that query.</div>
							)
						: results.map((m, i) => (
								<div className="mem-enter" style={{ animationDelay: `${i * 55}ms` }} key={m.memoryKey}>
									<MemoryCard {...m} pollinating={pollinating && i === 1} />
								</div>
							))}
				</div>
			</section>

			{/* ── AREA 3: the harness area (038c) — the strip, then the retained 2-col grid + live log ── */}
			<section data-area="harness-area" aria-label="Harnesses and activity">
				{/* The wired-in chips + per-harness KPI tiles + short-tail stream (038c). */}
				<div style={{ marginBottom: 16 }}>
					<HarnessStrip harnesses={harnesses} streamLines={streamLines} />
				</div>

				{/* The existing 2-col grid — kept, reorganized into the zone (parent: retain the panels). */}
				<div className="grid2" style={{ marginBottom: 16 }}>
					<div className="col">
						<SessionsPanel sessions={sessions} />
						<RulesPanel rules={rules} />
					</div>
					<div className="col">
						{/* The codebase-graph canvas is intentionally NOT on the home (the graph memory cap): a real snapshot is
						    tens of thousands of nodes and rendering it here froze the browser. The graph lives on its
						    own bounded, memory-aware `#/graph` page; the home stays light. */}
						<SettingsPanel catalog={vaultSettings.catalog} settings={vaultSettings.settings} secretNames={secretNames} onSave={saveSetting} />
						<SkillSyncPanel skills={skills} />
					</div>
				</div>

				{/* the full live log (AC-4) */}
				<LiveLog lines={feed} />
			</section>
		</>
	);
}
