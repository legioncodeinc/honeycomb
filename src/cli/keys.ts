/**
 * `honeycomb key` CLI — PRD-011d (d-AC-1 / d-AC-4).
 *
 * The API-key management command surface for remote connectors:
 *   - `honeycomb key create [--role <r>] [--project <p>] [--name <n>]`
 *       — mint a named key. The plaintext is printed ONCE here and never again
 *         (d-AC-1); only its scrypt-salted hash is stored daemon-side. The default
 *         role is the least-privileged `agent` (d-AC-3) unless `--role` overrides it.
 *   - `honeycomb key revoke <id>`
 *       — revoke a key by its public id (d-AC-4). A revoked key is rejected on the
 *         next request; other keys keep working.
 *   - `honeycomb key list`
 *       — list keys' SAFE metadata (id/name/role/project/revoked/created). It NEVER
 *         prints a hash or a plaintext key — by construction, the seam returns no
 *         hash to print.
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * This is a thin client. It imports neither `src/daemon/storage` nor the daemon core.
 * It reaches the daemon (port 3850) through an INJECTED {@link KeyServiceClient} seam:
 * the daemon-assembly wiring supplies the real RPC client (which calls
 * `createApiKey`/`revokeKey`/`listKeys`), and the AC-named test supplies a fake. The
 * scrypt hashing + the `api_keys` storage live entirely behind that seam, in the
 * daemon — so the storage-import invariant holds and no key material is computed here.
 *
 * The plaintext returned by `create` exists ONLY in this process's stdout for the one
 * print; it is never written to a file or re-printed. The seam carries no hash.
 *
 * Note: the bundled `honeycomb` bin is not yet extended to dispatch here; that is the
 * deferred pure-wiring assembly step (mirrors org.ts). This module is
 * constructed-and-tested with an injected fake seam.
 */

import type { Role } from "../daemon/runtime/auth/contracts.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/** The SAFE per-key metadata `list` prints — NEVER a hash or plaintext. */
export interface KeySummary {
	readonly id: string;
	readonly name: string;
	readonly role: Role;
	readonly project?: string;
	readonly revoked: boolean;
	readonly createdAt: string;
}

/** The result of a `create` over the seam: the public id + the ONE-TIME plaintext. */
export interface CreatedKeyView {
	readonly id: string;
	/** The plaintext `hc_sk_<keyid>.<secret>` — printed ONCE, never persisted (d-AC-1). */
	readonly plaintext: string;
}

/**
 * The daemon-side key service the CLI calls over the 3850 RPC seam (D-9). The daemon
 * assembly wires the real client (which invokes the daemon `createApiKey`/`revokeKey`/
 * `listKeys`); the test injects a fake. The seam exposes NO hash — `create` returns the
 * one-time plaintext, `list` returns only safe metadata — so the CLI cannot leak key
 * material it never receives.
 */
export interface KeyServiceClient {
	/** Mint a key; returns the public id + the one-time plaintext (d-AC-1). */
	create(args: { name: string; role?: Role; project?: string }): Promise<CreatedKeyView>;
	/** Revoke a key by id (d-AC-4); resolves to whether the revoke applied. */
	revoke(id: string): Promise<boolean>;
	/** List keys' SAFE metadata (no hash, no plaintext). */
	list(): Promise<readonly KeySummary[]>;
}

/** The injectable seams the keys CLI runs against. `out` defaults to `console.log`. */
export interface KeysCommandDeps {
	/** The daemon-side key service (the 3850 seam). */
	readonly client: KeyServiceClient;
	/** The output sink (defaults to `console.log`). */
	readonly out?: OutputSink;
}

/** Outcome of a `key` command: exit code + whether a key was created/revoked. */
export interface KeysResult {
	readonly exitCode: number;
	/** True iff the command mutated (created or revoked a key). */
	readonly mutated: boolean;
}

/** The parsed `key` invocation: the sub-command + its arg + the create flags. */
export interface KeysInvocation {
	/** The sub-command word (`create` | `revoke` | `list`). */
	readonly command: string;
	/** The positional argument (the key id for `revoke`), if any. */
	readonly arg?: string;
	/** `--name <n>` for `create` (defaults to a generic label). */
	readonly name?: string;
	/** `--role <r>` for `create` (the seam defaults it to `agent` when absent). */
	readonly role?: Role;
	/** `--project <p>` for `create`. */
	readonly project?: string;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(["admin", "member", "readonly", "agent"]);

/**
 * Parse a raw `key` argv tail (everything AFTER the `key` word) into a typed
 * {@link KeysInvocation}. The first non-flag word is the sub-command; for `revoke` the
 * next non-flag word is the id. Recognized flags: `--name`, `--role`, `--project`. An
 * unknown `--role` value is dropped (the seam then applies the least-privileged default).
 */
export function parseKeysArgs(argv: readonly string[]): KeysInvocation {
	let command = "";
	let arg: string | undefined;
	let name: string | undefined;
	let role: Role | undefined;
	let project: string | undefined;

	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--name":
				name = argv[++i];
				break;
			case "--role": {
				const raw = argv[++i];
				if (raw !== undefined && KNOWN_ROLES.has(raw)) role = raw as Role;
				break;
			}
			case "--project":
				project = argv[++i];
				break;
			default:
				if (!a.startsWith("--")) positionals.push(a);
				break;
		}
	}
	command = positionals[0] ?? "";
	if (positionals[1] !== undefined) arg = positionals[1];

	const inv: KeysInvocation = {
		command,
		...(arg !== undefined ? { arg } : {}),
		...(name !== undefined ? { name } : {}),
		...(role !== undefined ? { role } : {}),
		...(project !== undefined ? { project } : {}),
	};
	return inv;
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: KeysCommandDeps): { client: KeyServiceClient; out: OutputSink } {
	return {
		client: deps.client,
		out: deps.out ?? ((line: string): void => console.log(line)),
	};
}

/**
 * `honeycomb key create` — mint a key and print the plaintext ONCE (d-AC-1). The role
 * defaults to the least-privileged `agent` via the seam (d-AC-3) unless `--role` is set.
 * The plaintext is printed exactly once and never persisted by the CLI.
 */
async function keyCreate(inv: KeysInvocation, deps: { client: KeyServiceClient; out: OutputSink }): Promise<KeysResult> {
	const { out, client } = deps;
	let created: CreatedKeyView;
	try {
		created = await client.create({
			name: inv.name ?? "connector",
			...(inv.role !== undefined ? { role: inv.role } : {}),
			...(inv.project !== undefined ? { project: inv.project } : {}),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : "create failed";
		out(`error: could not create key: ${reason}`);
		return { exitCode: 1, mutated: false };
	}
	out(`Created key ${created.id}.`);
	out("");
	out("  Your new API key (shown ONCE — copy it now, it will not be displayed again):");
	out(`  ${created.plaintext}`);
	out("");
	out("  Store it securely. Honeycomb keeps only a salted hash and cannot recover the key.");
	return { exitCode: 0, mutated: true };
}

/**
 * `honeycomb key revoke <id>` — revoke a key by id (d-AC-4). A revoked key is rejected
 * on the next request; other keys keep working. A missing/unknown id is a non-zero exit.
 */
async function keyRevoke(id: string, deps: { client: KeyServiceClient; out: OutputSink }): Promise<KeysResult> {
	const { out, client } = deps;
	if (id === "") {
		out("usage: honeycomb key revoke <id>");
		return { exitCode: 1, mutated: false };
	}
	let ok: boolean;
	try {
		ok = await client.revoke(id);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "revoke failed";
		out(`error: could not revoke key ${id}: ${reason}`);
		return { exitCode: 1, mutated: false };
	}
	if (!ok) {
		out(`error: key ${id} could not be revoked (unknown id?).`);
		return { exitCode: 1, mutated: false };
	}
	out(`Revoked key ${id}. It is rejected on its next request; other keys keep working.`);
	return { exitCode: 0, mutated: true };
}

/**
 * `honeycomb key list` — print each key's SAFE metadata (d-AC-1 discipline). It NEVER
 * prints a hash or a plaintext: the seam returns no hash, so there is nothing to leak.
 */
async function keyList(deps: { client: KeyServiceClient; out: OutputSink }): Promise<KeysResult> {
	const { out, client } = deps;
	let keys: readonly KeySummary[];
	try {
		keys = await client.list();
	} catch (err) {
		const reason = err instanceof Error ? err.message : "list failed";
		out(`error: could not list keys: ${reason}`);
		return { exitCode: 1, mutated: false };
	}
	if (keys.length === 0) {
		out("No API keys.");
		return { exitCode: 0, mutated: false };
	}
	for (const k of keys) {
		const project = k.project !== undefined && k.project !== "" ? ` project=${k.project}` : "";
		const state = k.revoked ? "revoked" : "active";
		out(`${k.id}  ${k.name}  role=${k.role}${project}  ${state}  created=${k.createdAt}`);
	}
	return { exitCode: 0, mutated: false };
}

/**
 * Run a parsed `key` command (d-AC-1 / d-AC-4). The seam is injected so the AC-named
 * test drives the whole surface against a fake key service — no real daemon, no real
 * storage, no real key material computed in this process.
 */
export async function runKeysCommand(inv: KeysInvocation, deps: KeysCommandDeps): Promise<KeysResult> {
	const resolved = withDefaults(deps);
	switch (inv.command) {
		case "create":
			return keyCreate(inv, resolved);
		case "revoke":
			return keyRevoke(inv.arg ?? "", resolved);
		case "list":
			return keyList(resolved);
		default:
			resolved.out("usage: honeycomb key <create [--role --project --name] | revoke <id> | list>");
			return { exitCode: inv.command === "" ? 0 : 1, mutated: false };
	}
}

/** Convenience entry: parse + run a `key` argv tail in one call. */
export function keysMain(argv: readonly string[], deps: KeysCommandDeps): Promise<KeysResult> {
	return runKeysCommand(parseKeysArgs(argv), deps);
}
