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

	it("masks a password carried in the query string (libpq-style URI)", () => {
		expect(redactEndpointCredentials("postgres://user@host:5432/db?password=secret")).toBe(
			"postgres://user@host:5432/db?password=****",
		);
		expect(redactEndpointCredentials("postgres://host:5432/db?sslpassword=secret&sslmode=require")).toBe(
			"postgres://host:5432/db?sslpassword=****&sslmode=require",
		);
	});

	it("masks both userinfo and query-string secrets together", () => {
		expect(redactEndpointCredentials("https://user:pw@gw.internal/api?token=abc123")).toBe(
			"https://user:****@gw.internal/api?token=****",
		);
	});

	it("masks the password across multiple @ signs and IPv6 hosts", () => {
		expect(redactEndpointCredentials("postgres://a:b@c:d@host/db")).toBe("postgres://a:****@host/db");
		expect(redactEndpointCredentials("postgres://user:pass@[::1]:5432/db")).toBe("postgres://user:****@[::1]:5432/db");
	});

	it("leaves a non-secret query string byte-for-byte unchanged", () => {
		expect(redactEndpointCredentials("https://gw.internal/api?region=us-east-1")).toBe(
			"https://gw.internal/api?region=us-east-1",
		);
	});
});
