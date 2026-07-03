import { describe, expect, it } from "vitest";

import { redactEndpointCredentials } from "../../src/shared/redact-endpoint.js";

describe("redactEndpointCredentials", () => {
	it("masks the password in a URL with userinfo credentials", () => {
		expect(redactEndpointCredentials("postgres://user:secret@host:5432/db")).toBe("postgres://user:****@host:5432/db");
	});

	it("leaves a URL with username only unchanged", () => {
		expect(redactEndpointCredentials("postgres://u@db:5432/deeplake")).toBe("postgres://u@db:5432/deeplake");
	});

	it("leaves a URL without userinfo unchanged", () => {
		expect(redactEndpointCredentials("https://deeplake.internal:8443")).toBe("https://deeplake.internal:8443");
	});

	it("returns malformed strings unchanged without throwing", () => {
		expect(redactEndpointCredentials("not-a-url")).toBe("not-a-url");
		expect(redactEndpointCredentials("")).toBe("");
	});
});
