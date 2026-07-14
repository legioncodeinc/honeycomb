/**
 * PRD-050e — the telemetry egress chokepoint (`emitTelemetry`).
 *
 * Verification posture: a TEMP onboarding dir per-test + `dir?` injection so NO test touches the real
 * `~/.deeplake`; an injected `fetch` RECORDER so NO real PostHog is hit; `posthogKey`/`env` overrides so
 * the keyed/unkeyed + opt-out branches are exercised without a rebuild. Covers e-AC-1..e-AC-7, e-AC-9,
 * e-AC-10 (e-AC-8 glass-box has its own suite; the e-AC-7 structural grep has its own suite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AllowedProperties,
	type TelemetryFetchRequestInit,
	BANNED_PROPERTY_KEYS,
	bucketCount,
	emitHivemindUpgrade,
	emitTelemetry,
} from "../../../../src/daemon/runtime/telemetry/index.js";
import {
	loadOnboarding,
	saveOnboarding,
} from "../../../../src/daemon/runtime/onboarding/index.js";

const KEY = "phc_test_write_only_key";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A recording fetch: captures every (url, init) and returns a scriptable response. */
function recordingFetch(result: { ok?: boolean; status?: number; throws?: boolean } = {}) {
	const calls: { url: string; init: TelemetryFetchRequestInit }[] = [];
	return {
		calls,
		fetch: (url: string, init: TelemetryFetchRequestInit) => {
			calls.push({ url, init });
			if (result.throws === true) return Promise.reject(new Error("network down"));
			return Promise.resolve({ ok: result.ok ?? true, status: result.status ?? 200 });
		},
	};
}

/** Parse the JSON body of the first recorded call. */
function bodyOf(rec: ReturnType<typeof recordingFetch>): Record<string, unknown> {
	return JSON.parse(rec.calls[0]!.init.body) as Record<string, unknown>;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-telemetry-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("e-AC-1 each event emits exactly once at its lifecycle point carrying the effective ref", () => {
	it("posts the event name + the ref in the allow-listed payload", async () => {
		const rec = recordingFetch();
		const out = await emitTelemetry(
			"honeycomb_installed",
			{ ref: "mario", tier: "tier1" },
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		expect(out.sent).toBe(true);
		expect(rec.calls).toHaveLength(1);
		const body = bodyOf(rec);
		expect(body.event).toBe("honeycomb_installed");
		expect(body.api_key).toBe(KEY);
		expect((body.properties as Record<string, unknown>).ref).toBe("mario");
	});

	it("emitHivemindUpgrade is the 050d seam — emits honeycomb_hivemind_upgrade (Tier-1) through the chokepoint", async () => {
		const rec = recordingFetch();
		const out = await emitHivemindUpgrade("mario", { dir, fetch: rec.fetch, posthogKey: KEY });
		expect(out.sent).toBe(true);
		expect(bodyOf(rec).event).toBe("honeycomb_hivemind_upgrade");
	});
});

describe("e-AC-2 the payload contains ONLY allow-listed fields; the banned set is absent", () => {
	it("normalizes a legacy PII/control-shaped referral value before it reaches telemetry", async () => {
		const rec = recordingFetch();
		await emitTelemetry(
			"honeycomb_installed",
			{ ref: "person@example.com\u001b[31m", tier: "tier1" },
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		const serialized = rec.calls[0]!.init.body;
		expect((bodyOf(rec).properties as Record<string, unknown>).ref).toBe("unknown");
		expect(serialized).not.toMatch(/person@example\.com|\u001b/);
	});

	it("a caller-supplied banned field is DROPPED — never reaches the wire", async () => {
		const rec = recordingFetch();
		await emitTelemetry(
			"honeycomb_installed",
			{
				ref: "mario",
				tier: "tier1",
				// A malicious/mistaken caller tries to smuggle banned fields through `properties`.
				properties: {
					token: "dl-SECRET",
					email: "ada@deeplake.ai",
					userName: "Ada",
					cwd: "/Users/ada/secret-repo",
					repo: "secret-repo",
					query: "how do I rm -rf",
					accountId: "acct-123",
				},
			},
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		const serialized = rec.calls[0]!.init.body;
		// EVERY banned key/value-shape is absent from the serialized payload (the structural assertion).
		for (const banned of BANNED_PROPERTY_KEYS) {
			expect(serialized.toLowerCase()).not.toContain(banned.toLowerCase());
		}
		// And the smuggled VALUES are gone too.
		expect(serialized).not.toContain("dl-SECRET");
		expect(serialized).not.toContain("ada@deeplake.ai");
		expect(serialized).not.toContain("secret-repo");
	});

	it("the payload keys are a SUBSET of the allow-list", async () => {
		const rec = recordingFetch();
		await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1", sourceTool: "claude-code" }, { dir, fetch: rec.fetch, posthogKey: KEY });
		const props = bodyOf(rec).properties as AllowedProperties;
		const ALLOWED = new Set(["ref", "source_tool", "honeycomb_version", "os", "arch", "node", "tier", "count_bucket"]);
		for (const key of Object.keys(props)) expect(ALLOWED.has(key)).toBe(true);
	});
});

describe("e-AC-3 opt-out (HONEYCOMB_TELEMETRY=0 or DO_NOT_TRACK=1) makes ZERO network calls", () => {
	it("HONEYCOMB_TELEMETRY=0 → no fetch", async () => {
		const rec = recordingFetch();
		const out = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY, env: { HONEYCOMB_TELEMETRY: "0" } });
		expect(out.sent).toBe(false);
		expect(out.skipped).toBe("opted_out");
		expect(rec.calls).toHaveLength(0);
	});

	it("DO_NOT_TRACK=1 → no fetch", async () => {
		const rec = recordingFetch();
		const out = await emitTelemetry("honeycomb_first_link", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY, env: { DO_NOT_TRACK: "1" } });
		expect(out.sent).toBe(false);
		expect(rec.calls).toHaveLength(0);
	});

	it("an EMPTY build key → telemetry disabled (no fetch)", async () => {
		const rec = recordingFetch();
		const out = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: "" });
		expect(out.sent).toBe(false);
		expect(out.skipped).toBe("disabled");
		expect(rec.calls).toHaveLength(0);
	});
});

describe("e-AC-4 fire-and-forget: a throwing / non-2xx fetch never throws and never records a send", () => {
	it("a thrown fetch is swallowed → resolves send_failed, does not reject", async () => {
		const rec = recordingFetch({ throws: true });
		const out = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY });
		expect(out.sent).toBe(false);
		expect(out.skipped).toBe("send_failed");
		// Nothing recorded in the dedupe/sent ledgers — a failed send is retryable next run.
		const state = loadOnboarding(dir);
		expect(state.telemetry.reported.honeycomb_installed).toBeUndefined();
		expect(state.telemetry.sent).toHaveLength(0);
	});

	it("a 500 is swallowed → send_failed, ledgers untouched", async () => {
		const rec = recordingFetch({ ok: false, status: 500 });
		const out = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY });
		expect(out.sent).toBe(false);
		expect(loadOnboarding(dir).telemetry.reported.honeycomb_installed).toBeUndefined();
	});
});

describe("e-AC-5 dedupe: a second run does NOT re-emit an already-reported event", () => {
	it("two emits → exactly one network call", async () => {
		const rec = recordingFetch();
		const deps = { dir, fetch: rec.fetch, posthogKey: KEY };
		const first = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, deps);
		const second = await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, deps);
		expect(first.sent).toBe(true);
		expect(second.sent).toBe(false);
		expect(second.skipped).toBe("already_reported");
		expect(rec.calls).toHaveLength(1);
	});
});

describe("honeycomb_updated dedupes per event+version via dedupeKey (the version-qualified ledger key)", () => {
	it("the SAME version never double-sends; a NEW version's key sends again under the same event name", async () => {
		const rec = recordingFetch();
		const deps = { dir, fetch: rec.fetch, posthogKey: KEY };
		const first = await emitTelemetry(
			"honeycomb_updated",
			{ ref: "mario", tier: "tier1", dedupeKey: "honeycomb_updated@1.0.1" },
			deps,
		);
		expect(first.sent).toBe(true);
		// The wire event NAME is the plain honeycomb_updated; the qualified key lives only in the ledger.
		expect(bodyOf(rec).event).toBe("honeycomb_updated");
		expect(loadOnboarding(dir).telemetry.reported["honeycomb_updated@1.0.1"]).toBeDefined();
		expect(loadOnboarding(dir).telemetry.reported.honeycomb_updated).toBeUndefined();

		const dup = await emitTelemetry(
			"honeycomb_updated",
			{ ref: "mario", tier: "tier1", dedupeKey: "honeycomb_updated@1.0.1" },
			deps,
		);
		expect(dup.sent).toBe(false);
		expect(dup.skipped).toBe("already_reported");
		expect(rec.calls).toHaveLength(1);

		const next = await emitTelemetry(
			"honeycomb_updated",
			{ ref: "mario", tier: "tier1", dedupeKey: "honeycomb_updated@1.0.2" },
			deps,
		);
		expect(next.sent).toBe(true);
		expect(rec.calls).toHaveLength(2);
		expect(JSON.parse(rec.calls[1]!.init.body).event).toBe("honeycomb_updated");
	});
});

describe("honeycomb_uninstalled rides Tier-1 (opt-out default), deduped once per machine", () => {
	it("sends without Tier-2 opt-in and dedupes a second emit", async () => {
		const rec = recordingFetch();
		const deps = { dir, fetch: rec.fetch, posthogKey: KEY };
		const first = await emitTelemetry("honeycomb_uninstalled", { ref: "mario", tier: "tier1" }, deps);
		expect(first.sent).toBe(true);
		expect(bodyOf(rec).event).toBe("honeycomb_uninstalled");
		const second = await emitTelemetry("honeycomb_uninstalled", { ref: "mario", tier: "tier1" }, deps);
		expect(second.sent).toBe(false);
		expect(second.skipped).toBe("already_reported");
		expect(rec.calls).toHaveLength(1);
	});
});

describe("e-AC-6 distinct_id is the anonymized random installId, stable across runs, a UUID not an email", () => {
	it("distinct_id is the onboarding installId (UUID v4) and stable across two emits", async () => {
		const rec = recordingFetch();
		await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY });
		const installId = loadOnboarding(dir).installId;
		const id = bodyOf(rec).distinct_id as string;
		expect(id).toBe(installId);
		expect(id).toMatch(UUID_V4);
		expect(id).not.toContain("@"); // never an email
		// A second DIFFERENT event reuses the same id (stable per machine).
		const rec2 = recordingFetch();
		await emitTelemetry("honeycomb_first_link", { ref: "mario", tier: "tier1" }, { dir, fetch: rec2.fetch, posthogKey: KEY });
		expect(bodyOf(rec2).distinct_id).toBe(installId);
	});
});

describe("e-AC-7 the chokepoint posts to the pinned PostHog capture URL", () => {
	it("the URL is ${host}/i/v0/e/ with the pinned body shape", async () => {
		const rec = recordingFetch();
		await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY, posthogHost: "https://us.i.posthog.com" });
		expect(rec.calls[0]!.url).toBe("https://us.i.posthog.com/i/v0/e/");
		const body = bodyOf(rec);
		expect(Object.keys(body).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
	});
});

describe("e-AC-9 tiered consent: Tier-2 emits only with opt-in; opt-out silences both tiers", () => {
	it("a default install emits NO Tier-2 event (no opt-in)", async () => {
		const rec = recordingFetch();
		const out = await emitTelemetry(
			"honeycomb_installed", // event NAME is Tier-1, but we mark the EMIT tier2 to prove the gate
			{ ref: "mario", tier: "tier2", countBucket: bucketCount(42) },
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		expect(out.sent).toBe(false);
		expect(out.skipped).toBe("not_consented");
		expect(rec.calls).toHaveLength(0);
	});

	it("with optInTier2 set, a Tier-2 emit goes through carrying a bucketed count", async () => {
		// Opt in by persisting the flag.
		saveOnboarding({ ...loadOnboarding(dir), telemetry: { ...loadOnboarding(dir).telemetry, optInTier2: true } }, dir);
		const rec = recordingFetch();
		const out = await emitTelemetry(
			"honeycomb_first_link",
			{ ref: "mario", tier: "tier2", countBucket: bucketCount(42) },
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		expect(out.sent).toBe(true);
		expect((bodyOf(rec).properties as AllowedProperties).count_bucket).toBe("11-100");
	});

	it("opt-out silences a Tier-2 event even WITH opt-in", async () => {
		saveOnboarding({ ...loadOnboarding(dir), telemetry: { ...loadOnboarding(dir).telemetry, optInTier2: true } }, dir);
		const rec = recordingFetch();
		const out = await emitTelemetry(
			"honeycomb_first_link",
			{ ref: "mario", tier: "tier2", countBucket: bucketCount(5) },
			{ dir, fetch: rec.fetch, posthogKey: KEY, env: { DO_NOT_TRACK: "1" } },
		);
		expect(out.sent).toBe(false);
		expect(rec.calls).toHaveLength(0);
	});
});

describe("e-AC-10 no item-level egress: counts are bucketed, never precise", () => {
	it("bucketCount maps a precise int onto a coarse label", () => {
		expect(bucketCount(0)).toBe("0");
		expect(bucketCount(7)).toBe("1-10");
		expect(bucketCount(11)).toBe("11-100");
		expect(bucketCount(1000)).toBe("100+");
	});

	it("a precise count passed as a property is DROPPED (only count_bucket may egress)", async () => {
		saveOnboarding({ ...loadOnboarding(dir), telemetry: { ...loadOnboarding(dir).telemetry, optInTier2: true } }, dir);
		const rec = recordingFetch();
		await emitTelemetry(
			"honeycomb_first_link",
			{ ref: "mario", tier: "tier2", countBucket: bucketCount(42), properties: { memories: "42", count: "42" } },
			{ dir, fetch: rec.fetch, posthogKey: KEY },
		);
		const serialized = rec.calls[0]!.init.body;
		// The precise "42" never leaves as a memory/count field — only the bucket "11-100" does.
		expect(serialized).toContain("11-100");
		expect(serialized).not.toContain('"memories"');
		expect(serialized).not.toContain('"count"');
	});
});

describe("glass-box ledger: a successful send is recorded in BOTH the reported + sent logs (e-AC-8 source)", () => {
	it("appends to sent and marks reported on a 2xx", async () => {
		const rec = recordingFetch();
		await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec.fetch, posthogKey: KEY });
		const state = loadOnboarding(dir);
		expect(state.telemetry.reported.honeycomb_installed).toBeDefined();
		expect(state.telemetry.sent).toHaveLength(1);
		expect(state.telemetry.sent[0]!.event).toBe("honeycomb_installed");
		// The sent record is the EXACT egress payload (glass-box ≡ egress).
		expect(state.telemetry.sent[0]!.properties.ref).toBe("mario");
	});
});
