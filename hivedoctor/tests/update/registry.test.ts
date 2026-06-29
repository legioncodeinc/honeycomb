/**
 * The npm-registry `@latest` reader (PRD-064e version source). Fail-soft: any error
 * resolves to null ("latest unknown") so a registry hiccup never triggers an update.
 */

import { describe, expect, it } from "vitest";

import { createRegistryLatestReader, defaultLatestUrl, parseLatestVersion } from "../../src/update/registry.js";
import { fakeFetchReturning, fakeFetchThrowing } from "./helpers/fake-fetch.js";

const PKG = "@legioncodeinc/honeycomb";

describe("defaultLatestUrl", () => {
	it("builds the abbreviated /latest metadata URL", () => {
		expect(defaultLatestUrl(PKG)).toBe(`https://registry.npmjs.org/${PKG}/latest`);
	});
});

describe("parseLatestVersion", () => {
	it("extracts the version from a manifest body", () => {
		expect(parseLatestVersion(JSON.stringify({ name: PKG, version: "0.1.9" }))).toBe("0.1.9");
	});

	it("returns null for non-JSON or a missing version", () => {
		expect(parseLatestVersion("oops")).toBeNull();
		expect(parseLatestVersion(JSON.stringify({ name: PKG }))).toBeNull();
		expect(parseLatestVersion(JSON.stringify({ version: "" }))).toBeNull();
	});
});

describe("createRegistryLatestReader (fail-soft)", () => {
	it("reads @latest over the injected fetch", async () => {
		const f = fakeFetchReturning(JSON.stringify({ version: "0.1.9" }));
		const read = createRegistryLatestReader({ pkg: PKG, fetch: f.fetch });
		expect(await read()).toBe("0.1.9");
		expect(f.calls).toEqual([{ url: defaultLatestUrl(PKG) }]);
	});

	it("returns null when the fetch throws", async () => {
		const read = createRegistryLatestReader({ pkg: PKG, fetch: fakeFetchThrowing().fetch });
		expect(await read()).toBeNull();
	});

	it("returns null on a non-2xx", async () => {
		const read = createRegistryLatestReader({ pkg: PKG, fetch: fakeFetchReturning("nope", 500).fetch });
		expect(await read()).toBeNull();
	});
});
