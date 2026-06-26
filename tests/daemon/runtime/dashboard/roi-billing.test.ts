/**
 * PRD-060c — the DeepLake billing client + TTL-cached infra read-model (`roi-billing.ts`).
 *
 * Verification posture: `createInfraCostReadModel` is driven with EVERY seam injected — a fake
 * `BillingFetch` replaying canned `/billing/*` responses (no real network), a no-wait `Sleeper`, a
 * deterministic `BillingClock`, and a fake `BillingCredsSource`. The token never leaves the header, so
 * the redaction test scans every string a log path could carry and asserts the bearer never appears.
 *
 * c-AC-1 reads summary + usage/compute via the injected fetch (no live network).
 * c-AC-2 no creds → `unauthenticated`; unreachable / 5xx-after-retries → `unreachable`; never throws, never fabricates.
 * c-AC-3 retries 429 / 5xx with a bounded timeout; the bearer token is redacted from every emitted string.
 * c-AC-4 TTL cache: a 2nd read within the TTL does NOT re-hit upstream; an expired read does.
 * c-AC-5 the `session_type` breakdown (query/embedding/ingestion) is itemized + summable as integer cents.
 * c-AC-6 integer cents throughout — no float-cents value is produced.
 * c-AC-7 a partial upstream (one endpoint ok, one failed) → `partial`, available line populated, missing flagged.
 */

import { describe, expect, it, vi } from "vitest";

import { type DiskCredentials } from "../../../../src/daemon/runtime/auth/index.js";
import {
	type BillingClock,
	type BillingCredsSource,
	type BillingFetch,
	type BillingFetchResponse,
	type InfraCostReadModelOptions,
	createInfraCostReadModel,
	sessionTypeTotalCents,
} from "../../../../src/daemon/runtime/dashboard/roi-billing.js";

const BEARER_TOKEN = "dl-billing-tok-SECRET-DO-NOT-LEAK-9001";

/** A canned DeepLake credential pointing at a fake endpoint (a test never reaches the real api.deeplake.ai). */
function creds(): DiskCredentials {
	return {
		token: BEARER_TOKEN,
		orgId: "org-acme",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "2026-06-26T00:00:00.000Z",
	};
}

/** A canned `GET /billing/summary` body (integer cents, exact spec field names). */
function summaryBody(): Record<string, unknown> {
	return {
		balance_cents: 250_00,
		period_start: "2026-06-01",
		period_end: "2026-06-30",
		total_cost_cents: 1_234_56,
		storage_cost_cents: 100_00,
		transfer_cost_cents: 50_00,
		projected_end_of_period_cents: 2_000_00,
		compute: {
			total_cost_cents: 1_084_56,
			total_pod_hours: 42.5,
			by_tier: [{ tier: "a100", hours: 10.5, cost_cents: 1_084_56, unit_price_cents: 103_29 }],
		},
		comparison: { compute_cost_previous: 900_00, total_cost_previous: 1_000_00, delta_pct: 23.45 },
	};
}

/** A canned `GET /billing/usage/compute` body — GPU sessions by session_type (the 060d feed). */
function computeBody(): Record<string, unknown> {
	return {
		total_cost_cents: 1_084_56,
		total_gpu_hours: 42.5,
		sessions: [
			{ session_type: "query", gpu_hours: 10, gpu_units: 1, price_cents_per_gpu_hour: 100, total_cost_cents: 1_000 },
			{ session_type: "embedding", gpu_hours: 20, gpu_units: 1, price_cents_per_gpu_hour: 150, total_cost_cents: 3_000 },
			{ session_type: "ingestion", gpu_hours: 5, gpu_units: 1, price_cents_per_gpu_hour: 200, total_cost_cents: 1_000 },
		],
	};
}

/** A 200 OK response carrying `body` (JSON + text serializers, mirroring the issuer's fake). */
function ok(body: unknown): BillingFetchResponse {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	};
}

/** A non-ok response with `status` and an arbitrary body (used for 429 / 5xx). */
function fail(status: number, body = "upstream error"): BillingFetchResponse {
	return {
		ok: false,
		status,
		json: () => Promise.resolve({ error: body }),
		text: () => Promise.resolve(body),
	};
}

/** A monotonic test clock the suite advances explicitly (epoch ms). */
function makeClock(start = 1_000_000): BillingClock & { advance(ms: number): void } {
	let t = start;
	return {
		now: () => t,
		advance(ms: number) {
			t += ms;
		},
	};
}

/** Wire the standard deterministic seams (no-wait sleep, fixed creds, given fetch + clock). */
function deps(
	fetch: BillingFetch,
	extra: Partial<InfraCostReadModelOptions> = {},
): InfraCostReadModelOptions {
	const credsSource: BillingCredsSource = () => creds();
	return {
		fetch,
		sleep: () => Promise.resolve(),
		creds: credsSource,
		clock: makeClock(),
		...extra,
	};
}

describe("c-AC-1 reads /billing/summary + /billing/usage/compute via the injected fetch", () => {
	it("returns status `ok` with both endpoints parsed (no live network)", async () => {
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) return Promise.resolve(ok(summaryBody()));
			if (url.endsWith("/billing/usage/compute")) return Promise.resolve(ok(computeBody()));
			return Promise.resolve(fail(404));
		});
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();

		expect(model.status).toBe("ok");
		expect(model.missing).toEqual([]);
		expect(model.summary?.total_cost_cents).toBe(1_234_56);
		expect(model.summary?.projected_end_of_period_cents).toBe(2_000_00);
		expect(model.summary?.comparison.total_cost_previous).toBe(1_000_00);
		expect(model.compute?.total_gpu_hours).toBe(42.5);
		// The token rode in the Authorization header, never the URL.
		for (const call of fetch.mock.calls) {
			expect(call[0]).not.toContain(BEARER_TOKEN);
			expect((call[1]?.headers ?? {})["Authorization"]).toBe(`Bearer ${BEARER_TOKEN}`);
		}
	});
});

describe("c-AC-2 fail-soft status discriminants — never throws, never fabricates", () => {
	it("no credentials → `unauthenticated`, no upstream call attempted", async () => {
		const fetch = vi.fn<BillingFetch>(() => Promise.resolve(ok(summaryBody())));
		const rm = createInfraCostReadModel(deps(fetch, { creds: () => null }));
		const model = await rm.read();

		expect(model.status).toBe("unauthenticated");
		expect(model.summary).toBeUndefined();
		expect(model.compute).toBeUndefined();
		expect(model.sessionTypes).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("both endpoints 5xx-after-retries → `unreachable`, no value fabricated, no throw", async () => {
		const fetch = vi.fn<BillingFetch>(() => Promise.resolve(fail(503)));
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 2 }));
		const model = await rm.read();

		expect(model.status).toBe("unreachable");
		expect(model.summary).toBeUndefined();
		expect(model.compute).toBeUndefined();
		// Missing lines are NAMED, never a silent zero.
		expect(model.missing).toContain("/billing/summary");
		expect(model.missing).toContain("/billing/usage/compute");
	});

	it("a network error (rejected fetch) → `unreachable`, never throws", async () => {
		const fetch = vi.fn<BillingFetch>(() => Promise.reject(new Error("ECONNREFUSED")));
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 1 }));
		const model = await rm.read();
		expect(model.status).toBe("unreachable");
	});
});

describe("c-AC-3 retries 429/5xx with a bounded timeout and redacts the bearer token", () => {
	it("retries on 429 then succeeds, exhausting fewer than maxRetries", async () => {
		let summaryCalls = 0;
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) {
				summaryCalls += 1;
				return Promise.resolve(summaryCalls < 3 ? fail(429) : ok(summaryBody()));
			}
			return Promise.resolve(ok(computeBody()));
		});
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 3 }));
		const model = await rm.read();

		expect(model.status).toBe("ok");
		expect(summaryCalls).toBe(3); // two 429s + one success.
	});

	it("the bearer token never appears in any emitted log string (header-only)", async () => {
		// A logger that records every line; the client must never hand it the token.
		const logged: string[] = [];
		const fetch = vi.fn<BillingFetch>((url, init) => {
			// Simulate a logging fetch wrapper: record method + path + header KEYS (never values).
			logged.push(`${init?.method ?? "GET"} ${url} keys=${Object.keys(init?.headers ?? {}).join(",")}`);
			if (url.endsWith("/billing/summary")) return Promise.resolve(fail(500, "boom"));
			return Promise.resolve(ok(computeBody()));
		});
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 1 }));
		const model = await rm.read();

		const scan = [...logged, JSON.stringify(model)].join("\n");
		expect(scan).not.toContain(BEARER_TOKEN);
		// The error body that DID reach us ("boom") never carried the token, and no line did either.
		expect(model.status).toBe("partial");
	});

	it("a per-attempt timeout aborts and yields `unreachable` rather than hanging", async () => {
		// A fetch that rejects with an AbortError once its signal fires — a no-wait sleeper means the
		// timeout timer fires synchronously enough that the controller aborts before resolution.
		const fetch = vi.fn<BillingFetch>(
			(_url, init) =>
				new Promise<BillingFetchResponse>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
				}),
		);
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 0, timeoutMs: 1 }));
		const model = await rm.read();
		expect(model.status).toBe("unreachable");
	});
});

describe("c-AC-4 TTL cache: a 2nd read within the TTL does not re-hit upstream; an expired read does", () => {
	it("caches within the TTL and re-fetches after expiry", async () => {
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) return Promise.resolve(ok(summaryBody()));
			return Promise.resolve(ok(computeBody()));
		});
		const clock = makeClock();
		const rm = createInfraCostReadModel(deps(fetch, { clock, ttlMs: 60_000 }));

		await rm.read();
		const callsAfterFirst = fetch.mock.calls.length; // 2 (summary + compute).
		expect(callsAfterFirst).toBe(2);

		// Second read within the TTL: NO new upstream calls.
		clock.advance(30_000);
		await rm.read();
		expect(fetch.mock.calls.length).toBe(callsAfterFirst);

		// Past the TTL: re-fetch (two more calls).
		clock.advance(31_000);
		await rm.read();
		expect(fetch.mock.calls.length).toBe(callsAfterFirst + 2);
	});

	it("invalidate() forces the next read to re-fetch", async () => {
		const fetch = vi.fn<BillingFetch>((url) =>
			Promise.resolve(url.endsWith("/billing/summary") ? ok(summaryBody()) : ok(computeBody())),
		);
		const rm = createInfraCostReadModel(deps(fetch, { ttlMs: 60_000 }));
		await rm.read();
		expect(fetch.mock.calls.length).toBe(2);
		rm.invalidate();
		await rm.read();
		expect(fetch.mock.calls.length).toBe(4);
	});
});

describe("c-AC-5 the session_type breakdown is itemized and summable (integer cents)", () => {
	it("exposes query/embedding/ingestion lines that sum to the total", async () => {
		const fetch = vi.fn<BillingFetch>((url) =>
			Promise.resolve(url.endsWith("/billing/summary") ? ok(summaryBody()) : ok(computeBody())),
		);
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();

		const byType = Object.fromEntries(model.sessionTypes.map((l) => [l.session_type, l.cost_cents]));
		expect(byType.query).toBe(1_000);
		expect(byType.embedding).toBe(3_000);
		expect(byType.ingestion).toBe(1_000);
		expect(model.sessionTypes).toHaveLength(3);
		expect(sessionTypeTotalCents(model.sessionTypes)).toBe(5_000);
	});

	it("derives cost from gpu_hours x price_cents_per_gpu_hour ONLY when total_cost_cents is ABSENT (missing)", async () => {
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) return Promise.resolve(ok(summaryBody()));
			return Promise.resolve(
				ok({
					total_cost_cents: 0,
					total_gpu_hours: 4,
					sessions: [
						// total_cost_cents OMITTED (absent on the wire) -> derive round(2.5 * 120) = 300 cents.
						{ session_type: "embedding", gpu_hours: 2.5, gpu_units: 1, price_cents_per_gpu_hour: 120 },
					],
				}),
			);
		});
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();
		expect(model.sessionTypes[0]?.cost_cents).toBe(300);
		expect(Number.isInteger(model.sessionTypes[0]?.cost_cents)).toBe(true);
	});

	// Finding (billing-zero): an EXPLICIT total_cost_cents: 0 is a legitimately-FREE session and MUST be
	// preserved verbatim -- never recomputed from gpu_hours * price (which would overstate the bill).
	it("PRESERVES an explicit total_cost_cents: 0 (a free session), never recomputing it from gpu_hours x price", async () => {
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) return Promise.resolve(ok(summaryBody()));
			return Promise.resolve(
				ok({
					total_cost_cents: 0,
					total_gpu_hours: 4,
					sessions: [
						// EXPLICIT 0 -- gpu_hours * price would be 300, but upstream said this session was free.
						{ session_type: "embedding", gpu_hours: 2.5, gpu_units: 1, price_cents_per_gpu_hour: 120, total_cost_cents: 0 },
					],
				}),
			);
		});
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();
		expect(model.sessionTypes[0]?.cost_cents).toBe(0); // preserved, NOT the derived 300.
	});
});

describe("c-AC-6 integer cents throughout — no float-cents value is produced", () => {
	it("every cents field on the snapshot is an integer", async () => {
		const fetch = vi.fn<BillingFetch>((url) =>
			Promise.resolve(url.endsWith("/billing/summary") ? ok(summaryBody()) : ok(computeBody())),
		);
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();

		const centsValues = [
			model.summary?.total_cost_cents,
			model.summary?.storage_cost_cents,
			model.summary?.transfer_cost_cents,
			model.summary?.projected_end_of_period_cents,
			model.summary?.balance_cents,
			model.summary?.compute.total_cost_cents,
			model.summary?.comparison.compute_cost_previous,
			model.compute?.total_cost_cents,
			...model.sessionTypes.map((l) => l.cost_cents),
			...model.sessionTypes.map((l) => l.price_cents_per_gpu_hour),
			sessionTypeTotalCents(model.sessionTypes),
		];
		for (const v of centsValues) {
			expect(v).toBeDefined();
			expect(Number.isInteger(v)).toBe(true);
		}
	});

	it("a malformed (float) cents field degrades to integer 0, never a float", async () => {
		const fetch = vi.fn<BillingFetch>((url) => {
			if (url.endsWith("/billing/summary")) {
				const body = summaryBody();
				body.total_cost_cents = 12.34; // a bad float — must NOT survive as a float.
				return Promise.resolve(ok(body));
			}
			return Promise.resolve(ok(computeBody()));
		});
		const rm = createInfraCostReadModel(deps(fetch));
		const model = await rm.read();
		expect(model.summary?.total_cost_cents).toBe(0);
		expect(Number.isInteger(model.summary?.total_cost_cents)).toBe(true);
	});
});

describe("c-AC-7 a partial upstream → `partial`, available line populated, missing flagged", () => {
	it("summary ok + compute failed → partial with /billing/usage/compute flagged missing", async () => {
		const fetch = vi.fn<BillingFetch>((url) =>
			Promise.resolve(url.endsWith("/billing/summary") ? ok(summaryBody()) : fail(500)),
		);
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 1 }));
		const model = await rm.read();

		expect(model.status).toBe("partial");
		expect(model.summary?.total_cost_cents).toBe(1_234_56); // available line populated.
		expect(model.compute).toBeUndefined(); // never a silent zero.
		expect(model.sessionTypes).toEqual([]);
		expect(model.missing).toEqual(["/billing/usage/compute"]);
	});

	it("compute ok + summary failed → partial with /billing/summary flagged missing", async () => {
		const fetch = vi.fn<BillingFetch>((url) =>
			Promise.resolve(url.endsWith("/billing/summary") ? fail(500) : ok(computeBody())),
		);
		const rm = createInfraCostReadModel(deps(fetch, { maxRetries: 1 }));
		const model = await rm.read();

		expect(model.status).toBe("partial");
		expect(model.summary).toBeUndefined();
		expect(model.compute?.total_cost_cents).toBe(1_084_56);
		expect(model.missing).toEqual(["/billing/summary"]);
		expect(sessionTypeTotalCents(model.sessionTypes)).toBe(5_000);
	});
});
