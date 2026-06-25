/**
 * PRD-049c — the END-TO-END promotion round-trip the engine-only tests did not cover.
 *
 * `promoteSkill`/`promoteToMyProjects`/`promoteWorkspaceWide` (`skillify/promote.ts`) were exported
 * + unit-tested, but UNREACHABLE: no CLI verb or HTTP route called them, so a real user could not
 * trigger a promotion. This suite drives the NEW shipped surface end-to-end and proves the reopened
 * ACs are now satisfied THROUGH a real surface:
 *
 *   - 49c-AC-2: a skill explicitly promoted IS surfaced in a DIFFERENT project of the user, with its
 *     cross-project provenance visible. Driven through `POST /api/skills/promote` (the daemon route)
 *     and then read back through the REAL surfacing path (`GET /api/skills` → `fetchSkills`, scoped
 *     to a different project header) — the same SQL production serves.
 *   - 49c-AC-4: promotion is an EXPLICIT, provenance-recorded operation. The promoted row carries
 *     `cross_project_scope` + `promoted_by`/`promoted_at`/`promoted_from_project`; the actor is the
 *     authenticated `x-honeycomb-actor`, never a forgeable body field; a mined row stays `none`.
 *   - The partition guard: a promote with no resolvable org (team mode, no header) fails closed 400
 *     — promotion widens surfacing WITHIN the caller's authorized org/workspace, it cannot escape it.
 *
 * Verification posture: a STATEFUL in-memory storage fake that behaves like the append-only `skills`
 * table — it records every INSERT and answers the highest-version reads. This exercises the REAL
 * `createSkillStore` write, the REAL promote engine, the REAL daemon route, AND the REAL surfacing
 * SELECT (`buildHighestVersionSql` + `buildProjectScopeClause`) — a genuine round-trip, no live DeepLake.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import { ok } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { mountSkillsReadApi } from "../../../../src/daemon/runtime/product/api.js";
import {
	mountSkillPropagationApi,
	SKILLS_PROPAGATION_GROUP,
} from "../../../../src/daemon/runtime/skillify/index.js";
import { CWD_HEADER } from "../../../../src/daemon/runtime/scope.js";

const SKILLS_GROUP = SKILLS_PROPAGATION_GROUP;

/**
 * A STATEFUL in-memory `skills` table. Records each INSERT (append-only) and serves the two read
 * shapes the promote + surfacing paths issue:
 *   - the promote store's `resolveCurrentRow`: `SELECT * ... WHERE "id" = 'X' ORDER BY "version" DESC`;
 *   - the surfacing read's self-join: `SELECT ... FROM "skills" s JOIN (… MAX(version) …) … WHERE (…)`.
 * The project WHERE fragment is honoured by inspecting which `project_id`/`cross_project_scope`
 * literals it admits — exactly the disjunction `buildProjectScopeClause` emits. The test inputs are
 * simple ASCII (no embedded quotes), so the small value tokenizer is reliable.
 */
class SkillsTableFake implements StorageQuery {
	public readonly rows: StorageRow[] = [];

	query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		if (/^\s*INSERT\s+INTO\s+"?skills"?/i.test(sql)) {
			this.rows.push(parseInsert(sql));
			return Promise.resolve(ok([], 1));
		}
		// The promote store's by-id highest-version read (`sqlIdent` emits a BARE `id`, not `"id"`).
		const byId = /WHERE\s+"?id"?\s*=\s*'([^']*)'\s+ORDER\s+BY/i.exec(sql);
		if (byId) {
			const id = byId[1] as string;
			const row = this.highestById(id);
			return Promise.resolve(ok(row === null ? [] : [row], 1));
		}
		// The surfacing self-join read (no by-id filter): highest-version-per-id, then the project clause.
		if (/FROM\s+"?skills"?\s+s\s+JOIN/i.test(sql)) {
			return Promise.resolve(ok(this.surface(sql), 1));
		}
		return Promise.resolve(ok([], 1));
	}

	private highestById(id: string): StorageRow | null {
		let best: StorageRow | null = null;
		for (const r of this.rows) {
			if (String(r.id) !== id) continue;
			if (best === null || Number(r.version) >= Number(best.version)) best = r;
		}
		return best;
	}

	/** Highest-version-per-id rows that pass the project clause embedded in `sql`. */
	private surface(sql: string): StorageRow[] {
		const latestById = new Map<string, StorageRow>();
		for (const r of this.rows) {
			const prior = latestById.get(String(r.id));
			if (prior === undefined || Number(r.version) >= Number(prior.version)) latestById.set(String(r.id), r);
		}
		const admittedProjects = new Set(matchAll(sql, /"?project_id"?\s*=\s*'([^']*)'/gi));
		const admittedReaches = new Set(matchAll(sql, /"?cross_project_scope"?\s*=\s*'([^']*)'/gi));
		return [...latestById.values()].filter((r) => {
			const project = String(r.project_id ?? "");
			const reach = String(r.cross_project_scope ?? "none");
			return admittedProjects.has(project) || (reach !== "none" && admittedReaches.has(reach));
		});
	}
}

/** Collect every capture-group-1 match of `re` over `sql`. */
function matchAll(sql: string, re: RegExp): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) out.push(m[1] as string);
	return out;
}

/** Parse an `INSERT INTO "skills" (cols) VALUES (vals)` into a row dict (`'…'` / `E'…'` / numbers). */
function parseInsert(sql: string): StorageRow {
	const m = /\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is.exec(sql);
	if (m === null) return {};
	const cols = (m[1] as string).split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	const vals = splitTopLevel(m[2] as string);
	const row: Record<string, unknown> = {};
	cols.forEach((col, i) => {
		row[col] = decodeValue((vals[i] ?? "").trim());
	});
	return row as StorageRow;
}

/** Split a VALUES list on top-level commas, respecting `'…'` / `E'…'` string literals. */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let buf = "";
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (inStr) {
			buf += ch;
			if (ch === "'") inStr = false;
			continue;
		}
		if (ch === "'") {
			inStr = true;
			buf += ch;
			continue;
		}
		if (ch === ",") {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim() !== "") out.push(buf);
	return out;
}

/** Decode a single rendered SQL value: `'x'` / `E'x'` → string; a bare numeric → number. */
function decodeValue(raw: string): unknown {
	const s = raw.trim();
	const str = /^E?'(.*)'$/is.exec(s);
	if (str) return (str[1] as string).replace(/''/g, "'");
	const n = Number(s);
	return Number.isFinite(n) ? n : s;
}

/** A `Daemon`-shaped harness whose `group()` serves ONE shared router for `/api/skills`. */
function makeDaemon(storage: StorageQuery, mode: "local" | "team" = "local") {
	const app = new Hono();
	const router = app.basePath(SKILLS_GROUP);
	const daemon = {
		app,
		group: (path: string): Hono | undefined => (path === SKILLS_GROUP ? router : undefined),
		storage,
		config: { mode, port: 0 },
	};
	// Mount BOTH the surfacing read (GET) and the propagation actions (POST /promote) on the same group.
	mountSkillsReadApi(daemon as unknown as Daemon, storage);
	mountSkillPropagationApi(daemon as unknown as Daemon, { storage });
	return app;
}

/** Seed a mined v1 row in `proj-A`, unpromoted — the shape `writeSkill` produces (scope `none`). */
function seedMinedRow(storage: SkillsTableFake, name: string, author: string): void {
	storage.rows.push({
		id: `${name}--${author}`,
		name,
		project_id: "proj-A",
		scope: "me",
		install: "global",
		author,
		version: 1,
		cross_project_scope: "none",
		promoted_by: "",
		promoted_at: "",
		promoted_from_project: "",
	});
}

const ORG_HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-actor": "alice", "content-type": "application/json" };

/** Read the surfaced skills for a session whose cwd resolves to `projectId` (the surfacing path). */
async function surfacedIn(app: Hono, projectId: string): Promise<Array<{ id: string; crossProjectScope: string; promotedFromProject: string }>> {
	// The read resolves the project from the cwd header; we pass the project id directly via the
	// explicit project header so the surfacing read scopes to exactly `projectId` (049e posture).
	const res = await app.request(`${SKILLS_GROUP}`, {
		method: "GET",
		headers: { ...ORG_HEADERS, "x-honeycomb-project": projectId, [CWD_HEADER]: "" },
	});
	const json = (await res.json()) as { skills: Array<{ id: string; crossProjectScope: string; promotedFromProject: string }> };
	return json.skills;
}

describe("PRD-049c promote round-trip — the verb is REACHABLE end-to-end (49c-AC-2 / 49c-AC-4)", () => {
	it("49c-AC-2 (default reach) a promoted skill surfaces in a DIFFERENT project with visible cross-project provenance", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "tidy-imports", "alice");
		const app = makeDaemon(storage);

		// BEFORE promotion: the skill is isolated to proj-A — it does NOT surface in proj-B (49c-AC-1).
		expect((await surfacedIn(app, "proj-B")).some((s) => s.id === "tidy-imports--alice")).toBe(false);

		// PROMOTE through the SHIPPED route (default reach = this user's other projects).
		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: ORG_HEADERS,
			body: JSON.stringify({ name: "tidy-imports", author: "alice" }),
		});
		expect(res.status).toBe(200);
		const outcome = (await res.json()) as { promoted: boolean; crossProjectScope: string; version: number; promotedFromProject: string };
		expect(outcome.promoted).toBe(true);
		expect(outcome.crossProjectScope).toBe("user");
		expect(outcome.version).toBe(2); // append-only N+1 (49c-AC-4 — never an in-place mutation).
		expect(outcome.promotedFromProject).toBe("proj-A"); // origin preserved + recorded.

		// AFTER promotion: it NOW surfaces in proj-B (a DIFFERENT project of the user) — 49c-AC-2…
		const inB = await surfacedIn(app, "proj-B");
		const hit = inB.find((s) => s.id === "tidy-imports--alice");
		expect(hit, "the promoted skill must surface in project B").toBeDefined();
		// …and the cross-project provenance is VISIBLE on the surfaced row (promoted from <origin>).
		expect(hit?.crossProjectScope).toBe("user");
		expect(hit?.promotedFromProject).toBe("proj-A");
	});

	it("49c-AC-2 (--workspace-wide) a workspace-wide promotion surfaces in a different project too", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "house-style", "alice");
		const app = makeDaemon(storage);

		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: ORG_HEADERS,
			body: JSON.stringify({ name: "house-style", author: "alice", workspaceWide: true }),
		});
		expect(res.status).toBe(200);
		const outcome = (await res.json()) as { crossProjectScope: string; version: number };
		expect(outcome.crossProjectScope).toBe("workspace");
		expect(outcome.version).toBe(2);

		const hit = (await surfacedIn(app, "proj-B")).find((s) => s.id === "house-style--alice");
		expect(hit?.crossProjectScope).toBe("workspace");
		expect(hit?.promotedFromProject).toBe("proj-A");
	});

	it("49c-AC-4 the promotion provenance (promoted_by/at/from_project + reach) is RECORDED on the appended row", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "tidy-imports", "alice");
		const app = makeDaemon(storage);

		await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: ORG_HEADERS,
			body: JSON.stringify({ name: "tidy-imports", author: "alice" }),
		});

		// A NEW version row was appended (append-only) carrying the full promotion provenance.
		const promoted = storage.rows.find((r) => Number(r.version) === 2);
		expect(promoted, "a v2 promotion row was appended").toBeDefined();
		expect(promoted?.cross_project_scope).toBe("user");
		expect(promoted?.promoted_by).toBe("alice"); // the AUTHENTICATED actor, not a body field.
		expect(promoted?.promoted_from_project).toBe("proj-A"); // origin preserved.
		expect(String(promoted?.promoted_at).length).toBeGreaterThan(0); // a timestamp was stamped.
		// The mined v1 row is UNTOUCHED — still `none` (mining never promotes, 49c-AC-4).
		const mined = storage.rows.find((r) => Number(r.version) === 1);
		expect(mined?.cross_project_scope).toBe("none");
	});

	it("49c-AC-4 promoting an ABSENT skill is a no-op (promotion never CREATES a row)", async () => {
		const storage = new SkillsTableFake();
		const app = makeDaemon(storage);
		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: ORG_HEADERS,
			body: JSON.stringify({ name: "ghost", author: "alice" }),
		});
		expect(res.status).toBe(200);
		const outcome = (await res.json()) as { promoted: boolean };
		expect(outcome.promoted).toBe(false);
		expect(storage.rows.length).toBe(0);
	});

	it("partition guard — promote takes promoted_by from the AUTHENTICATED actor, never a forgeable body field", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "tidy-imports", "alice");
		const app = makeDaemon(storage);

		// A body that TRIES to forge `promotedBy: 'mallory'` is ignored — the header actor wins.
		await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: { ...ORG_HEADERS, "x-honeycomb-actor": "alice" },
			body: JSON.stringify({ name: "tidy-imports", author: "alice", promotedBy: "mallory" }),
		});
		const promoted = storage.rows.find((r) => Number(r.version) === 2);
		expect(promoted?.promoted_by).toBe("alice");
	});

	it("partition guard — promote with no resolvable org (team mode, no header) FAILS CLOSED 400 (cannot escape the partition)", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "tidy-imports", "alice");
		const app = makeDaemon(storage, "team");
		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: { "x-honeycomb-actor": "alice", "content-type": "application/json" },
			body: JSON.stringify({ name: "tidy-imports", author: "alice" }),
		});
		expect(res.status).toBe(400);
		// Nothing was written — the promote never reached the store (the partition gate fired first).
		expect(storage.rows.every((r) => Number(r.version) === 1)).toBe(true);
	});

	it("the daemon rejects a malformed promote body at the zod boundary → 400", async () => {
		const storage = new SkillsTableFake();
		const app = makeDaemon(storage);
		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: ORG_HEADERS,
			body: JSON.stringify({ name: "" }), // missing author + blank name.
		});
		expect(res.status).toBe(400);
	});

	it("the daemon requires an actor header for a promote → 400 (provenance must name who acted)", async () => {
		const storage = new SkillsTableFake();
		seedMinedRow(storage, "tidy-imports", "alice");
		const app = makeDaemon(storage);
		const res = await app.request(`${SKILLS_GROUP}/promote`, {
			method: "POST",
			headers: { "x-honeycomb-org": "acme", "content-type": "application/json" },
			body: JSON.stringify({ name: "tidy-imports", author: "alice" }),
		});
		expect(res.status).toBe(400);
	});
});
