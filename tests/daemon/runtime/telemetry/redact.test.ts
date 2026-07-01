/**
 * PRD-071c (AC-071c.3.2 / AC-10) — the fleet log redaction denylist.
 */

import { describe, expect, it } from "vitest";

import { redactLogMessage } from "../../../../src/daemon/runtime/telemetry/redact.js";

describe("PRD-071c: redactLogMessage", () => {
	it("AC-071c.3.2 redacts a Bearer token but keeps the rest of the line legible", () => {
		const out = redactLogMessage("GET /api/memories -> 401 Authorization: Bearer abc123XYZ (12ms)");
		expect(out).not.toBeNull();
		expect(out).not.toContain("abc123XYZ");
		expect(out).toContain("GET /api/memories -> 401");
		expect(out).toContain("[REDACTED]");
	});

	it("AC-10 redacts common secret-shaped key=value spans (token/password/secret/apikey/cookie)", () => {
		const cases = [
			"token=sekrit-value-here",
			"password: hunter2value",
			"secret=my-app-secret",
			"apikey=deadbeefcafefeed",
			"cookie=session-id-value",
		];
		for (const line of cases) {
			const out = redactLogMessage(line);
			expect(out).not.toBeNull();
			expect(out).toContain("[REDACTED]");
			// The raw value must not survive redaction.
			const value = line.split(/[:=]\s*/)[1];
			expect(out).not.toContain(value);
		}
	});

	it("AC-071c.3.2 drops (returns null) a line carrying an unredactable private-key block", () => {
		const out = redactLogMessage("dumped config: -----BEGIN RSA PRIVATE KEY-----\nMIIBogI...");
		expect(out).toBeNull();
	});

	it("AC-071c.3.2 drops a line carrying a long unredactable high-entropy blob", () => {
		const blob = "a".repeat(40) + "B".repeat(40) + "9".repeat(10);
		const out = redactLogMessage(`unexpected payload: ${blob}`);
		expect(out).toBeNull();
	});

	it("leaves an ordinary, non-sensitive log line untouched", () => {
		const line = "GET /health -> 200 (3ms)";
		expect(redactLogMessage(line)).toBe(line);
	});
});
