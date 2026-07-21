/**
 * The real `node:fs`-backed {@link ConnectorFs} — PRD-021b (FR-2 / b-AC-6).
 *
 * 019a built the {@link ConnectorFs} SEAM + the in-memory {@link createFakeFs} for tests, but
 * left the PRODUCTION `node:fs` adapter to "the daemon-assembly wiring" (the deferred bin
 * assembly). 021b is that wiring: this module supplies the concrete filesystem the CLI's
 * `setup`/`connect`/`uninstall` verbs run the 019a `connectorMain` over, so `honeycomb setup`
 * actually writes the hook handlers + patches the harness config on disk.
 *
 * ── Boundary: install-time filesystem only, NO DeepLake (D-2) ────────────────
 * Every method touches `node:fs` and the user's home dir only — it opens no DeepLake connection
 * and holds no daemon handle (`src/connectors` is a NON_DAEMON_ROOT in `invariant.test.ts`). The
 * symlink ops fall back gracefully on platforms / filesystems where symlinks are unavailable
 * (Windows without the privilege), mirroring the connector's foreign-preserving posture.
 */

import {
	readlink as fsReadlink,
	symlink as fsSymlink,
	mkdir,
	readFile,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { ConnectorFs } from "./contracts.js";

/** True when a thrown error carries the `ENOENT` (no such file) code. */
function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** True when a thrown error carries the `EINVAL` code (a non-symlink path passed to readlink). */
function isNotSymlink(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException)?.code;
	return code === "EINVAL" || code === "UNKNOWN";
}

/**
 * Build the production {@link ConnectorFs} over `node:fs` (FR-2). Reads return `undefined` for an
 * absent file (the config-not-yet-present case the connector expects); writes create parent dirs;
 * removes are idempotent (a missing file is a clean no-op). The CLI's connector verbs run the 019a
 * engine over THIS so a real `honeycomb setup` lands handlers + a patched config on disk.
 */
export function createNodeConnectorFs(): ConnectorFs {
	return {
		async readFile(path: string): Promise<string | undefined> {
			try {
				return await readFile(path, "utf8");
			} catch (err) {
				if (isEnoent(err)) return undefined;
				throw err;
			}
		},
		async writeFile(path: string, contents: string): Promise<void> {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents, "utf8");
		},
		async removeFile(path: string): Promise<void> {
			await rm(path, { force: true });
		},
		async exists(path: string): Promise<boolean> {
			try {
				await stat(path);
				return true;
			} catch (err) {
				if (isEnoent(err)) {
					// `stat` follows symlinks; a dangling symlink is still "present" for the
					// connector's purpose, so probe the link itself before declaring absence.
					try {
						await fsReadlink(path);
						return true;
					} catch {
						return false;
					}
				}
				throw err;
			}
		},
		async ensureDir(path: string): Promise<void> {
			await mkdir(path, { recursive: true });
		},
		async removeEmptyDir(path: string): Promise<void> {
			try {
				await rmdir(path);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
				throw err;
			}
		},
		async symlink(target: string, linkPath: string): Promise<void> {
			await mkdir(dirname(linkPath), { recursive: true });
			try {
				await fsSymlink(target, linkPath);
			} catch (err) {
				// An existing link is the idempotent case; the connector checks `readlink` first,
				// so an EEXIST here means a concurrent create — treat as already-linked, not fatal.
				if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return;
				throw err;
			}
		},
		async readlink(path: string): Promise<string | undefined> {
			try {
				return await fsReadlink(path);
			} catch (err) {
				if (isEnoent(err) || isNotSymlink(err)) return undefined;
				throw err;
			}
		},
		async removeSymlink(path: string): Promise<void> {
			await rm(path, { force: true });
		},
	};
}
