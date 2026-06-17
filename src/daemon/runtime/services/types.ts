/**
 * Daemon service lifecycle contract (PRD-004 bootstrap seam, Wave 1).
 *
 * The shared shape every long-lived daemon-owned service implements so the
 * bootstrap can start and stop them uniformly (D-4: in-process, daemon-owned).
 * The job queue (004b) and the file watcher (004c) both satisfy this; the
 * runtime-path service (004d) declares its own `start`/`stop` with the same
 * shape (it lives next to its middleware).
 *
 * This file defines the SHAPE only and imports nothing from the service files,
 * so a stub file can import {@link DaemonService} without a circular dependency
 * on the bootstrap. A Wave-2 Bee filling a stub satisfies this interface and the
 * bootstrap's lifecycle calls it — the Bee never edits the bootstrap.
 */

/**
 * A long-lived, daemon-owned service the bootstrap starts on listen and stops on
 * shutdown. `start` is awaited so an async warmup (e.g. the queue ensuring its
 * table, the watcher attaching fs handles) completes before the daemon reports
 * ready; `stop` is awaited so a graceful shutdown drains/releases cleanly.
 *
 * Both must be idempotent and safe to call when the service did nothing: a stub
 * `start()`/`stop()` is a no-op, so the bootstrap lifecycle is identical whether
 * a stub or the real impl is injected.
 */
export interface DaemonService {
	/** Begin work (warm up, ensure tables, attach watchers). Awaited by bootstrap. */
	start(): void | Promise<void>;
	/** Stop work and release resources. Awaited by bootstrap on shutdown. */
	stop(): void | Promise<void>;
}
