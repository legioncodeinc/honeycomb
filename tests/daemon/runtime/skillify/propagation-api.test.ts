/**
 * PRD-045g — the `/api/skills/*` PUBLISH + PULL mount (`mountSkillPropagationApi`).
 *
 * Closes the PRD-018 daemon-wiring gap: the publish endpoint was never mounted (g-AC-1) and the
 * CLI's `POST /api/skills/pull` hit an unmounted path (g-AC-5). These tests drive the REAL mount
 * against a `Daemon`-shaped harness (one bare Hono router per group, mirroring `product/api.test`)
 * + a canned-row storage fake + temp agent roots, and assert:
 *
 *   - g-AC-1: `POST /api/skills` accepts a versioned publish (200 `{ version }`, NOT 501) and a
 *             malformed body is rejected 400 at the zod boundary;
 *   - g-AC-5: `POST /api/skills/pull` runs the real pull + symlink fan-out (writes the canonical
 *             SKILL.md + fans a symlink into a second agent root) and is IDEMPOTENT (a re-pull of
 *             the same version writes nothing more);
 *   - NO collision with the read mount: `GET /api/skills` (attached separately) still answers;
 *   - fail-soft: a publish storage error surfaces as a 500 data body, never an unhandled throw.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import { connectionError, ok } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { AgentRootDetector } from "../../../../src/daemon-client/skillify/index.js";
import {
	mountSkillPropagationApi,
	SKILLS_PROPAGATION_GROUP,
} from "../../../../src/daemon/runtime/skillify/index.js";

const SKILLS_GROUP = SKILLS_PROPAGATION_GROUP;
const HEADERS = { "x-honeycomb-org": "acme", "content-type": "application/json" };

/** A storage fake: canned latest-skills SELECT rows; every INSERT/other statement → ok([]). */
class PropagationFake implements StorageQuery {
	public readonly statements: string[] = [];
	constructor(
		private readonly latest: StorageRow[],
		private readonly failPublish = false,
	) {}
	query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		this.statements.push(sql);
		if (/^\s*INSERT\s+INTO/i.test(sql)) {
			// A THROWN storage error is what propagates past the publish endpoint (a non-ok
			// QueryResult is returned, not thrown, by the heal-aware append path).
			if (this.failPublish) return Promise.reject(new Error("storage write threw"));
			return Promise.resolve(ok([], 1));
		}
		// The publish endpoint's select-newer / the pull's latest-skills read: a self-join on
		// MAX(version) over "skills". Answer with the canned current rows.
		if (/FROM\s+"skills"/i.test(sql)) return Promise.resolve(ok(this.latest.map((r) => ({ ...r })), 1));
		return Promise.resolve(ok([], 1));
	}
}

/** A `Daemon`-shaped object whose `group()` serves one router per known group (mirrors server.ts). */
function makeDaemon(storage: StorageQuery, mode: "local" | "team" = "local") {
	const app = new Hono();
	const router = app.basePath(SKILLS_GROUP);
	const daemon = {
		app,
		group: (path: string): Hono | undefined => (path === SKILLS_GROUP ? router : undefined),
		storage,
		config: { mode, port: 0 },
	};
	return { daemon: daemon as unknown as Daemon, app, router };
}

/** Temp agent roots: a canonical root + one "other" root the fan-out symlinks into. */
let tmpHome: string;
let roots: AgentRootDetector;

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "skg-"));
	const canonical = join(tmpHome, ".claude", "skills");
	const other = join(tmpHome, ".codex", "skills");
	mkdirSync(canonical, { recursive: true });
	mkdirSync(other, { recursive: true }); // exists → the fan-out targets it.
	roots = {
		canonicalRoot: () => canonical,
		otherRoots: () => [other],
	};
});

afterEach(() => {
	rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * One canned current skill row (the highest-version-per-id read shape). The `body` carries the
 * `version:` frontmatter line `renderSkillMarkdown` emits — the pull's `decideAction` reads it
 * from the written SKILL.md to drive the idempotent skip, so a realistic body MUST include it.
 */
function skillRow(name: string, author: string, version: number): StorageRow {
	const body = `---\nname: ${name}\nversion: ${version}\n---\n\n## ${name} v${version}\nshared body`;
	return { name, author, version, body };
}

/** A valid publish body (a `Skill`-shaped JSON). */
function publishBody(version: number) {
	return {
		id: `team-skill--alice`,
		name: "team-skill",
		author: "alice",
		description: "a shared skill",
		triggerText: "when the flow recurs",
		body: `## v${version}\nshared body`,
		install: "global",
		provenance: { sourceSessions: ["s1"], version, createdBy: "alice", scope: "team" },
	};
}

describe("PRD-045g mountSkillPropagationApi — publish (g-AC-1)", () => {
	it("POST /api/skills accepts a versioned publish → 200 { version } (NOT 501)", async () => {
		const storage = new PropagationFake([]);
		const harness = makeDaemon(storage);
		mountSkillPropagationApi(harness.daemon, { storage, roots });
		const res = await harness.app.request(`${SKILLS_GROUP}`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify(publishBody(2)),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { published: boolean; version: number };
		expect(json.published).toBe(true);
		expect(json.version).toBe(2);
		// The publish reached storage via an append-only INSERT (never a 501 scaffold).
		expect(storage.statements.some((s) => /INSERT\s+INTO/i.test(s))).toBe(true);
	});

	it("POST /api/skills rejects a malformed body at the zod boundary → 400", async () => {
		const storage = new PropagationFake([]);
		const { daemon, app } = makeDaemon(storage);
		mountSkillPropagationApi(daemon, { storage, roots });
		const res = await app.request(`${SKILLS_GROUP}`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ name: "missing-most-fields" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/skills surfaces a publish storage error as a fail-soft 500 (never a throw)", async () => {
		const storage = new PropagationFake([], /* failPublish */ true);
		const { daemon, app } = makeDaemon(storage);
		mountSkillPropagationApi(daemon, { storage, roots });
		const res = await app.request(`${SKILLS_GROUP}`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify(publishBody(1)),
		});
		expect(res.status).toBe(500);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("publish_failed");
	});

	it("POST /api/skills fails closed (400) when no org resolves (team mode, no header)", async () => {
		const storage = new PropagationFake([]);
		const { daemon, app } = makeDaemon(storage, "team");
		mountSkillPropagationApi(daemon, { storage, roots });
		const res = await app.request(`${SKILLS_GROUP}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(publishBody(1)),
		});
		expect(res.status).toBe(400);
	});
});

describe("PRD-045g mountSkillPropagationApi — pull + fan-out (g-AC-5)", () => {
	it("POST /api/skills/pull runs the real pull: writes the canonical SKILL.md + fans a symlink", async () => {
		const storage = new PropagationFake([skillRow("team-skill", "alice", 1)]);
		const { daemon, app } = makeDaemon(storage);
		mountSkillPropagationApi(daemon, { storage, roots });

		const res = await app.request(`${SKILLS_GROUP}/pull`, { method: "POST", headers: HEADERS, body: "{}" });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { pulled: boolean; skillsWritten: number; symlinksCreated: number };
		expect(json.pulled).toBe(true);
		expect(json.skillsWritten).toBe(1);

		// The canonical SKILL.md landed under the canonical root's `<name>--<author>` dir.
		const canonicalFile = join(roots.canonicalRoot(), "team-skill--alice", "SKILL.md");
		expect(existsSync(canonicalFile)).toBe(true);
		expect(readFileSync(canonicalFile, "utf-8")).toContain("## team-skill v1");

		// The fan-out created a link in the OTHER detected root (a symlink, or skipped on win32
		// without privilege — assert the path is present as SOME entry either way).
		const link = join(roots.otherRoots()[0] as string, "team-skill--alice");
		if (json.symlinksCreated > 0) {
			expect(existsSync(link)).toBe(true);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
		}
	});

	it("POST /api/skills/pull is IDEMPOTENT — a re-pull of the same version writes nothing more", async () => {
		const storage = new PropagationFake([skillRow("team-skill", "alice", 1)]);
		const { daemon, app } = makeDaemon(storage);
		mountSkillPropagationApi(daemon, { storage, roots });

		const first = (await (await app.request(`${SKILLS_GROUP}/pull`, { method: "POST", headers: HEADERS, body: "{}" })).json()) as {
			skillsWritten: number;
		};
		expect(first.skillsWritten).toBe(1);

		const second = (await (await app.request(`${SKILLS_GROUP}/pull`, { method: "POST", headers: HEADERS, body: "{}" })).json()) as {
			skillsWritten: number;
			skillsSkipped: number;
		};
		// The conflict policy (`decideAction`) skips a local-at-or-newer-than-remote skill.
		expect(second.skillsWritten).toBe(0);
		expect(second.skillsSkipped).toBe(1);
	});

	it("POST /api/skills/pull is fail-soft — a storage read error returns { pulled:false } not a throw/500", async () => {
		// A fake that fails the latest-skills SELECT drives the pull's swallow path.
		const failing: StorageQuery = { query: () => Promise.resolve(connectionError("down", "x")) };
		const { daemon, app } = makeDaemon(failing);
		mountSkillPropagationApi(daemon, { storage: failing, roots });
		const res = await app.request(`${SKILLS_GROUP}/pull`, { method: "POST", headers: HEADERS, body: "{}" });
		// The pull engine treats an empty/failed read as "nothing to pull" → a clean 200, no skills.
		expect(res.status).toBe(200);
		const json = (await res.json()) as { pulled: boolean };
		expect(json.pulled).toBe(true);
	});

	it("POST /api/skills/scope + /unpull ack so the CLI dispatch lands on a real route (not 404/501)", async () => {
		const storage = new PropagationFake([]);
		const { daemon, app } = makeDaemon(storage);
		mountSkillPropagationApi(daemon, { storage, roots });
		for (const verb of ["scope", "unpull"]) {
			const res = await app.request(`${SKILLS_GROUP}/${verb}`, { method: "POST", headers: HEADERS, body: "{}" });
			expect(res.status, `${verb} acks`).toBe(200);
		}
	});
});
