/**
 * PRD-013d Discord provider — proves d-AC-1..6 against a SCRIPTED fake
 * {@link DiscordTransport}. There are NO Discord creds in this env, so the provider
 * is driven entirely through the transport seam: scripted guilds/channels/threads/
 * members/messages, a scripted gateway event stream, a scripted desktop cache, and a
 * scripted snapshot. NO real network.
 *
 * The decisive assertions, one per d-AC:
 *   - d-AC-1: REST pull yields guild/channel/thread/member + per-message artifacts;
 *             the forward refresh fetches AFTER the latest checkpoint and the
 *             backfill pages BEFORE the backfill floor within the configured bound.
 *   - d-AC-2: a per-channel partial fetch failure yields a FAILURE artifact and the
 *             scan CONTINUES (the other channel still indexes) — no exception aborts
 *             the run, and the provider emits no removal.
 *   - d-AC-3: a gateway create/update/delete event advances the PER-CHANNEL tail
 *             checkpoint to the event's message id.
 *   - d-AC-4: `close()` tears down the held gateway connection (the fake records it).
 *   - d-AC-5: desktop-cache eviction emits NO removal artifact — previously-indexed
 *             rows are left intact.
 *   - d-AC-6: a snapshot export with defaults EXCLUDES local `@me` DMs.
 */

import { describe, expect, it } from "vitest";

import {
	AT_ME_GUILD_ID,
	type ChannelMessages,
	createDiscordProvider,
	type DiscordChannel,
	type DiscordGuild,
	type DiscordMember,
	type DiscordMessage,
	type DiscordTransport,
	type GatewayConnection,
	type GatewayEvent,
	type GatewayHandlers,
	type MessageQuery,
} from "../../../../../src/daemon/runtime/sources/providers/discord.js";
import type { SourceArtifact, SourceConfig } from "../../../../../src/daemon/runtime/sources/contracts.js";

const SOURCE_ID = "src-discord-1";

/** A Discord source config (the provider reads its keys out of `settings`). */
function discordConfig(overrides: Record<string, unknown> = {}): SourceConfig {
	return {
		kind: "discord",
		org: "acme",
		workspace: "backend",
		root: "guild-1",
		settings: { sourceId: SOURCE_ID, mode: "rest", ...overrides },
	};
}

/** A scripted-channel definition: the messages the transport serves for it. */
interface ScriptedChannel {
	readonly channel: DiscordChannel;
	readonly threads?: readonly DiscordChannel[];
	readonly messages: readonly DiscordMessage[];
	/** When set, every fetch on this channel returns this partial failure (d-AC-2). */
	readonly failure?: { reason: string; detail?: Record<string, unknown> };
}

/** A scripted fake transport — records every call so tests can assert cursors. */
interface FakeTransport extends DiscordTransport {
	readonly fetchCalls: Array<{ channelId: string; query: MessageQuery }>;
	readonly gatewayClosedCount: () => number;
	emitGatewayEvent(event: GatewayEvent): void;
}

/** Build a scripted fake transport over canned topology + a gateway event sink. */
function fakeTransport(spec: {
	readonly guilds: readonly DiscordGuild[];
	readonly members?: Readonly<Record<string, readonly DiscordMember[]>>;
	readonly channels: Readonly<Record<string, readonly ScriptedChannel[]>>;
	readonly desktopCache?: readonly DiscordMessage[];
	readonly snapshot?: readonly DiscordMessage[];
}): FakeTransport {
	const fetchCalls: Array<{ channelId: string; query: MessageQuery }> = [];
	let gatewayHandlers: GatewayHandlers | null = null;
	let closedCount = 0;

	const allChannels = (): ScriptedChannel[] => Object.values(spec.channels).flat();
	const findChannel = (channelId: string): ScriptedChannel | undefined =>
		allChannels().find((c) => c.channel.id === channelId);

	return {
		fetchCalls,
		gatewayClosedCount: () => closedCount,
		emitGatewayEvent(event: GatewayEvent): void {
			gatewayHandlers?.onEvent(event);
		},
		async listGuilds(): Promise<readonly DiscordGuild[]> {
			return spec.guilds;
		},
		async listChannels(guildId: string): Promise<readonly DiscordChannel[]> {
			return (spec.channels[guildId] ?? []).map((c) => c.channel);
		},
		async listThreads(channelId: string): Promise<readonly DiscordChannel[]> {
			return findChannel(channelId)?.threads ?? [];
		},
		async listMembers(guildId: string): Promise<readonly DiscordMember[]> {
			return spec.members?.[guildId] ?? [];
		},
		async fetchMessages(channelId: string, query: MessageQuery): Promise<ChannelMessages> {
			fetchCalls.push({ channelId, query });
			const sc = findChannel(channelId);
			if (sc === undefined) return { page: { messages: [], hasMoreBefore: false } };
			if (sc.failure !== undefined) {
				return {
					page: { messages: [], hasMoreBefore: false },
					failure: { path: channelId, reason: sc.failure.reason, detail: sc.failure.detail },
				};
			}
			// Forward refresh (after): messages strictly greater than `after`.
			if (query.after !== undefined) {
				const fwd = sc.messages.filter((m) => Number(m.id) > Number(query.after));
				return { page: { messages: fwd.slice(0, query.limit), hasMoreBefore: false } };
			}
			// Backfill (before): messages strictly less than `before` (or all when unset).
			const older = sc.messages.filter((m) => query.before === undefined || Number(m.id) < Number(query.before));
			const page = older.slice(0, query.limit);
			return { page: { messages: page, hasMoreBefore: older.length > page.length } };
		},
		async openGateway(handlers: GatewayHandlers): Promise<GatewayConnection> {
			gatewayHandlers = handlers;
			return {
				async close(): Promise<void> {
					closedCount += 1;
					gatewayHandlers = null;
				},
			};
		},
		async readDesktopCache(): Promise<readonly DiscordMessage[]> {
			return spec.desktopCache ?? [];
		},
		async exportSnapshot(): Promise<readonly DiscordMessage[]> {
			return spec.snapshot ?? [];
		},
	};
}

/** A message snowflake (decimal id) helper. */
function msg(id: string, channelId: string, content: string, guildId = "guild-1"): DiscordMessage {
	return { id, channelId, guildId, author: "alice", content, timestamp: `2026-06-18T00:00:0${id[id.length - 1] ?? "0"}Z` };
}

/** Drain an async iterable of artifacts into an array. */
async function drain(it: AsyncIterable<SourceArtifact>): Promise<SourceArtifact[]> {
	const out: SourceArtifact[] = [];
	for await (const a of it) out.push(a);
	return out;
}

describe("PRD-013d Discord provider", () => {
	it("d-AC-1 REST mode pulls guilds/channels/threads/members + per-message artifacts with latest+backfill checkpoints", async () => {
		const transport = fakeTransport({
			guilds: [{ id: "guild-1", name: "Acme HQ" }],
			members: { "guild-1": [{ id: "u1", guildId: "guild-1", displayName: "alice" }] },
			channels: {
				"guild-1": [
					{
						channel: { id: "chan-1", guildId: "guild-1", name: "general" },
						threads: [{ id: "thread-1", guildId: "guild-1", name: "release-thread", isThread: true, parentId: "chan-1" }],
						// ids 100..104; latest checkpoint at 102 → forward must fetch 103,104;
						// backfill floor at 100 → backfill must page 100-exclusive (none older here),
						// but we add older ids 97,98,99 to prove the backfill leg pages BEFORE 100.
						messages: [
							msg("97", "chan-1", "old c"),
							msg("98", "chan-1", "old b"),
							msg("99", "chan-1", "old a"),
							msg("103", "chan-1", "new a"),
							msg("104", "chan-1", "new b"),
						],
					},
					{ channel: { id: "thread-1", guildId: "guild-1", name: "release-thread", isThread: true, parentId: "chan-1" }, messages: [] },
				],
			},
		});
		const provider = createDiscordProvider(
			discordConfig({
				mode: "rest",
				backfillLimit: 10,
				pageSize: 100,
				checkpoints: { "chan-1": { latest: "102", backfill: "100" } },
			}),
			transport,
		);

		const artifacts = await drain(provider.index({}));

		// Topology artifacts present (guild + channel + thread + member).
		expect(artifacts.some((a) => a.kind === "artifact" && a.title === "Acme HQ")).toBe(true);
		expect(artifacts.some((a) => a.kind === "artifact" && a.metadata?.unit === "channel")).toBe(true);
		expect(artifacts.some((a) => a.kind === "artifact" && a.metadata?.unit === "thread")).toBe(true);
		expect(artifacts.some((a) => a.kind === "artifact" && a.metadata?.unit === "member")).toBe(true);

		// FORWARD refresh fetched strictly AFTER the latest checkpoint (102) → 103,104.
		const msgArtifacts = artifacts.filter((a) => a.kind === "message");
		const forwardIds = msgArtifacts.map((a) => a.metadata?.messageId);
		expect(forwardIds).toContain("103");
		expect(forwardIds).toContain("104");

		// BACKFILL paged strictly BEFORE the backfill floor (100) → 97,98,99.
		expect(forwardIds).toContain("99");
		expect(forwardIds).toContain("97");

		// Provenance quartet on every message artifact (a-AC-3 / FR-4): guild/channel/message.
		for (const a of msgArtifacts) {
			expect(a.provenance.sourceId).toBe(SOURCE_ID);
			expect(a.provenance.sourceKind).toBe("discord");
			expect(a.provenance.sourcePath).toMatch(/^guild-1\/chan-1\/\d+$/);
			expect(a.provenance.org).toBe("acme");
			expect(a.provenance.workspace).toBe("backend");
		}

		// The transport saw both a forward (after) and a backfill (before) fetch on chan-1.
		const chan1Calls = transport.fetchCalls.filter((c) => c.channelId === "chan-1");
		expect(chan1Calls.some((c) => c.query.after === "102")).toBe(true);
		expect(chan1Calls.some((c) => c.query.before === "100")).toBe(true);
	});

	it("d-AC-1 backfill is bounded by backfillLimit", async () => {
		const many = Array.from({ length: 50 }, (_, i) => msg(String(200 + i), "chan-1", `m${i}`));
		const transport = fakeTransport({
			guilds: [{ id: "guild-1", name: "Acme HQ" }],
			channels: { "guild-1": [{ channel: { id: "chan-1", guildId: "guild-1", name: "general" }, messages: many }] },
		});
		const provider = createDiscordProvider(
			discordConfig({ mode: "rest", backfillLimit: 5, pageSize: 100, checkpoints: {} }),
			transport,
		);
		const artifacts = await drain(provider.index({}));
		// No forward checkpoint → the forward leg returns nothing (no `after`); the
		// backfill leg pages oldest-first bounded to 5.
		const ids = artifacts.filter((a) => a.kind === "message").map((a) => a.metadata?.messageId);
		expect(ids).toHaveLength(5);
	});

	it("d-AC-2 a partial fetch failure → a failure artifact + reported, scan continues, no row deleted", async () => {
		const transport = fakeTransport({
			guilds: [{ id: "guild-1", name: "Acme HQ" }],
			channels: {
				"guild-1": [
					{ channel: { id: "chan-ok", guildId: "guild-1", name: "ok" }, messages: [msg("10", "chan-ok", "fine")] },
					{ channel: { id: "chan-bad", guildId: "guild-1", name: "bad" }, messages: [], failure: { reason: "429 rate limited", detail: { status: 429 } } },
				],
			},
		});
		const provider = createDiscordProvider(discordConfig({ mode: "rest", checkpoints: {} }), transport);

		// The index NEVER throws — a partial failure is a data point, not an abort.
		const artifacts = await drain(provider.index({}));

		// The healthy channel still produced a message artifact (scan continued).
		expect(artifacts.some((a) => a.kind === "message" && a.failure === undefined && a.metadata?.channelId === "chan-ok")).toBe(true);

		// The failed channel produced a FAILURE artifact (the lifecycle writes it; no row deleted).
		const failures = artifacts.filter((a) => a.failure !== undefined);
		expect(failures).toHaveLength(1);
		expect(failures[0].failure?.reason).toMatch(/429/);
		expect(failures[0].provenance.sourceId).toBe(SOURCE_ID);
	});

	it("d-AC-3 a gateway create/update/delete event advances the per-channel tail checkpoint", async () => {
		const transport = fakeTransport({ guilds: [], channels: {} });
		const provider = createDiscordProvider(discordConfig({ mode: "gateway-tail" }), transport);
		await provider.connect(discordConfig({ mode: "gateway-tail" }));

		// No tail yet for chan-9.
		expect(provider.tailCheckpoint("chan-9")).toBeUndefined();

		// A CREATE advances the per-channel tail to the new message id.
		const created = provider.indexGatewayEvent({ type: "create", message: msg("500", "chan-9", "hi") });
		expect(created.removed).toBe(false);
		expect(created.artifact.kind).toBe("message");
		expect(provider.tailCheckpoint("chan-9")).toBe("500");

		// An UPDATE on the same channel advances the tail further.
		provider.indexGatewayEvent({ type: "update", message: { ...msg("501", "chan-9", "hi edit"), edited: true } });
		expect(provider.tailCheckpoint("chan-9")).toBe("501");

		// A DELETE is reported as removed (the lifecycle soft-deletes; provider never deletes the source).
		const deleted = provider.indexGatewayEvent({ type: "delete", message: { ...msg("502", "chan-9", ""), deleted: true } });
		expect(deleted.removed).toBe(true);
		expect(provider.tailCheckpoint("chan-9")).toBe("502");

		// A DIFFERENT channel keeps its OWN tail (per-channel, not global).
		provider.indexGatewayEvent({ type: "create", message: msg("600", "chan-other", "elsewhere") });
		expect(provider.tailCheckpoint("chan-other")).toBe("600");
		expect(provider.tailCheckpoint("chan-9")).toBe("502");
	});

	it("d-AC-4 purge closes the gateway connection (close() tears down the gateway)", async () => {
		const transport = fakeTransport({ guilds: [], channels: {} });
		const provider = createDiscordProvider(discordConfig({ mode: "gateway-tail" }), transport);
		await provider.connect(discordConfig({ mode: "gateway-tail" }));

		expect(provider.gatewayClosed()).toBe(false);
		expect(transport.gatewayClosedCount()).toBe(0);

		// Purge calls provider.close() (the lifecycle does this); the gateway is torn down.
		await provider.close();

		expect(provider.gatewayClosed()).toBe(true);
		expect(transport.gatewayClosedCount()).toBe(1);

		// Idempotent: a second close does not re-tear-down (no held connection).
		await provider.close();
		expect(transport.gatewayClosedCount()).toBe(1);
	});

	it("d-AC-5 desktop-cache eviction → previously-indexed rows remain (no removal emitted)", async () => {
		// First index sees a fuller cache (two messages).
		const full = fakeTransport({
			guilds: [],
			channels: {},
			desktopCache: [msg("1", "dm-1", "kept", AT_ME_GUILD_ID), msg("2", "dm-1", "evicted-later", AT_ME_GUILD_ID)],
		});
		const provider1 = createDiscordProvider(discordConfig({ mode: "desktop-cache" }), full);
		const firstRun = await drain(provider1.index({}));
		expect(firstRun.filter((a) => a.kind === "message")).toHaveLength(2);

		// A later index sees an EVICTED cache (message 2 gone). The provider emits ONLY
		// the surviving message — and crucially NO failure/removal artifact for the
		// evicted one. Eviction is not a deletion: the lifecycle keeps row 2 intact.
		const evicted = fakeTransport({
			guilds: [],
			channels: {},
			desktopCache: [msg("1", "dm-1", "kept", AT_ME_GUILD_ID)],
		});
		const provider2 = createDiscordProvider(discordConfig({ mode: "desktop-cache" }), evicted);
		const secondRun = await drain(provider2.index({}));

		expect(secondRun.filter((a) => a.kind === "message")).toHaveLength(1);
		// No removal/failure artifact was emitted for the evicted message (d-AC-5).
		expect(secondRun.some((a) => a.failure !== undefined)).toBe(false);
		expect(secondRun.every((a) => a.metadata?.messageId !== "2")).toBe(true);
	});

	it("d-AC-6 a snapshot export with defaults excludes local @me DMs", async () => {
		const transport = fakeTransport({
			guilds: [],
			channels: {},
			snapshot: [
				msg("10", "chan-1", "team msg", "guild-1"),
				msg("11", "dm-1", "private dm", AT_ME_GUILD_ID),
			],
		});
		const provider = createDiscordProvider(discordConfig({ mode: "rest" }), transport);

		const exported = await provider.exportSnapshot();

		// The guild message is exported; the `@me` DM is excluded by default (d-AC-6).
		expect(exported).toHaveLength(1);
		expect(exported[0].metadata?.guildId).toBe("guild-1");
		expect(exported.some((a) => a.metadata?.guildId === AT_ME_GUILD_ID)).toBe(false);
	});

	it("d-AC-6 the @me exclusion is overridable per export (excludeAtMeDmsOnExport=false)", async () => {
		const transport = fakeTransport({
			guilds: [],
			channels: {},
			snapshot: [msg("11", "dm-1", "private dm", AT_ME_GUILD_ID)],
		});
		const provider = createDiscordProvider(discordConfig({ mode: "rest", excludeAtMeDmsOnExport: false }), transport);
		const exported = await provider.exportSnapshot();
		// With the override off, the `@me` DM IS exported.
		expect(exported).toHaveLength(1);
		expect(exported[0].metadata?.guildId).toBe(AT_ME_GUILD_ID);
	});
});

describe("PRD-013d Discord provider — Wave-1 seam-conformance preserved", () => {
	it("createDiscordProvider() with NO config remains the loud-fail stub", async () => {
		const stub = createDiscordProvider();
		expect(stub.kind).toBe("discord");
		expect((await stub.health()).state).toBe("unreachable");
		expect(() => stub.index({})).toThrow(/013d/);
	});
});
