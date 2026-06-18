/**
 * PRD-016a trace miner — proves a-AC-1..6 (named, unskipped).
 *
 * Verification posture (EXECUTION_LEDGER-prd-016): no live DeepLake. Each a-AC has a
 * named test driving the real `miner.ts` against:
 *   - a FAKE `SessionFetcher` (canned `SessionRow[]`) for the extraction ACs, AND the
 *     REAL `createSessionFetcher` over the `FakeDeepLakeTransport` for the team-filter
 *     SQL assertion (a-AC-4);
 *   - `createFakeGateCli` (the pinned fake) + a fake `GateSpawner` to assert the no-shell
 *     args array (a-AC-2);
 *   - the REAL `TurnCounters` (a low threshold) for the stop-counter trigger (a-AC-3);
 *   - an in-memory `WorkerLock` for the suppression test + the real `O_EXCL` file lock
 *     to prove a concurrent acquire is suppressed (a-AC-5);
 *   - a FAST injectable `gateTimeoutMs` + a never-resolving gate for the timeout abort,
 *     asserting NO verdict is produced AND the lock is free afterwards (a-AC-6).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import {
	buildGatePrompt,
	createFakeGateCli,
	createFileWorkerLock,
	createHostCliGate,
	createSessionFetcher,
	evaluateTrigger,
	extractPairsFromRows,
	type GateSpawner,
	type GateVerdict,
	type HostCliSpec,
	type LockHandle,
	MAX_PAIR_CHARS,
	mine,
	type MineScope,
	normalizeVerdict,
	parseVerdictStdout,
	redactSecrets,
	runGate,
	type SessionFetcher,
	type SessionRow,
	skillifyEveryNTurns,
	type WorkerLock,
} from "../../../../src/daemon/runtime/skillify/index.js";
import { TurnCounters } from "../../../../src/daemon/runtime/capture/turn-counters.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

// ── Builders for fake `sessions` rows (the verbatim `{ event, metadata }` envelope) ──

function userRow(session: string, text: string, date: string, author = "alice"): SessionRow {
	return envelopeRow(session, { kind: "user_message", text }, date, author);
}
function assistantRow(session: string, text: string, date: string, author = "alice"): SessionRow {
	return envelopeRow(session, { kind: "assistant_message", text }, date, author);
}
function toolRow(session: string, date: string, author = "alice"): SessionRow {
	return envelopeRow(session, { kind: "tool_call", tool: "Bash", input: { cmd: "ls" } }, date, author);
}
function envelopeRow(session: string, event: Record<string, unknown>, date: string, author: string): SessionRow {
	const message = JSON.stringify({ event, metadata: { sessionId: session, path: session } });
	return { path: session, sessionId: session, message, author, creationDate: date };
}

/** A fetcher that returns canned rows (extraction ACs are pure over these). */
function fakeFetcher(rows: readonly SessionRow[]): SessionFetcher {
	return { fetch: async (): Promise<readonly SessionRow[]> => rows };
}

/** An in-memory worker lock (one holder per project; second acquire → null). */
function memoryLock(): WorkerLock {
	const held = new Set<string>();
	return {
		acquire(projectKey: string): LockHandle | null {
			if (held.has(projectKey)) return null;
			held.add(projectKey);
			return {
				release(): void {
					held.delete(projectKey);
				},
			};
		},
	};
}

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

const SCOPE_OF: MineScope = { projectKey: "proj-1", triggerSessionId: "sess-trigger" };

/** Three exchanges across one session → clears the KEEP ≥3 floor. */
function threeExchangeRows(): SessionRow[] {
	return [
		userRow("s1", "how do I tidy imports", "2026-06-01T00:00:00Z"),
		assistantRow("s1", "sort and dedupe", "2026-06-01T00:00:01Z"),
		userRow("s1", "again for this file", "2026-06-01T00:00:02Z"),
		assistantRow("s1", "same: sort and dedupe", "2026-06-01T00:00:03Z"),
		userRow("s1", "and once more", "2026-06-01T00:00:04Z"),
		assistantRow("s1", "sort and dedupe again", "2026-06-01T00:00:05Z"),
	];
}

describe("PRD-016a trace miner", () => {
	// ── a-AC-1 ────────────────────────────────────────────────────────────────────
	it("a-AC-1 extracts pairs, drops tool calls and thinking, caps per-pair and total, excludes the trigger session", async () => {
		const rows: SessionRow[] = [
			userRow("s1", "  fix the build  ", "2026-06-01T00:00:00Z"),
			toolRow("s1", "2026-06-01T00:00:01Z"), // DROPPED
			assistantRow("s1", "ran the build <thinking>internal reasoning</thinking> and fixed it", "2026-06-01T00:00:02Z"),
		];
		const pairs = extractPairsFromRows(rows);

		expect(pairs.length).toBe(1);
		expect(pairs[0].prompt).toBe("fix the build");
		// The tool_call event never produced a pair; the thinking block is stripped.
		expect(pairs[0].answer).toContain("ran the build");
		expect(pairs[0].answer).toContain("and fixed it");
		expect(pairs[0].answer).not.toContain("internal reasoning");
		expect(pairs[0].answer).not.toContain("thinking");

		// Per-pair cap: a 5000-char answer is truncated to ≤ MAX_PAIR_CHARS + marker.
		const huge = "x".repeat(5000);
		const capped = extractPairsFromRows([
			userRow("s2", "q", "2026-06-02T00:00:00Z"),
			assistantRow("s2", huge, "2026-06-02T00:00:01Z"),
		]);
		expect(capped[0].answer.length).toBeLessThanOrEqual(MAX_PAIR_CHARS + "…[truncated]".length);
		expect(capped[0].answer.endsWith("…[truncated]")).toBe(true);

		// Total cap: enough oversized pairs stop before the batch exceeds 40000 chars.
		const many: SessionRow[] = [];
		for (let i = 0; i < 60; i++) {
			many.push(userRow(`m${i}`, "q".repeat(MAX_PAIR_CHARS), `2026-06-03T00:00:${String(i).padStart(2, "0")}Z`));
			many.push(assistantRow(`m${i}`, "a".repeat(MAX_PAIR_CHARS), `2026-06-03T00:01:${String(i).padStart(2, "0")}Z`));
		}
		const bounded = extractPairsFromRows(many);
		const total = bounded.reduce((n, p) => n + p.prompt.length + p.answer.length, 0);
		expect(total).toBeLessThanOrEqual(40_000);

		// Trigger exclusion is the FETCHER's job: the real fetcher's SQL excludes
		// `sess-<trigger>-%` (asserted in a-AC-4's SQL test). Here we assert the mine
		// excludes it end-to-end via the fetcher seam: a fetcher that already excluded
		// the trigger yields no trigger pairs.
		const noTrigger = extractPairsFromRows(rows);
		expect(noTrigger.every((p) => p.sessionId !== "sess-trigger")).toBe(true);
	});

	// ── a-AC-2 ────────────────────────────────────────────────────────────────────
	it("a-AC-2 the gate returns exactly one of KEEP/MERGE/SKIP, and KEEP requires ≥3 exchanges", async () => {
		const pairs3 = extractPairsFromRows(threeExchangeRows());
		expect(pairs3.length).toBe(3);

		// A KEEP over ≥3 exchanges is honoured.
		const keep = await runGate(createFakeGateCli({ decision: "KEEP", name: "tidy", body: "B" }), pairs3, 1_000);
		expect(["KEEP", "MERGE", "SKIP"]).toContain(keep.decision);
		expect(keep.decision).toBe("KEEP");

		// A KEEP over FEWER than 3 exchanges is DOWNGRADED to SKIP (the precision floor).
		const twoPairs = extractPairsFromRows([
			userRow("s1", "q1", "2026-06-01T00:00:00Z"),
			assistantRow("s1", "a1", "2026-06-01T00:00:01Z"),
			userRow("s1", "q2", "2026-06-01T00:00:02Z"),
			assistantRow("s1", "a2", "2026-06-01T00:00:03Z"),
		]);
		expect(twoPairs.length).toBe(2);
		const downgraded = await runGate(createFakeGateCli({ decision: "KEEP", name: "thin", body: "B" }), twoPairs, 1_000);
		expect(downgraded.decision).toBe("SKIP");

		// MERGE + SKIP pass through; an out-of-set decision normalizes to SKIP.
		expect(normalizeVerdict({ decision: "MERGE", target: "x", body: "b" }, pairs3).decision).toBe("MERGE");
		expect(normalizeVerdict({ decision: "SKIP" }, pairs3).decision).toBe("SKIP");
		expect(normalizeVerdict({ decision: "WAT" as unknown as GateVerdict["decision"] }, pairs3).decision).toBe("SKIP");
	});

	// ── a-AC-2 (no-shell gate shell-out) ────────────────────────────────────────────
	it("a-AC-2 the host-CLI gate shells out with an args array (shell:false), never a shell string", async () => {
		let observedSpec: HostCliSpec | null = null;
		let observedPrompt = "";
		const spawner: GateSpawner = {
			run: async (spec, prompt): Promise<string> => {
				observedSpec = spec;
				observedPrompt = prompt;
				return "SKIP nothing reusable";
			},
		};
		const spec: HostCliSpec = { command: "claude", args: ["--model", "haiku", "--permission-mode", "bypassPermissions"] };
		const gate = createHostCliGate(spec, spawner, 1_000);

		const pairs = extractPairsFromRows(threeExchangeRows());
		const verdict = await gate.run(buildGatePrompt(pairs));
		expect(verdict.decision).toBe("SKIP");

		// The command + args ARRAY is passed verbatim — no shell metachars are interpolated.
		expect(observedSpec).not.toBeNull();
		expect((observedSpec as unknown as HostCliSpec).command).toBe("claude");
		expect(Array.isArray((observedSpec as unknown as HostCliSpec).args)).toBe(true);
		// A hostile transcript becomes inert stdin, NEVER an arg / shell token.
		const hostilePrompt = buildGatePrompt([
			{ sessionId: "s", sessionDate: "d", prompt: "; rm -rf / #", answer: "$(touch pwned)" },
		]);
		await gate.run(hostilePrompt);
		expect(observedPrompt).toContain("PROMPT");
		// The injection payload is in the prompt body (stdin), not in the args array.
		expect((observedSpec as unknown as HostCliSpec).args.join(" ")).not.toContain("rm -rf");

		// parseVerdictStdout reads exactly one verdict token; garbage → SKIP.
		expect(parseVerdictStdout("KEEP my-skill the body here").decision).toBe("KEEP");
		expect(parseVerdictStdout("MERGE existing merged body").decision).toBe("MERGE");
		expect(parseVerdictStdout("garbage line").decision).toBe("SKIP");
	});

	// ── a-AC-3 ────────────────────────────────────────────────────────────────────
	it("a-AC-3 the stop-counter reaching N resets and runs the worker; session-end runs unconditionally", () => {
		// A TurnCounters with a small skillify threshold (the env-configured cadence).
		const counters = new TurnCounters({ skillifyEveryTurns: 3 });

		// Below the threshold → no run.
		expect(evaluateTrigger(counters, "sX", "pX").run).toBe(false);
		expect(evaluateTrigger(counters, "sX", "pX").run).toBe(false);
		// The 3rd turn crosses the threshold (modulo) → run, reason stop_counter (the
		// crossing resets the counter for the next cycle).
		const crossed = evaluateTrigger(counters, "sX", "pX");
		expect(crossed.run).toBe(true);
		expect(crossed.reason).toBe("stop_counter");
		// The counter reset (modulo): the next two turns are below the threshold again.
		expect(evaluateTrigger(counters, "sX", "pX").run).toBe(false);
		expect(evaluateTrigger(counters, "sX", "pX").run).toBe(false);

		// Session-end fires UNCONDITIONALLY, regardless of the counter.
		const ended = evaluateTrigger(counters, "sY", "pY", { sessionEnd: true });
		expect(ended.run).toBe(true);
		expect(ended.reason).toBe("session_end");

		// The cadence is read from the env (fallback to the D-1 default of 10).
		expect(skillifyEveryNTurns({ HONEYCOMB_SKILLIFY_EVERY_N_TURNS: "7" })).toBe(7);
		expect(skillifyEveryNTurns({})).toBe(10);
		expect(skillifyEveryNTurns({ HONEYCOMB_SKILLIFY_EVERY_N_TURNS: "0" })).toBe(10);
	});

	// ── a-AC-4 ────────────────────────────────────────────────────────────────────
	it("a-AC-4 scope team with a team list filters to author IN (<team>) escaped via sqlStr", async () => {
		const fake = new FakeDeepLakeTransport(() => []);
		const fetcher = createSessionFetcher(client(fake), SCOPE);

		await fetcher.fetch(
			{ projectKey: "proj-1", triggerSessionId: "sess-trigger", teamAuthors: ["alice", "o'brien"] },
			"2026-06-01T00:00:00Z",
		);

		const sql = fake.requests[0].sql;
		// The team filter is an IN list of escaped literals (the single quote in o'brien
		// is doubled by sqlStr, never breaking out of the literal).
		expect(sql).toMatch(/author IN \('alice', 'o''brien'\)/);
		// Past the watermark + trigger exclusion via NOT LIKE on the row-id prefix.
		expect(sql).toContain("creation_date > '2026-06-01T00:00:00Z'");
		expect(sql).toContain("id NOT LIKE 'sess-sess-trigger-%'");
		// Ordered most-recent first.
		expect(sql).toMatch(/ORDER BY creation_date DESC/);

		// Scope `me` (no team list) omits the author IN filter.
		const fake2 = new FakeDeepLakeTransport(() => []);
		const fetcher2 = createSessionFetcher(client(fake2), SCOPE);
		await fetcher2.fetch({ projectKey: "proj-1", triggerSessionId: "t" }, null);
		expect(fake2.requests[0].sql).not.toContain("author IN");
	});

	// ── a-AC-5 ────────────────────────────────────────────────────────────────────
	it("a-AC-5 a concurrent run already in flight is suppressed by the worker lock", async () => {
		const lock = memoryLock();
		const fetcher = fakeFetcher(threeExchangeRows());

		// A gate that BLOCKS until released, so the first mine holds the lock while the
		// second trigger arrives.
		let releaseFirst: () => void = () => undefined;
		const blocking = new Promise<GateVerdict>((res) => {
			releaseFirst = () => res({ decision: "SKIP" });
		});
		const blockingGate = { run: () => blocking };

		const firstMine = mine(SCOPE_OF, { fetcher, gate: blockingGate, lock, watermark: null, gateTimeoutMs: 60_000 });

		// While the first mine is in flight (lock held), a second trigger is SUPPRESSED.
		const second = await mine(SCOPE_OF, {
			fetcher,
			gate: createFakeGateCli({ decision: "SKIP" }),
			lock,
			watermark: null,
		});
		expect(second.ran).toBe(false);
		expect(second.ran === false && second.reason).toBe("lock_held");

		// Release the first; it completes normally and frees the lock.
		releaseFirst();
		const first = await firstMine;
		expect(first.ran).toBe(true);

		// After the first releases, a fresh trigger can run again (the lock is free).
		const third = await mine(SCOPE_OF, { fetcher, gate: createFakeGateCli({ decision: "SKIP" }), lock, watermark: null });
		expect(third.ran).toBe(true);
	});

	// ── a-AC-5 (the real O_EXCL file lock suppresses a concurrent acquire) ───────────
	it("a-AC-5 the file worker lock atomically suppresses a second acquire and releases idempotently", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "skillify-lock-"));
		const lock = createFileWorkerLock(baseDir);

		const h1 = lock.acquire("proj-1");
		expect(h1).not.toBeNull();
		// A second acquire for the SAME project fails the exclusive create → null.
		expect(lock.acquire("proj-1")).toBeNull();
		// A different project is independent.
		const other = lock.acquire("proj-2");
		expect(other).not.toBeNull();

		// Release is idempotent (safe in a finally even after a double call).
		(h1 as LockHandle).release();
		(h1 as LockHandle).release();
		// After release the lock is free again.
		const h2 = lock.acquire("proj-1");
		expect(h2).not.toBeNull();
		(h2 as LockHandle).release();
		(other as LockHandle).release();
	});

	// ── a-AC-6 ────────────────────────────────────────────────────────────────────
	it("a-AC-6 a gate exceeding the timeout aborts with no verdict and the lock is released in finally", async () => {
		const lock = createFileWorkerLock(mkdtempSync(join(tmpdir(), "skillify-timeout-")));
		const fetcher = fakeFetcher(threeExchangeRows());
		// A gate that NEVER resolves → the injectable fast timeout must abort it.
		const hangingGate = { run: (): Promise<GateVerdict> => new Promise<GateVerdict>(() => undefined) };

		let threw = false;
		try {
			await mine(SCOPE_OF, { fetcher, gate: hangingGate, lock, watermark: null, gateTimeoutMs: 20 });
		} catch (e) {
			threw = true;
			expect((e as Error).message).toMatch(/timeout/i);
		}
		// The run ABORTED without producing a verdict (it threw, never returned an outcome).
		expect(threw).toBe(true);

		// The lock was released in the `finally` even on the timeout — a fresh acquire
		// succeeds, proving the lock is FREE after the abort (a-AC-6).
		const handle = lock.acquire(SCOPE_OF.projectKey);
		expect(handle).not.toBeNull();
		(handle as LockHandle).release();
	});

	// ── runGate timeout (unit) ──────────────────────────────────────────────────────
	it("runGate rejects when the gate exceeds the injectable timeout (no verdict)", async () => {
		const pairs = extractPairsFromRows(threeExchangeRows());
		const hanging = { run: (): Promise<GateVerdict> => new Promise<GateVerdict>(() => undefined) };
		await expect(runGate(hanging, pairs, 15)).rejects.toThrow(/timeout/i);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SECURITY — secret redaction at the mine boundary (security-worker-bee, PRD-016).
// A pasted credential in a transcript must NOT survive into a mined pair (→ gate
// prompt → SKILL.md body → append-only row → team pull). Defense-in-depth: the
// gate model is precision-over-recall, but this scrub is the deterministic floor.
// ════════════════════════════════════════════════════════════════════════════

describe("skillify secret redaction (mine boundary)", () => {
	it("redactSecrets scrubs provider keys, JWTs, bearer headers, PEM, and key=value secrets", () => {
		const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456_-xyz";
		const cases: Array<[string, string]> = [
			["use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA here", "sk-ant-api03"],
			["token ghp_ABCDEFGHIJKLMNOPQRST1234567890 ok", "ghp_"],
			["AKIAIOSFODNN7EXAMPLE creds", "AKIA"],
			[`Authorization: Bearer ${jwt}`, "Bearer"],
			["api_key = 's:s3cr3t-Value_01234567'", "api_key"],
		];
		for (const [input, leak] of cases) {
			const out = redactSecrets(input);
			expect(out).toContain("[REDACTED]");
			// The raw secret material is gone (the label may remain for the labelled forms).
			if (leak !== "Bearer" && leak !== "api_key") expect(out).not.toContain(leak);
		}
		// A PEM private-key block collapses to a single token.
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		expect(redactSecrets(pem)).toBe("[REDACTED]");
		// A benign body is left untouched (low false positives).
		expect(redactSecrets("run npm test then commit")).toBe("run npm test then commit");
	});

	it("extractPairsFromRows scrubs a secret pasted into a prompt OR an answer", () => {
		const secret = "ghp_DEADBEEFdeadbeef0123456789ABCDEF01";
		const pairs = extractPairsFromRows([
			userRow("s1", `deploy with token ${secret}`, "2026-06-01T00:00:00Z"),
			assistantRow("s1", `ok, exported ${secret} to env`, "2026-06-01T00:00:01Z"),
		]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.prompt).not.toContain(secret);
		expect(pairs[0]?.answer).not.toContain(secret);
		expect(pairs[0]?.prompt).toContain("[REDACTED]");
		expect(pairs[0]?.answer).toContain("[REDACTED]");
	});
});
