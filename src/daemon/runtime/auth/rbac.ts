/**
 * RBAC authorization policy — PRD-011c (the real 4-role matrix).
 *
 * This fills the {@link AuthorizationPolicy} seam (contracts.ts) the permission
 * middleware (permission.ts) already calls. It decides — for an ALREADY-VALIDATED
 * {@link Identity} (the authenticator ran first; a policy never sees an
 * unauthenticated caller) — whether a request may proceed, returning `allow` |
 * `forbidden`. `unauthenticated` belongs to the authenticator, not here.
 *
 * ── The 4-role matrix (D-1, pinned in contracts.ts ROLES) ───────────────────
 *
 *   role     | read | write | admin routes | token / connectors-admin routes
 *   ---------+------+-------+--------------+--------------------------------
 *   admin    | yes  | yes   | yes          | yes
 *   member   | yes  | yes¹  | no           | no
 *   readonly | yes  | NO→403| no           | no
 *   agent    | yes² | yes²  | no           | NO→403  (connector; no admin/token)
 *
 *   ¹ member writes within its own org/workspace/project scope only.
 *   ² agent reads+writes its own scoped data; denied every admin route, every
 *     token/credentials route, and the connectors-admin surface (c-AC-6).
 *
 * NOTE on the role vocabulary: the FROZEN Wave-1 contract (contracts.ts `ROLES`,
 * the EXECUTION_LEDGER D-1, and CONVENTIONS.md) pins the four roles to
 * `admin | member | readonly | agent`. The 011c PRD *prose* still names a stale
 * `operator` role; the index/ledger reconciled that to `member`, and the frozen
 * `Role` type is authoritative. This policy is built against `Role`.
 *
 * ── Why a data-driven table, not scattered string checks ────────────────────
 * Every classification decision (is this route an ADMIN route? a TOKEN /
 * connectors-admin route? is this method a WRITE?) reads from ONE auditable place:
 * {@link ROUTE_CAPABILITY_TABLE} maps a route-group prefix → the
 * {@link RequiredCapability} it demands, and {@link WRITE_METHODS} is the closed
 * set of mutating HTTP methods. Adding a route or retuning a capability is a
 * one-line table edit a reviewer can read top-to-bottom — never a grep across ad-hoc
 * `group.includes("secrets")` conditionals. Fail-closed: an UNKNOWN group is treated
 * as the most-restrictive capability (`admin`), so a newly mounted group is locked
 * down until it is explicitly classified.
 *
 * ── Decision order (matches the documented request pipeline, FR-8) ──────────
 *   1. capability gate  — does the role clear the EFFECTIVE capability this request
 *                         needs? (403). The effective capability folds the
 *                         read-vs-write method split into the route's classification
 *                         (see {@link effectiveCapability}), so a `readonly` GET on a
 *                         data route reads (it needs only `read`) while a `readonly`
 *                         POST needs `write` and is denied (c-AC-2). A sensitive
 *                         surface (`connectorsAdmin`/`admin`) is method-INDEPENDENT —
 *                         FR-6 requires an explicit check on every method, so an
 *                         agent GET to `/api/connectors` is still 403 (c-AC-6).
 *   2. project-scope gate — a scoped Identity targeting another project → 403
 *                           unless `admin` (c-AC-5)
 * The middleware runs the MODE gate (local open) and the CREDENTIAL gate (401)
 * BEFORE this policy is ever reached, so this file only ever reasons about an
 * authenticated caller in `team`/`hybrid` mode. `admin` clears every gate (c-AC-2).
 */

import {
	type AuthorizationContext,
	type AuthorizationPolicy,
	type AuthDecision,
	type Identity,
	type Role,
} from "./contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// Capabilities — the auditable vocabulary a route can demand of a role.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The capability a route group requires, ORDERED least → most privileged so the
 * table reads as a ladder:
 *   - `read`  — any authenticated role may read; a write method still applies the
 *     write gate on top (so `readonly` reads here but cannot write here).
 *   - `write` — a normal read/write data surface; every role EXCEPT `readonly`
 *     (on a write method) may use it. This is the default for the memory/data
 *     groups (FR-4: member + agent both remember/recall/modify/forget).
 *   - `connectorsAdmin` — the connectors-admin surface: `agent` connectors are
 *     denied here (c-AC-6) even though they may use ordinary data routes. Only
 *     `admin` and `member` (operator) administer connectors/sources.
 *   - `admin` — admin/token/org/secrets surface: ONLY `admin`. `member`,
 *     `readonly`, and `agent` are all forbidden (FR-6).
 */
export type RequiredCapability = "read" | "write" | "connectorsAdmin" | "admin";

/**
 * Which roles clear each capability, as a frozen matrix. This is the single
 * source the {@link decide} body consults — it never branches on a role name
 * inline. `readonly`'s presence in `write`/`connectorsAdmin`/`admin` is
 * deliberately ABSENT; its read access plus the write-method gate fully expresses
 * "recall only" (FR-4).
 */
const CAPABILITY_ROLES: Readonly<Record<RequiredCapability, ReadonlySet<Role>>> = Object.freeze({
	// Every authenticated role may READ (the write gate handles readonly-writes).
	read: new Set<Role>(["admin", "member", "readonly", "agent"]),
	// Normal data surface: everyone but readonly (and readonly only on reads).
	write: new Set<Role>(["admin", "member", "agent"]),
	// Connectors-admin surface: NOT agent (c-AC-6), NOT readonly.
	connectorsAdmin: new Set<Role>(["admin", "member"]),
	// Admin / token / org / secrets surface: admin ONLY (FR-6 / c-AC-6).
	admin: new Set<Role>(["admin"]),
});

// ────────────────────────────────────────────────────────────────────────────
// The route-group → required-capability table (the auditable classification).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The classification table: a route-group prefix (the `group` label the middleware
 * passes — the `spec.path` from `server.ts` `ROUTE_GROUPS`, e.g. `/api/secrets`)
 * → the {@link RequiredCapability} it demands. This is the ONE place route
 * sensitivity is declared; FR-6's "always-checked groups" (admin/token ops,
 * diagnostics, sources, connectors, secrets, ontology mutations, org/workspace
 * admin) are exactly the non-`read`/`write` rows here.
 *
 * Matching is longest-prefix (see {@link capabilityForGroup}) so `/api/connectors`
 * resolves before a hypothetical `/api`. A group NOT listed falls through to the
 * fail-closed default ({@link DEFAULT_CAPABILITY} = `admin`): an unclassified
 * surface is locked to admin until someone classifies it here.
 */
const ROUTE_CAPABILITY_TABLE: ReadonlyArray<readonly [prefix: string, capability: RequiredCapability]> =
	Object.freeze([
		// ── Admin / token / credentials surface — admin ONLY (FR-6, c-AC-6) ──────
		["/api/auth", "admin"], // token/credential operations
		["/api/org", "admin"], // org admin
		["/api/workspace", "admin"], // workspace admin
		["/api/secrets", "admin"], // secret operations
		["/api/update", "admin"], // self-update is an admin op
		["/api/git", "admin"], // repo write-through is an admin op

		// ── Connectors-admin surface — admin + member, NOT agent (c-AC-6) ────────
		["/api/connectors", "connectorsAdmin"],
		["/api/sources", "connectorsAdmin"],
		["/api/harnesses", "connectorsAdmin"],

		// ── Operator surface — admin + member (operator), NOT agent/readonly ─────
		// FR-4: diagnostics + analytics are operator-only (agent has neither).
		["/api/diagnostics", "connectorsAdmin"],
		["/api/pipeline", "connectorsAdmin"],
		["/api/repair", "connectorsAdmin"],
		["/api/logs", "connectorsAdmin"],
		["/api/kpis", "connectorsAdmin"],
		["/api/inference", "connectorsAdmin"],

		// ── Ontology mutations are admin-checked; reads pass the read gate ───────
		// The capability is `write`, so the write-method gate turns a mutation into
		// the explicit check FR-6 requires while a GET read still flows.
		["/api/ontology", "write"],
		["/api/graph", "write"],

		// ── Normal data surface — read+write for member & agent (FR-4) ──────────
		["/api/memories", "write"],
		["/memory", "write"],
		["/api/hooks", "write"],
		["/api/embeddings", "write"],
		["/api/documents", "write"],
		["/api/skills", "write"],
		["/api/rules", "write"],
		["/api/goals", "write"],
		["/api/tasks", "write"],
		["/mcp", "write"],
		["/v1", "write"],
	]);

/**
 * The fail-closed default capability for a group NOT in {@link ROUTE_CAPABILITY_TABLE}:
 * the MOST restrictive (`admin`). A freshly mounted, unclassified route is locked to
 * admin until it is explicitly added to the table — the module never widens on the
 * unknown (CONVENTIONS.md: when in doubt, DENY).
 */
const DEFAULT_CAPABILITY: RequiredCapability = "admin";

/**
 * The closed set of mutating HTTP methods (the read-vs-write split for c-AC-2).
 * A method NOT in this set (GET, HEAD, OPTIONS) is a READ; everything here is a
 * WRITE that `readonly` is denied. Uppercased on lookup so header casing never
 * matters.
 */
const WRITE_METHODS: ReadonlySet<string> = Object.freeze(
	new Set<string>(["POST", "PUT", "PATCH", "DELETE"]),
);

/** True when the HTTP method mutates state (→ the write gate applies, c-AC-2). */
function isWriteMethod(method: string): boolean {
	return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Resolve the required capability for a route group by longest-matching prefix in
 * {@link ROUTE_CAPABILITY_TABLE}. Longest-prefix wins so a more specific row
 * (`/api/connectors`) always beats a shorter one. An unmatched group → the
 * fail-closed {@link DEFAULT_CAPABILITY} (`admin`). Pure + total.
 */
function capabilityForGroup(group: string): RequiredCapability {
	let best: RequiredCapability | null = null;
	let bestLen = -1;
	for (const [prefix, capability] of ROUTE_CAPABILITY_TABLE) {
		const matches = group === prefix || group.startsWith(`${prefix}/`);
		if (matches && prefix.length > bestLen) {
			best = capability;
			bestLen = prefix.length;
		}
	}
	return best ?? DEFAULT_CAPABILITY;
}

/** True when `role` clears `capability` per the frozen {@link CAPABILITY_ROLES} matrix. */
function roleHasCapability(role: Role, capability: RequiredCapability): boolean {
	return CAPABILITY_ROLES[capability].has(role);
}

/**
 * Fold the read-vs-write method split into the route's classification to get the
 * capability THIS request actually needs:
 *   - a `read` or `write` data route → `read` on a non-mutating method, `write` on a
 *     mutating one. This is what lets a `readonly` role recall from a data route
 *     (needs only `read`) while a `readonly` write is denied (needs `write`, c-AC-2).
 *   - a `connectorsAdmin` / `admin` SENSITIVE route → the route capability itself,
 *     INDEPENDENT of method. FR-6 demands an explicit check on every method of these
 *     groups, so a GET to `/api/connectors` or `/api/secrets` is gated exactly like a
 *     POST (c-AC-6: an agent GET to a connectors-admin route is 403).
 */
function effectiveCapability(routeCapability: RequiredCapability, method: string): RequiredCapability {
	if (routeCapability === "read" || routeCapability === "write") {
		return isWriteMethod(method) ? "write" : "read";
	}
	return routeCapability; // sensitive surface: method-independent (FR-6).
}

/**
 * The project-scope gate (c-AC-5 / FR-7): a request targeting a project DIFFERENT
 * from the Identity's own `project` binding is denied — UNLESS the role is `admin`
 * (admin bypasses scope). When the Identity has NO project binding it is unscoped
 * and may target any project. When the request names no project, there is nothing
 * to cross, so a scoped Identity is unaffected. Returns `true` when the request
 * clears the gate.
 */
function clearsProjectScope(identity: Identity, ctx: AuthorizationContext): boolean {
	if (identity.role === "admin") return true; // admin bypasses scope (c-AC-5).
	if (identity.project === undefined) return true; // unscoped caller → any project.
	if (ctx.project === undefined) return true; // request targets no project → nothing to cross.
	return ctx.project === identity.project; // scoped caller → same project only.
}

// ────────────────────────────────────────────────────────────────────────────
// The policy.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the real RBAC {@link AuthorizationPolicy} (011c). The daemon assembly
 * injects the result into the permission middleware in place of `defaultDenyPolicy`
 * (deferred, D-9). The decision is data-driven (the capability table + role matrix
 * + write-method set above) and fail-closed at every fork.
 *
 * `decide` is pure: same Identity + context → same outcome, no IO, never throws.
 */
export function createRbacPolicy(): AuthorizationPolicy {
	return {
		decide(identity: Identity, ctx: AuthorizationContext): AuthDecision {
			// admin clears every gate — permission AND scope (c-AC-2).
			if (identity.role === "admin") return "allow";

			// 1. Capability gate (FR-4 / FR-6 / c-AC-2 / c-AC-6): the role must clear
			//    the EFFECTIVE capability this request needs. The read-vs-write method
			//    split is folded in here, so a readonly GET reads a data route but a
			//    readonly write is denied, while a sensitive (admin/connectors-admin)
			//    route is gated on every method.
			const routeCapability = capabilityForGroup(ctx.group);
			const needed = effectiveCapability(routeCapability, ctx.method);
			if (!roleHasCapability(identity.role, needed)) {
				return "forbidden";
			}

			// 2. Project-scope gate (c-AC-5 / FR-7): a scoped caller may not cross into
			//    another project (admin already returned above).
			if (!clearsProjectScope(identity, ctx)) {
				return "forbidden";
			}

			return "allow";
		},
	};
}
