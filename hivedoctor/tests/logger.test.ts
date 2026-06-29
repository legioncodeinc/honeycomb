/** Logger tests (level gating, structured output, never-throws). */

import { describe, expect, it } from "vitest";

import { createLogger, type LogSink } from "../src/logger.js";

function captureSink(): { sink: LogSink; lines: string[] } {
	const lines: string[] = [];
	return { sink: { write: (line) => lines.push(line) }, lines };
}

describe("createLogger", () => {
	it("suppresses debug at the default (info) level", () => {
		const { sink, lines } = captureSink();
		const log = createLogger({ sink, now: () => 0 });
		log.debug("hidden");
		log.info("shown");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string).msg).toBe("shown");
	});

	it("emits debug when the level is debug", () => {
		const { sink, lines } = captureSink();
		const log = createLogger({ sink, level: "debug", now: () => 0 });
		log.debug("now-shown");
		expect(lines).toHaveLength(1);
	});

	it("serializes fields into the structured line", () => {
		const { sink, lines } = captureSink();
		const log = createLogger({ sink, now: () => 0 });
		log.warn("tick.unhealthy", { kind: "unreachable-refused", count: 3 });
		const parsed = JSON.parse(lines[0] as string);
		expect(parsed.level).toBe("warn");
		expect(parsed.kind).toBe("unreachable-refused");
		expect(parsed.count).toBe(3);
	});

	it("never throws when the sink throws (design principle 1)", () => {
		const log = createLogger({ sink: { write: () => { throw new Error("sink down"); } }, now: () => 0 });
		expect(() => log.error("boom")).not.toThrow();
	});

	it("silent level emits nothing", () => {
		const { sink, lines } = captureSink();
		const log = createLogger({ sink, level: "silent" });
		log.error("not-shown");
		expect(lines).toHaveLength(0);
	});
});
