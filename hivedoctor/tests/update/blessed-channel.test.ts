/**
 * The blessed-version channel (PRD-064e, OD-3). The fail-closed safety: an unreachable
 * or unparseable channel must yield a non-ok result so the caller stays on current.
 */

import { describe, expect, it } from "vitest";

import { fetchBlessedVersion, parseBlessedManifest } from "../../src/update/blessed-channel.js";
import { fakeFetchReturning, fakeFetchThrowing } from "./helpers/fake-fetch.js";

describe("parseBlessedManifest", () => {
	it("accepts a minimal { version } object", () => {
		expect(parseBlessedManifest({ version: "0.1.9" })).toEqual({ version: "0.1.9" });
	});

	it("carries an optional minVersion floor and ignores unknown fields", () => {
		expect(parseBlessedManifest({ version: "0.1.9", minVersion: "0.1.5", note: "x" })).toEqual({
			version: "0.1.9",
			minVersion: "0.1.5",
		});
	});

	it("rejects a missing / empty / non-string version", () => {
		expect(parseBlessedManifest({})).toBeNull();
		expect(parseBlessedManifest({ version: "" })).toBeNull();
		expect(parseBlessedManifest({ version: 19 })).toBeNull();
		expect(parseBlessedManifest(null)).toBeNull();
	});
});

describe("fetchBlessedVersion (fail-closed)", () => {
	it("returns the parsed manifest on a 200 with a valid body", async () => {
		const f = fakeFetchReturning(JSON.stringify({ version: "0.1.9" }));
		const result = await fetchBlessedVersion({ fetch: f.fetch, url: "https://cdn.test/blessed-version.json" });
		expect(result).toEqual({ ok: true, manifest: { version: "0.1.9" } });
		expect(f.calls).toEqual([{ url: "https://cdn.test/blessed-version.json" }]);
	});

	it("fails closed (unreachable) when the fetch throws", async () => {
		const f = fakeFetchThrowing();
		const result = await fetchBlessedVersion({ fetch: f.fetch });
		expect(result).toEqual({ ok: false, reason: "unreachable" });
	});

	it("fails closed (non_2xx) when the CDN answers non-2xx", async () => {
		const f = fakeFetchReturning("Not Found", 404);
		const result = await fetchBlessedVersion({ fetch: f.fetch });
		expect(result).toEqual({ ok: false, reason: "non_2xx" });
	});

	it("fails closed (unparseable) on non-JSON body", async () => {
		const f = fakeFetchReturning("<html>maintenance</html>");
		const result = await fetchBlessedVersion({ fetch: f.fetch });
		expect(result).toEqual({ ok: false, reason: "unparseable" });
	});

	it("fails closed (unparseable) on JSON without a usable version", async () => {
		const f = fakeFetchReturning(JSON.stringify({ notVersion: true }));
		const result = await fetchBlessedVersion({ fetch: f.fetch });
		expect(result).toEqual({ ok: false, reason: "unparseable" });
	});
});
