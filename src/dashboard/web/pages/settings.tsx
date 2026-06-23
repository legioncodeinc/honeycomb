/**
 * The SETTINGS page — PRD-044 (the 7th and final page of the dashboard mini-site).
 *
 * Mounted at the PRD-037 `#/settings` slot (the registry already routes it; this fills the
 * `ComingSoon` placeholder). ONE coherent page, THREE sections over the INJECTED `wire` (never
 * `createWireClient`), all on the existing DS tokens + primitives (`Badge`/`Button`/`Input`/
 * `Panel`/`PageFrame`) — NO new design system, NO CDN React, NO in-browser Babel. Every value
 * renders as escaped React text (XSS-safe; never `dangerouslySetInnerHTML`). No token/secret value
 * EVER appears in page state, the DOM, a parsed response, or a log line (D-3 / D-6).
 *
 *   044a — DeepLake auth (SECURITY-CRITICAL, the token is SACRED):
 *     · `DeeplakeAuthSection` reads the REDACTED `wire.authStatus()` (`GET /api/auth/status`) and
 *       renders it TRUTHFULLY: connected org/workspace/agent, the credentials SOURCE
 *       (`env` "via HONEYCOMB_TOKEN" vs `file`), `savedAt`, and expiry ONLY when a real
 *       `expiresAt` exists (else "expiry unknown" — never fabricated). Disconnected → an honest
 *       "Not connected to DeepLake" state. OQ-1 RESOLVED: STATUS-FIRST + a CLI hand-off (the exact
 *       `honeycomb login` commands) — NO in-page device-flow, NO mock success. The section RE-READS
 *       `authStatus()` on a focus/poll so a CLI login reflects here. The token is never rendered.
 *
 *   044b — provider API keys (write-only into the encrypted vault):
 *     · `ProviderKeysSection` renders one row per provider (Anthropic, OpenAI, OpenRouter, Cohere):
 *       a password-type write-only `Input`, a "Save key" `Button`, and a presence `Badge`. A save
 *       POSTs `wire.setSecret(name, value)` (`POST /api/secrets/:name`); presence comes from
 *       `wire.secretNames()` (NAMES only — there is NO value-returning route, ever). On success the
 *       input is CLEARED and `secretNames()` is RE-READ. A secret value never enters page state,
 *       the DOM, the response, or a log line (AC-3 write-only discipline).
 *
 *   044c — search mode + migrated inference settings:
 *     · `SearchAndInferenceSection` renders a NEW recall-mode `Select` (`keyword | semantic |
 *       hybrid` + a "default" option that leaves the `recallMode` key UNSET) PLUS the MIGRATED
 *       provider→model selector + pollinating toggle (the existing `SettingsPanel`, REUSED not forked
 *       — D-5). All persist through the EXISTING `vaultSettings()`/`setSetting()` surface
 *       (persist-then-re-read); `recallMode` adds NO new wire method.
 */

import React from "react";

import { Badge, Button, Input } from "../primitives.js";
import { Panel, PROVIDER_KEY_NAME, SETTING_KEY, SettingsPanel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { PageFrame } from "../page-frame.js";
import {
	DISCONNECTED_AUTH_STATUS,
	EMPTY_VAULT_SETTINGS,
	type AuthStatusWire,
	type SettingValueWire,
	type VaultSettingsWire,
} from "../wire.js";

/** How often the auth section re-reads `authStatus()` so a CLI login reflects here (ms). */
const AUTH_POLL_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// A shared section shell — a titled Panel with consistent rhythm across the three
// sections (jscpd discipline: one wrapper, not three copies of the same markup).
// ─────────────────────────────────────────────────────────────────────────────

/** One labeled metadata row (a left label + a right value) — shared by the auth section. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", minWidth: 120 }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-word" }}>
				{children}
			</span>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044a — the DeepLake auth section (status-first + CLI hand-off; token is sacred).
// ─────────────────────────────────────────────────────────────────────────────

/** Human label for the credentials source (`env` → "via HONEYCOMB_TOKEN", honest about the env win). */
function sourceLabel(source: AuthStatusWire["source"]): string {
	if (source === "env") return "via HONEYCOMB_TOKEN";
	if (source === "file") return "saved login (~/.deeplake)";
	return "none";
}

/** Render a token-expiry value HONESTLY: a real `expiresAt` as an ISO instant, else "expiry unknown". */
function expiryLabel(expiresAt: number | undefined): string {
	// `expiresAt` is epoch SECONDS (a real `TokenClaims.exp`); absent → never computed/faked.
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "expiry unknown";
	return new Date(expiresAt * 1000).toISOString();
}

/**
 * The connect affordance (OQ-1 RESOLVED — CLI hand-off, NO in-page device-flow). Shows the exact
 * commands a user runs to connect; the section re-reads `authStatus()` on its poll so the login
 * reflects here. There is NO mock/fabricated success path — connecting happens in the CLI.
 */
function ConnectHandoff(): React.JSX.Element {
	return (
		<div data-testid="auth-connect" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 6px" }}>
			<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Connect to DeepLake from your terminal, then this page reflects it:</span>
			<code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--honey)" }}>honeycomb login</code>
			<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>or, headless (CI / a server):</span>
			<code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--honey)" }}>HONEYCOMB_TOKEN=… honeycomb …</code>
		</div>
	);
}

/**
 * The DeepLake auth section (044a). Reads the REDACTED `authStatus()` and renders it truthfully —
 * connected identity + source + expiry-when-known, or an honest disconnected state with the CLI
 * hand-off. RE-READS on a poll so a CLI `honeycomb login` reflects here. The token is NEVER
 * rendered (the wire schema has no token field by construction).
 */
export function DeeplakeAuthSection({ wire }: { wire: PageProps["wire"] }): React.JSX.Element {
	const [status, setStatus] = React.useState<AuthStatusWire>(DISCONNECTED_AUTH_STATUS);
	const [loading, setLoading] = React.useState(true);

	const load = React.useCallback(async (): Promise<void> => {
		// `authStatus()` never throws — it degrades to DISCONNECTED on any failure (AC-4).
		const next = await wire.authStatus();
		setStatus(next);
		setLoading(false);
	}, [wire]);

	// Fetch on mount + re-read on a poll (so a CLI login reflects here) + on window focus.
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive) return;
			await load();
		};
		void tick();
		const id = setInterval(() => void tick(), AUTH_POLL_MS);
		const onFocus = (): void => void tick();
		if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
		return () => {
			alive = false;
			clearInterval(id);
			if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
		};
	}, [load]);

	return (
		<Panel
			title="DeepLake"
			eyebrow="auth · org · workspace"
			right={
				<Badge tone={status.connected ? "verified" : "neutral"} mono dot>
					{status.connected ? "connected" : "not connected"}
				</Badge>
			}
		>
			{loading ? (
				<div data-testid="auth-loading" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
					loading…
				</div>
			) : status.connected ? (
				<div data-testid="auth-connected">
					<MetaRow label="org">{status.orgName || status.orgId || "—"}</MetaRow>
					<MetaRow label="org id">{status.orgId || "—"}</MetaRow>
					<MetaRow label="workspace">{status.workspace || "—"}</MetaRow>
					<MetaRow label="agent">{status.agentId || "—"}</MetaRow>
					<MetaRow label="source">{sourceLabel(status.source)}</MetaRow>
					<MetaRow label="last login">{status.savedAt || "unknown"}</MetaRow>
					<MetaRow label="token expiry">{expiryLabel(status.expiresAt)}</MetaRow>
				</div>
			) : (
				<div data-testid="auth-disconnected">
					<div style={{ padding: "8px 6px", fontSize: 14, color: "var(--text-primary)" }}>Not connected to DeepLake.</div>
					<ConnectHandoff />
				</div>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044b — the provider API keys section (write-only into the encrypted vault).
// ─────────────────────────────────────────────────────────────────────────────

/** The four providers this section manages, in display order (label + the conventional key name). */
const PROVIDER_ROWS: readonly { id: string; label: string }[] = [
	{ id: "anthropic", label: "Anthropic (Claude)" },
	{ id: "openai", label: "OpenAI (ChatGPT)" },
	{ id: "openrouter", label: "OpenRouter" },
	{ id: "cohere", label: "Cohere" },
];

/**
 * One provider key row (044b): a label, a write-only password `Input`, a "Save key" `Button`, and
 * a presence `Badge`. The input value lives in a LOCAL draft that is CLEARED on a successful save
 * (never pre-filled — there is no value to fetch). An empty value is rejected client-side BEFORE
 * the POST. The secret value never leaves this row's draft state, never enters the parsed response
 * (the wire returns a boolean), and is never logged.
 */
function ProviderKeyRow({
	id,
	label,
	present,
	onSave,
}: {
	id: string;
	label: string;
	present: boolean;
	onSave: (id: string, value: string) => Promise<boolean>;
}): React.JSX.Element {
	const [draft, setDraft] = React.useState("");
	const [saving, setSaving] = React.useState(false);
	const [rejected, setRejected] = React.useState(false);

	const submit = React.useCallback(async (): Promise<void> => {
		const value = draft;
		// Client-side empty-value reject BEFORE the POST (AC-1) — an empty key is never sent.
		if (value.length === 0) {
			setRejected(true);
			return;
		}
		setSaving(true);
		setRejected(false);
		const ok = await onSave(id, value);
		setSaving(false);
		// Write-only discipline (AC-3): CLEAR the input on a successful save (no lingering value in
		// state), leave it for a retry on a rejected write. Either way the value is never echoed.
		if (ok) {
			setDraft("");
		} else {
			setRejected(true);
		}
	}, [draft, id, onSave]);

	return (
		<div
			data-testid={`provider-row-${id}`}
			style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", borderTop: "1px solid var(--border-subtle)", flexWrap: "wrap" }}
		>
			<span style={{ fontSize: 14, color: "var(--text-primary)", minWidth: 150 }}>{label}</span>
			<div style={{ flex: "1 1 220px", minWidth: 180 }}>
				<Input
					type="password"
					mono
					size="sm"
					value={draft}
					placeholder={present ? "replace key…" : "paste key…"}
					onChange={(e) => {
						setDraft(e.target.value);
						if (rejected) setRejected(false);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit();
					}}
					data-testid={`provider-input-${id}`}
				/>
			</div>
			<Button variant="primary" size="sm" disabled={saving} data-testid={`provider-save-${id}`} onClick={() => void submit()}>
				{saving ? "saving…" : "Save key"}
			</Button>
			<Badge tone={present ? "verified" : "neutral"} mono dot>
				{present ? "key set ✓" : "not set"}
			</Badge>
			{rejected && (
				<span data-testid={`provider-rejected-${id}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-critical)" }}>
					not accepted
				</span>
			)}
		</div>
	);
}

/**
 * The provider API keys section (044b). One row per provider (Anthropic, OpenAI, OpenRouter,
 * Cohere). A save POSTs `setSecret(name, value)` then RE-READS `secretNames()` so the presence
 * badge reflects the persisted truth (mirroring the `setSetting` re-read). There is NO `getSecret`
 * — a stored key cannot be read back. The presence is by NAME only (`PROVIDER_KEY_NAME`).
 */
export function ProviderKeysSection({
	wire,
	secretNames,
	onSaved,
}: {
	wire: PageProps["wire"];
	secretNames: readonly string[];
	onSaved: () => void;
}): React.JSX.Element {
	// The single write path: POST the value (write-only), then re-read names on success so the
	// parent's `secretNames` (and thus the presence badge) reflects the persisted truth. The value
	// is consumed here and never returned/stored beyond the row's draft (which clears on success).
	const onSave = React.useCallback(
		async (id: string, value: string): Promise<boolean> => {
			const keyName = PROVIDER_KEY_NAME[id];
			if (keyName === undefined) return false;
			const ok = await wire.setSecret(keyName, value);
			if (ok) onSaved(); // re-read secretNames (presence) — mirrors saveSetting's re-read.
			return ok;
		},
		[wire, onSaved],
	);

	return (
		<Panel title="Provider keys" eyebrow="write-only · names-only presence">
			<div data-testid="provider-keys">
				{PROVIDER_ROWS.map((p) => {
					const keyName = PROVIDER_KEY_NAME[p.id] ?? "";
					const present = keyName !== "" && secretNames.includes(keyName);
					return <ProviderKeyRow key={p.id} id={p.id} label={p.label} present={present} onSave={onSave} />;
				})}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 044c — the search mode + migrated inference settings section.
// ─────────────────────────────────────────────────────────────────────────────

/** The recall-mode options: a "default" (unset) plus the three explicit modes (044c). */
const RECALL_MODE_OPTIONS: readonly { value: string; label: string }[] = [
	{ value: "", label: "default (semantic when embeddings on)" },
	{ value: "keyword", label: "keyword — lexical only" },
	{ value: "semantic", label: "semantic — vector (fallback when off)" },
	{ value: "hybrid", label: "hybrid — both arms" },
];

/**
 * The recall-mode selector (044c). A controlled `<select>` whose value is the persisted
 * `recallMode` setting (or "" for the "default" option, which leaves the key UNSET — preserving the
 * PRD-025 runtime default). Choosing a value persists through the EXISTING `setSetting` (no new
 * wire method); the daemon REJECTS any value outside `keyword | semantic | hybrid` (fail-closed).
 */
function RecallModeRow({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", flexWrap: "wrap" }}>
			<div style={{ display: "flex", flexDirection: "column", minWidth: 120 }}>
				<span style={{ fontSize: 14, color: "var(--text-primary)" }}>Search mode</span>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>recall channels</span>
			</div>
			<span style={{ flex: 1 }} />
			<select
				aria-label="search mode"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				data-testid="recall-mode-select"
				style={{
					height: 36,
					padding: "0 10px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-md)",
					color: "var(--text-primary)",
					fontFamily: "var(--font-mono)",
					fontSize: 13,
					minWidth: 220,
				}}
			>
				{RECALL_MODE_OPTIONS.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</div>
	);
}

/**
 * The search-mode + inference section (044c). Composes the NEW recall-mode selector with the
 * MIGRATED provider/model/pollinating controls (the existing `SettingsPanel`, REUSED verbatim — D-5).
 * Everything persists through the SAME `vaultSettings()`/`setSetting()` surface with a persist-then
 * re-read contract; `recallMode` adds no new wire method.
 */
export function SearchAndInferenceSection({
	settings,
	catalog,
	secretNames,
	onSave,
}: {
	settings: Readonly<Record<string, SettingValueWire>>;
	catalog: VaultSettingsWire["catalog"];
	secretNames: readonly string[];
	onSave: (key: string, value: SettingValueWire) => Promise<boolean>;
}): React.JSX.Element {
	// The persisted recall mode (controlled). The "default" option maps to "" → the key stays UNSET
	// (preserving the PRD-025 runtime decision). String() defends against a non-string scalar.
	const recallMode = String(settings[SETTING_KEY.recallMode] ?? "");

	return (
		<Panel title="Search & inference" eyebrow="recall mode · provider · model · pollinating">
			<div data-testid="search-inference">
				<RecallModeRow value={recallMode} onChange={(v) => void onSave(SETTING_KEY.recallMode, v)} />
				{/* The MIGRATED provider/model/pollinating panel — REUSED, not forked (D-5). It carries its
				    own Panel shell, so it nests cleanly below the recall-mode row. */}
				<div style={{ marginTop: 8 }}>
					<SettingsPanel catalog={catalog} settings={settings} secretNames={secretNames} onSave={onSave} />
				</div>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Settings page (PRD-044). Hydrates the vault settings + secret-name presence over the shared
 * `wire`, and renders the THREE sections: DeepLake auth (044a), provider keys (044b), and search
 * mode + inference (044c). Every setting/secret write goes through the wire with a persist-then
 * re-read contract — the page never trusts a local-only toggle. NO token/secret value crosses into
 * page state, the DOM, a response, or a log line.
 */
export function SettingsPage({ wire }: PageProps): React.JSX.Element {
	const [vault, setVault] = React.useState<VaultSettingsWire>(EMPTY_VAULT_SETTINGS);
	const [secretNames, setSecretNames] = React.useState<readonly string[]>([]);

	// Hydrate the vault settings + the names-only secret presence (both already-served, secret-free).
	const hydrateSettings = React.useCallback(async (): Promise<void> => {
		setVault(await wire.vaultSettings());
	}, [wire]);
	const hydrateSecretNames = React.useCallback(async (): Promise<void> => {
		setSecretNames(await wire.secretNames());
	}, [wire]);

	React.useEffect(() => {
		void hydrateSettings();
		void hydrateSecretNames();
	}, [hydrateSettings, hydrateSecretNames]);

	// Persist one setting then RE-READ so the rendered value is the PERSISTED vault value, never a
	// local-only optimistic toggle (mirrors the dashboard `SettingsPanel` contract). A rejected
	// write (the daemon fail-closes an invalid `recallMode`/model) leaves the persisted value
	// unchanged — the re-read reflects whatever actually persisted.
	const onSaveSetting = React.useCallback(
		async (key: string, value: SettingValueWire): Promise<boolean> => {
			const ok = await wire.setSetting(key, value);
			await hydrateSettings();
			return ok;
		},
		[wire, hydrateSettings],
	);

	return (
		<PageFrame title="Settings" eyebrow="deeplake · provider keys · search mode">
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<DeeplakeAuthSection wire={wire} />
				<ProviderKeysSection wire={wire} secretNames={secretNames} onSaved={() => void hydrateSecretNames()} />
				<SearchAndInferenceSection settings={vault.settings} catalog={vault.catalog} secretNames={secretNames} onSave={onSaveSetting} />
			</div>
		</PageFrame>
	);
}
