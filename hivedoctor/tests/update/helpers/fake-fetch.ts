/**
 * Test-only fake fetch seams for the 064e update tests, so NO test ever hits the network
 * (binding constraint: registry/CDN/health behind injectable interfaces). Built-ins only.
 *
 * Both the blessed-channel and registry readers consume the same minimal response shape
 * (`{ ok, status, text() }`), so one builder serves both. A `throws` variant simulates a
 * transport failure (the fail-closed path).
 */

import type { BlessedFetch } from "../../../src/update/blessed-channel.js";
import type { RegistryFetch } from "../../../src/update/registry.js";

/** One recorded fetch call. */
export interface RecordedFetch {
	readonly url: string;
}

/** A fake fetch plus the recording of the URLs it was asked to fetch. */
export interface FakeFetch {
	readonly fetch: BlessedFetch & RegistryFetch;
	readonly calls: RecordedFetch[];
}

/** Build a fake fetch that returns `body` with the given status (default 200). */
export function fakeFetchReturning(body: string, status = 200): FakeFetch {
	const calls: RecordedFetch[] = [];
	const fetch = async (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
		calls.push({ url });
		return { ok: status >= 200 && status < 300, status, text: async () => body };
	};
	return { fetch: fetch as BlessedFetch & RegistryFetch, calls };
}

/** Build a fake fetch that REJECTS (transport error / timeout), exercising the fail-closed path. */
export function fakeFetchThrowing(message = "ECONNREFUSED"): FakeFetch {
	const calls: RecordedFetch[] = [];
	const fetch = async (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
		calls.push({ url });
		throw new Error(message);
	};
	return { fetch: fetch as BlessedFetch & RegistryFetch, calls };
}
