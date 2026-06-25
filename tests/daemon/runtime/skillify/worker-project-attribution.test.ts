/**
 * PRD-049c — the skillify WORKER stamps the mined skill's `project_id` from the session cwd
 * (49c-AC-1) and falls to the workspace `__unsorted__` inbox for an identity-less session
 * (49c-AC-5), and NEVER sets a promotion (49c-AC-4). The project resolution rides the SAME
 * thin-client `resolveScopeFromDisk` (049a) the capture path uses, scoped to the mine's
 * org/workspace; a seeded `projects.json` cache proves a bound cwd resolves to its project.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import {
	createFakeGateCli,
	type GateVerdict,
	type SessionFetcher,
	type SessionRow,
	type Skill,
	type SkillStore,
} from "../../../../src/daemon/runtime/skillify/index.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/hooks/shared/project-resolver.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { createSkillifyJobWorker } from "../../../../src/daemon/runtime/skillify/worker.js";

const SCOPE: QueryScope = { org: "o-049c", workspace: "ws-049c" };

function keepVerdict(): GateVerdict {
	return { decision: "KEEP", name: "u", body: "## u\nbody", description: "d", triggerText: "t" };
}

function skillifyJob(sessionId: string, path: string): JobInput {
	return { kind: "skillify", payload: { sessionId, path, count: 5 } };
}

function row(path: string, session: string, kind: string, text: string, date: string): SessionRow {
	return {
		path,
		sessionId: session,
		message: JSON.stringify({ event: { kind, text }, metadata: { sessionId: session, path } }),
		author: "alice",
		creationDate: date,
	};
}

function sixPairs(path: string, session: string): readonly SessionRow[] {
	return [
		row(path, session, "user_message", "how do I retry?", "2026-01-01T00:00:00Z"),
		row(path, session, "assistant_message", "wrap it in withRetry()", "2026-01-01T00:00:01Z"),
		row(path, session, "user_message", "and the backoff?", "2026-01-01T00:00:02Z"),
		row(path, session, "assistant_message", "exponential, capped", "2026-01-01T00:00:03Z"),
		row(path, session, "user_message", "where do I put it?", "2026-01-01T00:00:04Z"),
		row(path, session, "assistant_message", "the storage client wrapper", "2026-01-01T00:00:05Z"),
	];
}

function fakeFetcher(rows: readonly SessionRow[]): SessionFetcher {
	return { fetch: async (): Promise<readonly SessionRow[]> => rows };
}

const UNUSED_STORAGE: StorageQuery = {
	query: async () => {
		throw new Error("storage must not be touched when fetcher/store are overridden");
	},
};

function fakeQueue(): JobQueueService & { readonly completed: string[] } {
	const jobs = new Map<string, { job: LeasedJob; status: "queued" | "leased" }>();
	const completed: string[] = [];
	let seq = 0;
	return {
		completed,
		async enqueue(job: JobInput): Promise<string> {
			const id = `fake-job-${++seq}`;
			jobs.set(id, { job: { id, kind: job.kind, payload: job.payload, attempt: 1 }, status: "queued" });
			return id;
		},
		async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
			for (const [, entry] of jobs) {
				if (entry.status !== "queued") continue;
				if (kinds !== undefined && !kinds.includes(entry.job.kind)) continue;
				entry.status = "leased";
				return entry.job;
			}
			return null;
		},
		async complete(id: string): Promise<void> {
			completed.push(id);
		},
		async fail(): Promise<void> {},
		start(): void {},
		stop(): void {},
	};
}

function fakeSkillStore(): SkillStore & { readonly rows: Skill[] } {
	const rows: Skill[] = [];
	return {
		rows,
		async maxVersion(id: string): Promise<number> {
			return rows.filter((s) => s.id === id).reduce((m, s) => Math.max(m, s.provenance.version), 0);
		},
		async readActive(id: string): Promise<Skill | null> {
			const mine = rows.filter((s) => s.id === id);
			return mine.length === 0 ? null : mine.reduce((a, b) => (b.provenance.version >= a.provenance.version ? b : a));
		},
		async appendVersion(skill: Skill): Promise<number> {
			rows.push(skill);
			return skill.provenance.version;
		},
	};
}

/** Seed a `~/.deeplake/projects.json` binding `cwd → projectId` in a temp dir; return the dir. */
function seedProjectsCache(cwd: string, projectId: string, workspace: string): string {
	const dir = mkdtempSync(join(tmpdir(), "projects-cache-"));
	const cache = {
		schemaVersion: 1,
		org: SCOPE.org,
		workspace,
		bindings: [{ path: cwd, projectId }],
		projects: [],
	};
	writeFileSync(join(dir, "projects.json"), JSON.stringify(cache), "utf-8");
	return dir;
}

describe("PRD-049c skillify worker — project attribution at mine time", () => {
	// ── 49c-AC-1 — a bound cwd stamps the resolved project_id on the mined row ──
	it("49c-AC-1 a mined skill carries the project_id the session cwd resolves to (via resolveScopeFromDisk)", async () => {
		const queue = fakeQueue();
		const store = fakeSkillStore();
		// A bound folder → project: seed a cache binding the cwd to `proj-web`.
		const cwd = join(tmpdir(), `work${sep}web`);
		const projectsDir = seedProjectsCache(cwd, "proj-web", SCOPE.workspace as string);
		await queue.enqueue(skillifyJob("sess-web", "conv-web"));

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "alice",
			cwd,
			projectsDir,
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("conv-web", "sess-web")),
			storeOverride: store,
		});

		expect(await worker.runOnce()).toBe(true);
		expect(store.rows.length).toBe(1);
		expect(store.rows[0].provenance.projectId).toBe("proj-web");
		// 49c-AC-4: the mine path NEVER promotes.
		expect(store.rows[0].provenance.promotion).toBeUndefined();
	});

	// ── 49c-AC-5 — an identity-less session (no cwd) falls to the workspace __unsorted__ inbox ──
	it("49c-AC-5 a mined skill from an identity-less session (blank cwd) is tagged __unsorted__", async () => {
		const queue = fakeQueue();
		const store = fakeSkillStore();
		await queue.enqueue(skillifyJob("sess-x", "conv-x"));

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "alice",
			cwd: "", // identity-less: no cwd to resolve from → inbox (49c-AC-5), capture never dropped.
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("conv-x", "sess-x")),
			storeOverride: store,
		});

		expect(await worker.runOnce()).toBe(true);
		expect(store.rows.length).toBe(1);
		expect(store.rows[0].provenance.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(store.rows[0].provenance.promotion).toBeUndefined();
	});
});
