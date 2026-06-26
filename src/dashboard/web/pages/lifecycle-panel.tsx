/**
 * PRD-058d — the LIFECYCLE HEALTH panel on the Memories page (the operator surface for the four
 * lifecycle engines: recency/activation 058a, conflicts 058b, stale-references 058c, calibration 058e).
 *
 * Renders, off the SHARED `wire` (never `createWireClient`), inside the existing Memories page:
 *   - a store-level HEALTH summary: the aggregate health badge `H`, a freshness read, the open-conflict
 *     count, the stale-ref count, and the calibration ECE (US-55d.2.1);
 *   - the conflict QUEUE with a per-conflict RESOLVE action that calls the 058b
 *     `POST /api/memories/conflicts/:id/resolve` endpoint and POLLS to convergence (US-55d.2.2 —
 *     never a single immediate read-back, the DeepLake eventual-consistency rule);
 *   - the stale-reference list + count (US-55d.2.1);
 *   - the calibration view: the ECE/Brier + a reliability diagram from `GET /api/memories/calibration`
 *     (the 058e introspection payload, US-55d.2.4).
 *
 * It REUSES the PRD-040 memories-page data-fetching (the same `wire`) and the PRD-029 degradation
 * states (loading / empty / degraded). A term whose producing engine is OFF renders as INERT (the
 * honest empty state), NOT as an error — calibration dormant shows "calibration dormant", an empty
 * conflict queue shows "no open conflicts", and the health scalar degrades to the live terms (an
 * install with every engine off reads `H = 1`, not a phantom demotion).
 *
 * Security: every value renders as ESCAPED React text (never `dangerouslySetInnerHTML`); no
 * token/secret rides any list/badge/diagram line (the wire shapes carry none by construction). Every
 * visual value is an existing `var(--…)` DS token.
 */

import React from "react";

import { Badge, Button } from "../primitives.js";
import type {
	CalibrationWire,
	LifecycleConflictWire,
	LifecycleStaleRefWire,
	WireClient,
} from "../wire.js";
import { EMPTY_CALIBRATION } from "../wire.js";

/** The poll-to-convergence budget for a resolve read-back (mirrors the page's re-read recipe). */
const RESOLVE_POLL_ATTEMPTS = 6;
const RESOLVE_POLL_DELAY_MS = 150;

/** Sleep `ms` (the poll-until-convergence delay). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call a lifecycle wire method GUARDED against a thin/older wire that does not implement it: if the
 * method is absent (or throws), degrade to `fallback` rather than crashing the panel. This mirrors the
 * wire layer's "every read degrades to a safe value, never a throw into React" posture so a page that
 * mounts the panel with a non-lifecycle wire (an out-of-scope suite, an older daemon shape) renders the
 * inert state instead of an unhandled rejection. Pure delegation otherwise.
 */
async function readLifecycle<K extends keyof WireClient, T>(
	wire: WireClient,
	method: K,
	fallback: T,
	...args: unknown[]
): Promise<T> {
	const fn = wire[method] as unknown;
	if (typeof fn !== "function") return fallback;
	try {
		return (await (fn as (...a: unknown[]) => Promise<T>).apply(wire, args)) ?? fallback;
	} catch {
		return fallback;
	}
}

/** The shared surface card style (matches the page's panel rhythm). */
const SURFACE: React.CSSProperties = {
	padding: 16,
	background: "var(--bg-surface)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-lg)",
};

/** A muted mono label → value stat tile for the health summary row. */
function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 96 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
				{label}
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{value}</span>
		</div>
	);
}

/** The health badge tone by band: ≥0.66 verified, ≥0.33 honey, else warning. Pure. */
export function healthTone(h: number): "verified" | "honey" | "warning" {
	if (h >= 0.66) return "verified";
	if (h >= 0.33) return "honey";
	return "warning";
}

/**
 * Assemble the store-level health scalar `H = A · C · (1 − σ) · κ` for the BADGE (058d read-side
 * projection). Inputs come from the already-emitted aggregates: `freshness` (A), the calibration
 * `1 − ece` proxy for trust (C — when calibration is dormant, identity 1), the stale-ref fraction
 * (σ), and the open-conflict presence as a soft κ proxy. Each absent/dormant term is its IDENTITY,
 * so the badge degrades to the live terms. Pure; bounded `[0,1]`.
 */
export function assembleStoreHealth(inputs: { freshness?: number; calibrationConfidence?: number; staleness?: number; kappa?: number }): number {
	const clamp = (x: number | undefined, fallback: number): number => {
		if (x === undefined || !Number.isFinite(x)) return fallback;
		return Math.min(1, Math.max(0, x));
	};
	return clamp(inputs.freshness, 1) * clamp(inputs.calibrationConfidence, 1) * (1 - clamp(inputs.staleness, 0)) * clamp(inputs.kappa, 1);
}

/** Props for {@link LifecycleHealthPanel}. */
export interface LifecycleHealthPanelProps {
	/** The shared wire (the page passes its injected `wire`). */
	readonly wire: WireClient;
}

/** One reliability-diagram row rendered as a horizontal bar (predicted vs the diagonal). */
function ReliabilityRow({ lower, upper, accuracy }: { lower: number; upper: number; accuracy: number }): React.JSX.Element {
	const pct = Math.round(Math.min(1, Math.max(0, accuracy)) * 100);
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", minWidth: 64 }}>
				{lower.toFixed(2)}–{upper.toFixed(2)}
			</span>
			<div style={{ flex: 1, height: 8, background: "var(--bg-subtle)", borderRadius: 4, overflow: "hidden" }}>
				<div style={{ width: `${pct}%`, height: "100%", background: "var(--honey)" }} />
			</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)", minWidth: 32, textAlign: "right" }}>{pct}%</span>
		</div>
	);
}

/** The conflict resolve verdict choices the dashboard offers (mirrors the daemon's safe-default order). */
const RESOLVE_VERDICTS = ["review", "supersede", "keep-both"] as const;

/** One conflict row with an inline resolve control (calls the 058b endpoint, polls to convergence). */
function ConflictRow({
	conflict,
	onResolve,
}: {
	conflict: LifecycleConflictWire;
	onResolve: (id: string, verdict: string, winnerId: string) => Promise<void>;
}): React.JSX.Element {
	const [verdict, setVerdict] = React.useState<string>("review");
	const [winner, setWinner] = React.useState<string>(conflict.memoryAId);
	const [busy, setBusy] = React.useState(false);

	const submit = async (): Promise<void> => {
		if (busy) return;
		setBusy(true);
		// supersede REQUIRES a winner (the daemon 400s otherwise); the picker defaults to side A.
		await onResolve(conflict.id, verdict, verdict === "supersede" ? winner : "");
		setBusy(false);
	};

	return (
		<div data-testid="conflict-row" data-conflict-id={conflict.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
				<Badge tone="warning" mono dot>
					{conflict.status || "open"}
				</Badge>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", wordBreak: "break-all" }}>
					{conflict.memoryAId} ⇄ {conflict.memoryBId}
				</span>
			</div>
			<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
				<select aria-label="verdict" value={verdict} onChange={(e) => setVerdict(e.target.value)} style={{ height: 32, padding: "0 8px", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
					{RESOLVE_VERDICTS.map((v) => (
						<option key={v} value={v}>
							{v}
						</option>
					))}
				</select>
				{verdict === "supersede" && (
					<select aria-label="winner" value={winner} onChange={(e) => setWinner(e.target.value)} style={{ height: 32, padding: "0 8px", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 12, maxWidth: 180 }}>
						<option value={conflict.memoryAId}>winner: {conflict.memoryAId}</option>
						<option value={conflict.memoryBId}>winner: {conflict.memoryBId}</option>
					</select>
				)}
				<Button variant="secondary" size="sm" onClick={() => void submit()} disabled={busy}>
					{busy ? "…" : "Resolve"}
				</Button>
			</div>
		</div>
	);
}

/**
 * The Lifecycle HEALTH panel (058d). Hydrates the conflict queue, the stale-ref list, and the
 * calibration introspection on mount; resolves a conflict through the 058b endpoint and POLLS the
 * queue to convergence (the resolved conflict drops out of the `open` list). Every read degrades to
 * an honest empty/inert state on failure (PRD-029), never a throw.
 */
export function LifecycleHealthPanel({ wire }: LifecycleHealthPanelProps): React.JSX.Element {
	const [conflicts, setConflicts] = React.useState<readonly LifecycleConflictWire[]>([]);
	const [staleRefs, setStaleRefs] = React.useState<readonly LifecycleStaleRefWire[]>([]);
	const [calibration, setCalibration] = React.useState<CalibrationWire>(EMPTY_CALIBRATION);
	const [hydrated, setHydrated] = React.useState(false);

	const reloadConflicts = React.useCallback(async (): Promise<LifecycleConflictWire[]> => {
		const rows = await readLifecycle(wire, "lifecycleConflicts", [] as LifecycleConflictWire[], "open");
		setConflicts(rows);
		return rows;
	}, [wire]);

	// US-55d.2.1: hydrate the three lifecycle reads on mount (the same `wire` the page already uses).
	// Each call is GUARDED against a thin/older wire that does not implement the method (degrade to the
	// empty value, never an unhandled rejection — the wire layer's "degrade, never throw" posture).
	React.useEffect(() => {
		let alive = true;
		void (async (): Promise<void> => {
			const [c, s, cal] = await Promise.all([
				readLifecycle(wire, "lifecycleConflicts", [] as LifecycleConflictWire[], "open"),
				readLifecycle(wire, "lifecycleStaleRefs", [] as LifecycleStaleRefWire[]),
				readLifecycle(wire, "calibration", EMPTY_CALIBRATION),
			]);
			if (!alive) return;
			setConflicts(c);
			setStaleRefs(s);
			setCalibration(cal);
			setHydrated(true);
		})();
		return () => {
			alive = false;
		};
	}, [wire]);

	// US-55d.2.2: resolve through the 058b endpoint, then POLL the open queue to convergence (the
	// resolved conflict drops out). Never a single immediate read-back — the DeepLake consistency rule.
	const onResolve = React.useCallback(
		async (id: string, verdict: string, winnerId: string): Promise<void> => {
			const ok = typeof wire.resolveConflict === "function"
				? await wire.resolveConflict(id, { verdict, ...(winnerId !== "" ? { winnerId } : {}) })
				: false;
			if (!ok) {
				// Honest failure: re-read so the row reflects the persisted (unchanged) state, no optimistic drop.
				await reloadConflicts();
				return;
			}
			for (let attempt = 0; attempt < RESOLVE_POLL_ATTEMPTS; attempt += 1) {
				const rows = await reloadConflicts();
				if (!rows.some((c) => c.id === id)) return; // converged: the resolved conflict left the open queue.
				await sleep(RESOLVE_POLL_DELAY_MS);
			}
		},
		[wire, reloadConflicts],
	);

	// The store-level health badge: freshness from the calibration-trust proxy + the stale-ref fraction
	// + the open-conflict κ proxy. Each dormant term is its identity (058d read-side projection).
	const staleness = staleRefs.length > 0 ? Math.min(1, staleRefs.length / Math.max(staleRefs.length, 8)) : 0;
	const calibrationConfidence = calibration.identity ? 1 : Math.max(0, 1 - calibration.ece);
	const kappa = conflicts.length > 0 ? 0.5 : 1;
	const health = assembleStoreHealth({ calibrationConfidence, staleness, kappa });

	return (
		<div data-testid="lifecycle-panel" style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 16 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Memory health</div>
				<Badge tone={healthTone(health)} mono dot>
					<span data-testid="health-badge">H {health.toFixed(2)}</span>
				</Badge>
			</div>

			{/* US-55d.2.1: the store-level health summary row. */}
			<div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
				<Stat label="freshness" value={calibration.identity ? "—" : calibrationConfidence.toFixed(2)} />
				<Stat label="open conflicts" value={String(conflicts.length)} />
				<Stat label="stale refs" value={String(staleRefs.length)} />
				<Stat label="ECE" value={calibration.identity ? "dormant" : calibration.ece.toFixed(3)} />
			</div>

			{/* CONFLICT QUEUE + per-conflict resolve (US-55d.2.2). */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
					Conflicts ({conflicts.length})
				</div>
				{!hydrated ? (
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</span>
				) : conflicts.length === 0 ? (
					<span data-testid="conflicts-empty" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>no open conflicts.</span>
				) : (
					conflicts.map((c) => <ConflictRow key={c.id} conflict={c} onResolve={onResolve} />)
				)}
			</div>

			{/* STALE-REF LIST + count (US-55d.2.1). */}
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
					Stale references ({staleRefs.length})
				</div>
				{!hydrated ? (
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</span>
				) : staleRefs.length === 0 ? (
					<span data-testid="stale-refs-empty" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>no stale references.</span>
				) : (
					staleRefs.map((r) => (
						<div key={r.memoryId} data-testid="stale-ref-row" style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>
							<span style={{ color: "var(--honey)", wordBreak: "break-all" }}>{r.memoryId}</span>
							<span style={{ color: "var(--text-tertiary)" }}>{r.staleRefs.length > 0 ? r.staleRefs.join(", ") : "(refs unrecorded)"}</span>
						</div>
					))
				)}
			</div>

			{/* CALIBRATION view: ECE/Brier + reliability diagram (US-55d.2.4). */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
					Calibration
				</div>
				{calibration.identity ? (
					<span data-testid="calibration-dormant" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
						calibration dormant — confidence weighting (c) stays 0 until the curve is fit.
					</span>
				) : (
					<div data-testid="calibration-view" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
							<Stat label="ECE" value={calibration.ece.toFixed(3)} />
							<Stat label="Brier" value={calibration.brier.toFixed(3)} />
							<Stat label="samples" value={String(calibration.nSamples)} />
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{calibration.reliabilityDiagram.map((b, i) => (
								<ReliabilityRow key={i} lower={b.lower} upper={b.upper} accuracy={b.accuracy} />
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
