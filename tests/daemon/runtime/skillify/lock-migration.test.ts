/**
 * PRD-072 index AC-1 + AC-072b (QA Critical 1) — the skillify worker-lock paths cut over to the
 * fleet root, INCLUDING the production defaults (no injected override).
 *
 * The audited gap: `worker.ts`/`miner.ts` hardcoded `~/.honeycomb/state/skillify` as the lock base,
 * so every production skillify run recreated the legacy dir on a fresh install (breaching AC-1)
 * immediately after the skillify-state mover cleaned it. These tests pin the PRODUCTION defaults
 * (the same no-arg calls the daemon assembly reaches) against the per-test isolated home, plus the
 * window fallback: a pre-existing legacy lock still suppresses a run (read-only; never created).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createFileWorkerLock,
	defaultLockBaseDir,
	legacyLockBaseDir,
} from "../../../../src/daemon/runtime/skillify/miner.js";

describe("QA Critical 1 / index AC-1 — the production-default lock base dirs (no injected override)", () => {
	it("AC-1 defaultLockBaseDir resolves under ~/.apiary/honeycomb/state/skillify, never ~/.honeycomb", () => {
		// The PRODUCTION default (what `worker.ts` reaches when the assembly injects no lock), resolved
		// against the per-test isolated home the global setup pins.
		expect(defaultLockBaseDir()).toBe(join(homedir(), ".apiary", "honeycomb", "state", "skillify"));
		expect(defaultLockBaseDir()).not.toContain(join(homedir(), ".honeycomb"));
	});

	it("AC-1 acquiring via the production default creates the lock ONLY under the new root", () => {
		const lock = createFileWorkerLock(); // the no-arg production default
		const handle = lock.acquire("proj-a");
		try {
			expect(handle).not.toBeNull();
			expect(existsSync(join(defaultLockBaseDir(), "proj-a", "worker.lock"))).toBe(true);
			// Nothing honeycomb-owned lands under the legacy dir (index AC-1).
			expect(existsSync(join(homedir(), ".honeycomb"))).toBe(false);
		} finally {
			handle?.release();
		}
	});

	it("legacyLockBaseDir names the legacy root the window fallback probes", () => {
		expect(legacyLockBaseDir()).toBe(join(homedir(), ".honeycomb", "state", "skillify"));
	});
});

describe("QA Critical 1 — the legacy-fallback read for a pre-existing in-flight lock", () => {
	let base: string;
	let legacyBase: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "hc-lock-new-"));
		legacyBase = mkdtempSync(join(tmpdir(), "hc-lock-legacy-"));
	});
	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
		rmSync(legacyBase, { recursive: true, force: true });
	});

	it("a pre-existing LEGACY lock suppresses the run (read-only probe, nothing created)", () => {
		mkdirSync(join(legacyBase, "proj-a"), { recursive: true });
		writeFileSync(join(legacyBase, "proj-a", "worker.lock"), "");

		const lock = createFileWorkerLock(base, legacyBase);
		expect(lock.acquire("proj-a")).toBeNull();
		// The suppressed acquire never created a lock at the new path.
		expect(existsSync(join(base, "proj-a", "worker.lock"))).toBe(false);
	});

	it("with no legacy lock present, acquire takes the NEW lock and a racer is suppressed", () => {
		const lock = createFileWorkerLock(base, legacyBase);
		const handle = lock.acquire("proj-a");
		expect(handle).not.toBeNull();
		expect(existsSync(join(base, "proj-a", "worker.lock"))).toBe(true);
		expect(lock.acquire("proj-a")).toBeNull(); // the second racer loses (unchanged semantics)
		handle?.release();
		expect(existsSync(join(base, "proj-a", "worker.lock"))).toBe(false);
	});

	it("the legacy probe is scoped per project: another project's legacy lock does not suppress", () => {
		mkdirSync(join(legacyBase, "proj-b"), { recursive: true });
		writeFileSync(join(legacyBase, "proj-b", "worker.lock"), "");

		const lock = createFileWorkerLock(base, legacyBase);
		const handle = lock.acquire("proj-a");
		expect(handle).not.toBeNull();
		handle?.release();
	});
});
