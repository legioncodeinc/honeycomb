/**
 * PRD-011d — `honeycomb key` CLI (each AC-named).
 *
 * Verification posture: a FAKE {@link KeyServiceClient} seam. The CLI imports NO
 * daemon/storage path (the invariant test enforces it separately; we also spot-check
 * the no-hash-printed discipline here).
 *
 * d-AC-1 `key create` prints the plaintext ONCE; it NEVER prints a hash, and the seam
 *        carries no hash to leak.
 * d-AC-4 `key revoke <id>` revokes by id; a sibling is unaffected (the seam models it).
 * Plus: `key list` prints only safe metadata — never a hash or a plaintext.
 */

import { describe, expect, it } from "vitest";

import {
	type CreatedKeyView,
	type KeyServiceClient,
	type KeySummary,
	runKeysCommand,
} from "../../src/cli/keys.js";

/** A fake key service backed by an in-memory list of keys + a one-time plaintext map. */
class FakeKeyService implements KeyServiceClient {
	private seq = 0;
	readonly keys: (KeySummary & { plaintext: string })[] = [];
	readonly revoked = new Set<string>();

	create(args: { name: string; role?: "admin" | "member" | "readonly" | "agent"; project?: string }): Promise<CreatedKeyView> {
		this.seq += 1;
		const id = `key${this.seq}`;
		const plaintext = `hc_sk_${id}.SECRET_${this.seq}_NEVER_PRINTED_BY_LIST`;
		const summary: KeySummary & { plaintext: string } = {
			id,
			name: args.name,
			role: args.role ?? "agent",
			revoked: false,
			createdAt: "2026-06-17T00:00:00.000Z",
			plaintext,
			...(args.project !== undefined ? { project: args.project } : {}),
		};
		this.keys.push(summary);
		return Promise.resolve({ id, plaintext });
	}

	revoke(id: string): Promise<boolean> {
		const key = this.keys.find((k) => k.id === id);
		if (!key) return Promise.resolve(false);
		this.revoked.add(id);
		(key as { revoked: boolean }).revoked = true;
		return Promise.resolve(true);
	}

	list(): Promise<readonly KeySummary[]> {
		// The seam returns SAFE metadata only — the plaintext field is NOT part of KeySummary.
		return Promise.resolve(
			this.keys.map((k) => {
				const summary: KeySummary = {
					id: k.id,
					name: k.name,
					role: k.role,
					revoked: k.revoked,
					createdAt: k.createdAt,
					...(k.project !== undefined ? { project: k.project } : {}),
				};
				return summary;
			}),
		);
	}
}

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

describe("d-AC-1 key create prints the plaintext ONCE and never a hash", () => {
	it("prints the plaintext exactly once and no hash material", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		const res = await runKeysCommand({ command: "create", name: "connector-x" }, { client, out: cap.out });

		expect(res.exitCode).toBe(0);
		expect(res.mutated).toBe(true);

		const created = client.keys[0];
		const text = cap.lines.join("\n");
		// The plaintext appears EXACTLY once across all output lines.
		const occurrences = cap.lines.filter((l) => l.includes(created.plaintext)).length;
		expect(occurrences).toBe(1);
		// No "scrypt$" hash string is ever printed (the seam never hands one over).
		expect(text).not.toContain("scrypt$");
		// The "shown once" warning is present so the operator knows to copy it now.
		expect(text.toLowerCase()).toContain("once");
	});

	it("defaults to the least-privileged agent role unless --role overrides", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		await runKeysCommand({ command: "create", name: "c" }, { client, out: cap.out });
		expect(client.keys[0].role).toBe("agent");

		await runKeysCommand({ command: "create", name: "admin-key", role: "admin" }, { client, out: cap.out });
		expect(client.keys[1].role).toBe("admin");
	});
});

describe("d-AC-4 key revoke revokes by id; siblings keep working", () => {
	it("revokes the named key and leaves the other key active", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		await runKeysCommand({ command: "create", name: "a" }, { client, out: cap.out });
		await runKeysCommand({ command: "create", name: "b" }, { client, out: cap.out });

		const res = await runKeysCommand({ command: "revoke", arg: "key1" }, { client, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(res.mutated).toBe(true);
		expect(client.revoked.has("key1")).toBe(true);
		expect(client.revoked.has("key2")).toBe(false);
	});

	it("returns a non-zero exit for an unknown id without mutating", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		const res = await runKeysCommand({ command: "revoke", arg: "nope" }, { client, out: cap.out });
		expect(res.exitCode).toBe(1);
		expect(res.mutated).toBe(false);
	});
});

describe("key list prints only safe metadata — never a hash or a plaintext", () => {
	it("lists id/name/role/state and no key material", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		await runKeysCommand({ command: "create", name: "alpha", project: "alpha" }, { client, out: cap.out });
		const created = client.keys[0];

		const listCap = captured();
		const res = await runKeysCommand({ command: "list" }, { client, out: listCap.out });
		expect(res.exitCode).toBe(0);
		expect(res.mutated).toBe(false);

		const text = listCap.lines.join("\n");
		expect(text).toContain("key1");
		expect(text).toContain("alpha");
		expect(text).toContain("role=agent");
		// The plaintext + any hash material NEVER appear in the list output.
		expect(text).not.toContain(created.plaintext);
		expect(text).not.toContain("scrypt$");
		expect(text).not.toContain("SECRET_");
	});

	it("prints a friendly message when there are no keys", async () => {
		const client = new FakeKeyService();
		const cap = captured();
		const res = await runKeysCommand({ command: "list" }, { client, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(cap.lines.join("\n").toLowerCase()).toContain("no api keys");
	});
});
