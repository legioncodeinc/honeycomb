/**
 * Discord source provider — PRD-013d (Wave 2 fill).
 *
 * 013a shipped the SEAM conformance (an honest {@link SourceProvider} whose ingest
 * methods fail loud with the owning sub-PRD). 013d fills the body behind the SAME
 * {@link SourceArtifact} contract — provider-specific Discord code (REST pulls,
 * gateway tail, desktop-cache reads, snapshot export) lives ONLY here, upstream of
 * the provider-agnostic lifecycle engine. The provider READS Discord; it NEVER
 * writes back, and `close()` tears down the gateway on purge (d-AC-4).
 *
 * ── Two shapes of `createDiscordProvider`, one stable signature ──────────────
 * `createDiscordProvider()` (NO config) returns the loud-fail STUB the Wave-1
 * seam-conformance test pins (kind 'discord', `unreachable` health, `index()`
 * throws `/013d/`). `createDiscordProvider(config, transport?)` returns the REAL
 * provider driven by a {@link DiscordTransport} (REST + gateway + desktop-cache +
 * snapshot). There are NO Discord creds in this env, so the transport is a SEAM:
 * production injects a network transport, tests inject a scripted fake. The
 * provider holds ZERO `fetch`/`ws` of its own — every byte crosses the seam.
 *
 * ── What 013d owns (the d-AC contract) ──────────────────────────────────────
 *   - d-AC-1: REST → guilds/channels/threads/members/per-message artifacts with a
 *             LATEST checkpoint (refresh forward) + a BACKFILL checkpoint (page
 *             older, within bounds). Provenance quartet on every artifact.
 *   - d-AC-2: any mode partial fail → `failure` artifacts (NOT an exception that
 *             aborts the run) + reported; the lifecycle writes them alongside the
 *             corpus and NEVER deletes a previously-indexed row.
 *   - d-AC-3: gateway-tail create/update/delete → indexed against a PER-CHANNEL
 *             tail checkpoint (the checkpoint advances per channel).
 *   - d-AC-4: source removed in gateway-tail → purge CLOSES the gateway connection
 *             (`close()` tears down the held {@link GatewayConnection}).
 *   - d-AC-5: desktop-cache eviction → previously-indexed rows REMAIN (eviction is
 *             not a deletion — the provider emits NO removals on eviction).
 *   - d-AC-6: snapshot export with DEFAULTS → local `@me` DMs are EXCLUDED.
 */

import type {
	IndexScope,
	Provenance,
	ProviderHealth,
	SourceArtifact,
	SourceConfig,
	SourceProvider,
} from "../contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// The synthetic `@me` guild — local-only DMs live under it (FR-3). It is EXCLUDED
// from a snapshot export by default (d-AC-6 / FR-6). A single source-of-truth id so
// the desktop-cache read + the snapshot filter + the test all read the same literal.
// ────────────────────────────────────────────────────────────────────────────

/** The synthetic guild id local-only DMs are mounted under (FR-3 / d-AC-6). */
export const AT_ME_GUILD_ID = "@me" as const;

// ────────────────────────────────────────────────────────────────────────────
// The Discord wire shapes the transport returns. Deliberately minimal — only the
// fields the provider maps onto a {@link SourceArtifact}. The transport adapts the
// real Discord REST/gateway payloads (or a desktop-cache file) onto these.
// ────────────────────────────────────────────────────────────────────────────

/** A Discord guild (server) — the source root for its channels. */
export interface DiscordGuild {
	/** The guild snowflake id. */
	readonly id: string;
	/** The guild's display name. */
	readonly name: string;
}

/** A Discord channel or thread within a guild. */
export interface DiscordChannel {
	/** The channel/thread snowflake id. */
	readonly id: string;
	/** The owning guild id (`@me` for local DMs). */
	readonly guildId: string;
	/** The channel/thread name. */
	readonly name: string;
	/** True when this is a thread (a child of a parent channel). */
	readonly isThread?: boolean;
	/** The parent channel id when this is a thread. */
	readonly parentId?: string;
}

/** A guild member (indexed as a roster artifact, FR-1). */
export interface DiscordMember {
	/** The user snowflake id. */
	readonly id: string;
	/** The owning guild id. */
	readonly guildId: string;
	/** The member's display name. */
	readonly displayName: string;
}

/** A Discord message — the primary evidence unit (FR-4). */
export interface DiscordMessage {
	/** The message snowflake id (monotonic → checkpoint cursor). */
	readonly id: string;
	/** The owning channel/thread id. */
	readonly channelId: string;
	/** The owning guild id (`@me` for local DMs). */
	readonly guildId: string;
	/** The author's display name. */
	readonly author: string;
	/** The message body text (the keyword-searchable evidence). */
	readonly content: string;
	/** ISO timestamp the message was created. */
	readonly timestamp: string;
	/** True when the event is a deletion (gateway delete event). */
	readonly deleted?: boolean;
	/** True when the event is an edit (gateway update event). */
	readonly edited?: boolean;
}

/** A page of messages with a cursor for the next REST request (d-AC-1). */
export interface MessagePage {
	/** The messages on this page (newest-first per Discord REST). */
	readonly messages: readonly DiscordMessage[];
	/** True when older messages remain before this page (backfill not exhausted). */
	readonly hasMoreBefore: boolean;
}

/** A query for a page of channel messages (REST pagination — d-AC-1). */
export interface MessageQuery {
	/** Fetch messages strictly AFTER this id (forward refresh from latest). */
	readonly after?: string;
	/** Fetch messages strictly BEFORE this id (backfill older). */
	readonly before?: string;
	/** Max messages to return (REST page bound). */
	readonly limit: number;
}

/** A gateway event the live tail delivers (d-AC-3). */
export interface GatewayEvent {
	/** The event kind. */
	readonly type: "create" | "update" | "delete";
	/** The message the event concerns. */
	readonly message: DiscordMessage;
}

/** A live gateway connection (d-AC-3/d-AC-4). `close()` tears it down on purge. */
export interface GatewayConnection {
	/** Tear down the connection (called by the provider's `close()` — d-AC-4). */
	close(): Promise<void>;
}

/** Handlers the provider registers on the gateway (one per event). */
export interface GatewayHandlers {
	/** Invoked for each delivered create/update/delete event. */
	onEvent(event: GatewayEvent): void;
}

// ────────────────────────────────────────────────────────────────────────────
// DiscordTransport — THE seam (REST + gateway + desktop-cache + snapshot). All
// provider-specific I/O crosses HERE. Production injects a network-backed transport;
// tests inject a scripted fake. A method MAY throw / return a `failure` field to
// model a partial fetch failure; the provider turns that into a FAILURE ARTIFACT
// (d-AC-2), never letting it abort the whole run.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A partial-failure marker the transport can attach to a unit it could not fetch
 * (d-AC-2). When present, the provider yields a FAILURE artifact for that unit and
 * keeps scanning — it never throws out of the index loop.
 */
export interface TransportFailure {
	/** The path of the unit that failed (e.g. a channel ref). */
	readonly path: string;
	/** Human-readable failure reason. */
	readonly reason: string;
	/** Optional structured detail (status code, …). */
	readonly detail?: Record<string, unknown>;
}

/** A channel-message result that may carry a per-channel partial failure (d-AC-2). */
export interface ChannelMessages {
	/** The page of messages (empty when the channel failed). */
	readonly page: MessagePage;
	/** Set when this channel's fetch partially failed (d-AC-2). */
	readonly failure?: TransportFailure;
}

/**
 * THE Discord transport seam. Every Discord byte the provider reads crosses one of
 * these methods. The provider holds no network client of its own — so the whole
 * provider is testable against a scripted fake with NO real network.
 *
 * REST methods (d-AC-1): `listGuilds`/`listChannels`/`listThreads`/`listMembers`
 * enumerate topology; `fetchMessages` pages a channel with after/before cursors.
 * Gateway (d-AC-3/4): `openGateway` returns a {@link GatewayConnection} the provider
 * closes on purge. Desktop-cache (d-AC-5): `readDesktopCache` returns the locally
 * cached messages with no bot token. Snapshot (d-AC-6): `exportSnapshot` returns the
 * artifacts to export.
 */
export interface DiscordTransport {
	/** REST: enumerate the guilds the token can see (d-AC-1). */
	listGuilds(): Promise<readonly DiscordGuild[]>;
	/** REST: enumerate a guild's channels (d-AC-1). */
	listChannels(guildId: string): Promise<readonly DiscordChannel[]>;
	/** REST: enumerate a channel's threads (d-AC-1). */
	listThreads(channelId: string): Promise<readonly DiscordChannel[]>;
	/** REST: enumerate a guild's members (d-AC-1). */
	listMembers(guildId: string): Promise<readonly DiscordMember[]>;
	/** REST: page a channel's messages with after/before cursors (d-AC-1 / d-AC-2). */
	fetchMessages(channelId: string, query: MessageQuery): Promise<ChannelMessages>;
	/** Gateway: open the live tail; the provider closes it on purge (d-AC-3/4). */
	openGateway(handlers: GatewayHandlers): Promise<GatewayConnection>;
	/** Desktop-cache: read locally cached messages, no bot token (d-AC-5). */
	readDesktopCache(): Promise<readonly DiscordMessage[]>;
	/** Snapshot: the artifacts to export (the provider applies the `@me` filter, d-AC-6). */
	exportSnapshot(): Promise<readonly DiscordMessage[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider config (read out of SourceConfig.settings). The mode + bounds + per-
// channel tail checkpoints + the snapshot `@me` policy live here.
// ────────────────────────────────────────────────────────────────────────────

/** The Discord sync mode (FR-1/2/3). */
export type DiscordMode = "rest" | "gateway-tail" | "desktop-cache";

/** A per-channel REST checkpoint pair: forward-refresh `latest` + `backfill` floor. */
export interface ChannelCheckpoint {
	/** The newest message id indexed — refresh fetches strictly AFTER it (d-AC-1). */
	readonly latest?: string;
	/** The oldest message id indexed — backfill pages strictly BEFORE it (d-AC-1). */
	readonly backfill?: string;
}

/** The resolved Discord provider config (parsed from `SourceConfig.settings`). */
export interface DiscordProviderConfig {
	/** The org the source is mounted into. */
	readonly org: string;
	/** The workspace the source is mounted into. */
	readonly workspace: string;
	/** The source id (the purge key — every artifact's provenance carries it). */
	readonly sourceId: string;
	/** The source root (the guild / `@me` anchor `sourcePath` is relative to). */
	readonly root: string;
	/** The sync mode (d-AC-1/3/5). */
	readonly mode: DiscordMode;
	/** REST backfill bound: max older messages to page per channel (d-AC-1). */
	readonly backfillLimit: number;
	/** REST page size per request. */
	readonly pageSize: number;
	/** Seed per-channel checkpoints (channelId → latest/backfill cursors, d-AC-1). */
	readonly checkpoints: Readonly<Record<string, ChannelCheckpoint>>;
	/** Exclude local `@me` DMs from a snapshot export (default true — d-AC-6). */
	readonly excludeAtMeDmsOnExport: boolean;
}

/** Read a string out of a settings blob, or the fallback. */
function settingsStr(settings: Record<string, unknown>, key: string, fallback: string): string {
	const v = settings[key];
	return typeof v === "string" && v !== "" ? v : fallback;
}

/** Read a positive integer out of a settings blob, or the fallback. */
function settingsInt(settings: Record<string, unknown>, key: string, fallback: number): number {
	const v = settings[key];
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Read a boolean out of a settings blob, or the fallback. */
function settingsBool(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const v = settings[key];
	return typeof v === "boolean" ? v : fallback;
}

/** Narrow a free-form mode string to a {@link DiscordMode}, defaulting to `rest`. */
function asMode(value: string): DiscordMode {
	return value === "gateway-tail" || value === "desktop-cache" ? value : "rest";
}

/** Read a per-channel checkpoint map out of `settings.checkpoints` (best-effort). */
function readCheckpoints(settings: Record<string, unknown>): Record<string, ChannelCheckpoint> {
	const raw = settings.checkpoints;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, ChannelCheckpoint> = {};
	for (const [channelId, cp] of Object.entries(raw as Record<string, unknown>)) {
		if (cp === null || typeof cp !== "object" || Array.isArray(cp)) continue;
		const c = cp as Record<string, unknown>;
		const latest = typeof c.latest === "string" ? c.latest : undefined;
		const backfill = typeof c.backfill === "string" ? c.backfill : undefined;
		out[channelId] = { latest, backfill };
	}
	return out;
}

/**
 * Resolve the {@link DiscordProviderConfig} from the boundary {@link SourceConfig}.
 * The provider-specific keys live in the schemaless `settings` blob (the contract
 * stays provider-agnostic). `sourceId` is required for provenance/purge; it is read
 * from `settings.sourceId` (the lifecycle injects the registered id there before
 * indexing). Pure.
 */
export function resolveDiscordConfig(config: SourceConfig): DiscordProviderConfig {
	const settings = config.settings;
	const root = config.root !== "" ? config.root : settingsStr(settings, "guildId", AT_ME_GUILD_ID);
	return {
		org: config.org,
		workspace: config.workspace,
		sourceId: settingsStr(settings, "sourceId", ""),
		root,
		mode: asMode(settingsStr(settings, "mode", "rest")),
		backfillLimit: settingsInt(settings, "backfillLimit", 500),
		pageSize: settingsInt(settings, "pageSize", 100),
		checkpoints: readCheckpoints(settings),
		excludeAtMeDmsOnExport: settingsBool(settings, "excludeAtMeDmsOnExport", true),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Provenance + artifact construction. Every derived row carries the quartet + scope
// (a-AC-3); `sourcePath` encodes the guild/channel/message ids so a hit traces back
// to the exact message and a purge is a clean scoped sweep (FR-4).
// ────────────────────────────────────────────────────────────────────────────

/** Build provenance for a unit at `sourcePath` within this source (a-AC-3 / FR-4). */
function provenanceFor(cfg: DiscordProviderConfig, sourcePath: string): Provenance {
	return {
		sourceId: cfg.sourceId,
		sourceKind: "discord",
		sourcePath,
		sourceRoot: cfg.root,
		org: cfg.org,
		workspace: cfg.workspace,
	};
}

/** The `source_path` for a message: `guild/channel/message` (FR-4). */
function messagePath(message: DiscordMessage): string {
	return `${message.guildId}/${message.channelId}/${message.id}`;
}

/** Map a Discord message onto a `message` {@link SourceArtifact} (FR-4). */
function messageArtifact(cfg: DiscordProviderConfig, message: DiscordMessage): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, messagePath(message)),
		kind: "message",
		title: `${message.author} in ${message.channelId}`,
		content: message.content,
		metadata: {
			guildId: message.guildId,
			channelId: message.channelId,
			messageId: message.id,
			author: message.author,
			timestamp: message.timestamp,
		},
	};
}

/** Map a guild onto a topology artifact (FR-1). */
function guildArtifact(cfg: DiscordProviderConfig, guild: DiscordGuild): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, guild.id),
		kind: "artifact",
		title: guild.name,
		content: guild.name,
		metadata: { unit: "guild", guildId: guild.id },
	};
}

/** Map a channel/thread onto a topology artifact (FR-1). */
function channelArtifact(cfg: DiscordProviderConfig, channel: DiscordChannel): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, `${channel.guildId}/${channel.id}`),
		kind: "artifact",
		title: channel.name,
		content: channel.name,
		metadata: {
			unit: channel.isThread === true ? "thread" : "channel",
			guildId: channel.guildId,
			channelId: channel.id,
			parentId: channel.parentId,
		},
	};
}

/** Map a member onto a roster artifact (FR-1). */
function memberArtifact(cfg: DiscordProviderConfig, member: DiscordMember): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, `${member.guildId}/members/${member.id}`),
		kind: "artifact",
		title: member.displayName,
		content: member.displayName,
		metadata: { unit: "member", guildId: member.guildId, userId: member.id },
	};
}

/** Map a transport failure onto a FAILURE {@link SourceArtifact} (d-AC-2). */
function failureArtifact(cfg: DiscordProviderConfig, failure: TransportFailure): SourceArtifact {
	return {
		provenance: provenanceFor(cfg, failure.path),
		kind: "message",
		title: `failed: ${failure.path}`,
		content: "",
		failure: { reason: failure.reason, detail: failure.detail },
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The not-implemented stub (preserves the Wave-1 seam-conformance test). Returned
// when `createDiscordProvider` is called with NO config.
// ────────────────────────────────────────────────────────────────────────────

/** A structured "this lands in 013d" rejection — fails loud, never silent. */
class DiscordNotImplementedError extends Error {
	constructor(method: string) {
		super(`DiscordProvider.${method} lands in PRD-013d (Wave 2) — not implemented`);
		this.name = "DiscordNotImplementedError";
	}
}

/** The loud-fail stub (no config supplied) — the Wave-1 seam-conformance shape. */
function discordStub(): SourceProvider {
	return {
		kind: "discord",
		async connect(_config: SourceConfig): Promise<ProviderHealth> {
			throw new DiscordNotImplementedError("connect");
		},
		index(_scope: IndexScope): AsyncIterable<SourceArtifact> {
			throw new DiscordNotImplementedError("index");
		},
		async health(): Promise<ProviderHealth> {
			return { state: "unreachable", detail: "discord provider not implemented (PRD-013d)" };
		},
		async close(): Promise<void> {
			/* the stub holds nothing */
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The real provider — REST pull + gateway tail + desktop-cache + snapshot. Drives
// the {@link DiscordTransport} seam; holds the gateway connection for `close()`.
// ────────────────────────────────────────────────────────────────────────────

/** The Discord provider with the 013d ingest behaviour exposed for tests. */
export interface DiscordProvider extends SourceProvider {
	/**
	 * Index a single gateway event against the PER-CHANNEL tail checkpoint (d-AC-3).
	 * Advances `tailCheckpoint(channelId)` to the event's message id and yields the
	 * artifact to write (a create/update) — a delete is signalled via `removed`.
	 */
	indexGatewayEvent(event: GatewayEvent): { artifact: SourceArtifact; removed: boolean };
	/** The current per-channel tail checkpoint (the newest id seen on that channel). */
	tailCheckpoint(channelId: string): string | undefined;
	/** Export snapshot artifacts, applying the default `@me` exclusion (d-AC-6). */
	exportSnapshot(): Promise<readonly SourceArtifact[]>;
	/** True once the gateway connection has been torn down (d-AC-4 assertion). */
	gatewayClosed(): boolean;
}

/**
 * Build the REAL Discord provider (d-AC-1..6). It drives the injected
 * {@link DiscordTransport} (REST / gateway / desktop-cache / snapshot) and conforms
 * every emitted unit to {@link SourceArtifact}. It READS Discord — never writes back.
 * `close()` tears down a held gateway connection (d-AC-4).
 */
function realDiscordProvider(cfg: DiscordProviderConfig, transport: DiscordTransport): DiscordProvider {
	// The held gateway connection (gateway-tail mode) — closed on purge (d-AC-4).
	let gateway: GatewayConnection | null = null;
	let gatewayTornDown = false;
	// Per-channel tail checkpoints (d-AC-3): channelId → newest message id indexed.
	const tail = new Map<string, string>();
	// Seed the tail from any configured checkpoints so a re-connect resumes forward.
	for (const [channelId, cp] of Object.entries(cfg.checkpoints)) {
		if (cp.latest !== undefined) tail.set(channelId, cp.latest);
	}

	/**
	 * Index a single gateway event (d-AC-3). The per-channel tail checkpoint ADVANCES
	 * to this event's message id — so a later refresh/reconnect resumes strictly after
	 * it. A delete is reported as `removed: true` (the caller soft-deletes the row via
	 * the lifecycle; the provider never deletes the source).
	 */
	function indexGatewayEvent(event: GatewayEvent): { artifact: SourceArtifact; removed: boolean } {
		const { message } = event;
		tail.set(message.channelId, message.id);
		return { artifact: messageArtifact(cfg, message), removed: event.type === "delete" };
	}

	/**
	 * REST index (d-AC-1): yield topology (guilds/channels/threads/members) then, per
	 * channel, a FORWARD refresh (messages after the latest checkpoint) + a bounded
	 * BACKFILL (messages before the backfill floor). A per-channel partial failure
	 * becomes a FAILURE artifact and the scan CONTINUES (d-AC-2) — never an exception
	 * that aborts the whole run. `scope.since` narrows the forward refresh floor.
	 */
	async function* indexRest(scope: IndexScope): AsyncIterable<SourceArtifact> {
		const guilds = await transport.listGuilds();
		const channelsToScan: DiscordChannel[] = [];

		for (const guild of guilds) {
			yield guildArtifact(cfg, guild);
			for (const member of await transport.listMembers(guild.id)) {
				yield memberArtifact(cfg, member);
			}
			for (const channel of await transport.listChannels(guild.id)) {
				yield channelArtifact(cfg, channel);
				channelsToScan.push(channel);
				for (const thread of await transport.listThreads(channel.id)) {
					yield threadOrChannelArtifact(cfg, thread);
					channelsToScan.push(thread);
				}
			}
		}

		for (const channel of channelsToScan) {
			yield* indexChannelMessages(channel, scope);
		}
	}

	/** A thread/channel artifact (threads are flagged in metadata). */
	function threadOrChannelArtifact(c: DiscordProviderConfig, channel: DiscordChannel): SourceArtifact {
		return channelArtifact(c, channel);
	}

	/**
	 * Forward-refresh + bounded-backfill one channel (d-AC-1). Forward: page strictly
	 * AFTER `max(checkpoint.latest, scope.since)`. Backfill: page strictly BEFORE
	 * `checkpoint.backfill`, bounded by `cfg.backfillLimit`. A partial failure on
	 * either leg yields a FAILURE artifact and stops THIS channel (d-AC-2) — the run
	 * continues with the next channel.
	 */
	async function* indexChannelMessages(channel: DiscordChannel, scope: IndexScope): AsyncIterable<SourceArtifact> {
		const cp = cfg.checkpoints[channel.id] ?? {};
		const forwardFloor = maxId(cp.latest, scope.since);

		// FORWARD refresh: newest-first pages, strictly AFTER the latest checkpoint.
		// Only runs when a forward floor EXISTS (a prior `latest` checkpoint or a
		// `scope.since`): "refresh forward from the latest checkpoint" presupposes one.
		// A fresh channel (no checkpoint) is populated by the BACKFILL leg below — the
		// forward leg would otherwise re-pull the whole unbounded history (the d-AC-1
		// bound belongs to backfill).
		if (forwardFloor !== undefined) {
			let after = forwardFloor;
			let forwardGuard = 0;
			for (;;) {
				const result = await transport.fetchMessages(channel.id, { after, limit: cfg.pageSize });
				if (result.failure !== undefined) {
					yield failureArtifact(cfg, result.failure);
					return; // isolate the failure to this channel; do NOT abort the run.
				}
				const msgs = result.page.messages;
				if (msgs.length === 0) break;
				for (const m of msgs) {
					yield messageArtifact(cfg, m);
					if (greaterId(m.id, tail.get(channel.id))) tail.set(channel.id, m.id);
				}
				// Advance the forward cursor to the newest id on this page.
				after = newestId(msgs);
				if (msgs.length < cfg.pageSize) break;
				if (++forwardGuard > 10000) break; // hard safety bound.
			}
		}

		// BACKFILL: older pages, before the backfill floor, bounded by backfillLimit.
		let before = cp.backfill;
		let backfilled = 0;
		while (backfilled < cfg.backfillLimit) {
			const remaining = cfg.backfillLimit - backfilled;
			const limit = Math.min(cfg.pageSize, remaining);
			const result = await transport.fetchMessages(channel.id, { before, limit });
			if (result.failure !== undefined) {
				yield failureArtifact(cfg, result.failure);
				return;
			}
			const msgs = result.page.messages;
			if (msgs.length === 0) break;
			for (const m of msgs) {
				yield messageArtifact(cfg, m);
				backfilled += 1;
				if (backfilled >= cfg.backfillLimit) break;
			}
			before = oldestId(msgs);
			if (!result.page.hasMoreBefore) break;
		}
	}

	/**
	 * Desktop-cache index (d-AC-5): read the local cache (no bot token) and yield a
	 * message artifact per cached message. Cache EVICTION is NOT a deletion — the
	 * provider emits NO removals here; a row indexed from an earlier, fuller cache
	 * simply is not re-yielded, and the lifecycle leaves it intact. Local DMs sit
	 * under the synthetic `@me` guild.
	 */
	async function* indexDesktopCache(): AsyncIterable<SourceArtifact> {
		const cached = await transport.readDesktopCache();
		for (const m of cached) {
			yield messageArtifact(cfg, m);
		}
		// NOTE: no removal/soft-delete is ever emitted on a cache miss — eviction
		// keeps previously-indexed rows (d-AC-5).
	}

	/**
	 * Snapshot export (d-AC-6): the artifacts to back up / move. By DEFAULT, local
	 * `@me` DMs are EXCLUDED (`excludeAtMeDmsOnExport`). A transport-level failure on
	 * the export becomes a FAILURE artifact rather than aborting.
	 */
	async function exportSnapshot(): Promise<readonly SourceArtifact[]> {
		const messages = await transport.exportSnapshot();
		const out: SourceArtifact[] = [];
		for (const m of messages) {
			if (cfg.excludeAtMeDmsOnExport && m.guildId === AT_ME_GUILD_ID) continue; // d-AC-6
			out.push(messageArtifact(cfg, m));
		}
		return out;
	}

	return {
		kind: "discord",

		async connect(config: SourceConfig): Promise<ProviderHealth> {
			// Open the gateway only in gateway-tail mode; REST/desktop-cache hold no
			// long-lived connection. Idempotent: a second connect reuses the gateway.
			const resolved = resolveDiscordConfig(config);
			if (resolved.mode === "gateway-tail" && gateway === null && !gatewayTornDown) {
				gateway = await transport.openGateway({
					onEvent: (event) => {
						// Advance the per-channel tail as events arrive (d-AC-3). The
						// lifecycle writes the artifact; the provider tracks the checkpoint.
						indexGatewayEvent(event);
					},
				});
			}
			return { state: "connected" };
		},

		index(scope: IndexScope): AsyncIterable<SourceArtifact> {
			// Dispatch on mode. Gateway-tail's evidence arrives via events (indexed by
			// `indexGatewayEvent`), so a one-shot `index()` over it yields nothing new;
			// the held connection is the source of truth.
			if (cfg.mode === "desktop-cache") return indexDesktopCache();
			if (cfg.mode === "gateway-tail") return emptyAsyncIterable();
			return indexRest(scope);
		},

		async health(): Promise<ProviderHealth> {
			if (cfg.mode === "gateway-tail" && gateway === null && !gatewayTornDown) {
				return { state: "degraded", detail: "gateway not connected" };
			}
			return { state: "connected" };
		},

		async close(): Promise<void> {
			// d-AC-4: tear down the held gateway connection on purge. Idempotent.
			if (gateway !== null) {
				await gateway.close();
				gateway = null;
			}
			gatewayTornDown = true;
		},

		indexGatewayEvent,
		tailCheckpoint: (channelId: string) => tail.get(channelId),
		exportSnapshot,
		gatewayClosed: () => gatewayTornDown,
	};
}

/** An empty async iterable (gateway-tail's one-shot index yields nothing new). */
async function* emptyAsyncIterable(): AsyncIterable<SourceArtifact> {
	// intentionally yields nothing
}

// ── snowflake id ordering (Discord ids are monotonic decimal strings) ──────────

/** Compare two decimal snowflake id strings; true when `a` > `b`. */
function greaterId(a: string, b: string | undefined): boolean {
	if (b === undefined || b === "") return true;
	if (a.length !== b.length) return a.length > b.length;
	return a > b;
}

/** The larger of two optional ids (the forward-refresh floor). */
function maxId(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return greaterId(a, b) ? a : b;
}

/** The newest (largest) id in a page of messages. */
function newestId(messages: readonly DiscordMessage[]): string {
	return messages.reduce((best, m) => (greaterId(m.id, best) ? m.id : best), messages[0].id);
}

/** The oldest (smallest) id in a page of messages. */
function oldestId(messages: readonly DiscordMessage[]): string {
	return messages.reduce((best, m) => (greaterId(best, m.id) ? m.id : best), messages[0].id);
}

// ────────────────────────────────────────────────────────────────────────────
// The factory — the stable export. No config → the loud-fail stub (Wave-1 shape).
// A config → the real provider (transport defaults to a not-yet-wired network seam;
// tests inject a fake). The signature stays `createDiscordProvider(config?, …)`.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the Discord provider (PRD-013d). Two shapes behind one stable signature:
 *
 *   - `createDiscordProvider()` — NO config → the loud-fail STUB (kind 'discord',
 *     `unreachable` health, `index()` throws `/013d/`). This is the Wave-1 seam-
 *     conformance shape; a premature `sources add discord` with no real wiring still
 *     fails loud with the owning sub-PRD.
 *   - `createDiscordProvider(config, transport)` — the REAL provider driven by the
 *     injected {@link DiscordTransport} seam (REST / gateway-tail / desktop-cache /
 *     snapshot). There are NO Discord creds in this env, so a caller MUST supply a
 *     transport (production a network one, tests a scripted fake). When `config` is
 *     given but `transport` is omitted, the provider is constructed but its transport
 *     methods will throw on first use — daemon assembly injects the network transport.
 */
export function createDiscordProvider(): SourceProvider;
export function createDiscordProvider(config: SourceConfig, transport: DiscordTransport): DiscordProvider;
export function createDiscordProvider(config?: SourceConfig, transport?: DiscordTransport): SourceProvider {
	if (config === undefined) return discordStub();
	const cfg = resolveDiscordConfig(config);
	const resolvedTransport = transport ?? networkTransportNotWired();
	return realDiscordProvider(cfg, resolvedTransport);
}

/**
 * The network transport is deferred to daemon assembly (no creds in this env). Until
 * it is wired, every method fails loud — so a real-config provider with no injected
 * transport never silently no-ops. Tests always inject a fake, so this is never hit
 * in the test suite.
 */
function networkTransportNotWired(): DiscordTransport {
	const fail = (method: string): never => {
		throw new DiscordNotImplementedError(`transport.${method} (network transport wired at daemon assembly)`);
	};
	return {
		listGuilds: () => fail("listGuilds"),
		listChannels: () => fail("listChannels"),
		listThreads: () => fail("listThreads"),
		listMembers: () => fail("listMembers"),
		fetchMessages: () => fail("fetchMessages"),
		openGateway: () => fail("openGateway"),
		readDesktopCache: () => fail("readDesktopCache"),
		exportSnapshot: () => fail("exportSnapshot"),
	};
}
