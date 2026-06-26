/**
 * React bindings entry point — PRD-019e Wave 2 (`@legioncodeinc/honeycomb/react`).
 *
 * A SEPARATE entry point (FR-7 / e-AC-4) so the core client stays dependency-free
 * for browser use; React is only pulled in by an app that imports THIS module, and
 * it is a `peerDependencies` entry (never bundled into core). The bindings (a
 * provider + `useRecall`/`useRemember`) wrap the core {@link HoneycombClient} and
 * surface results + loading + typed-error state (e-AC-4). They REUSE the core
 * client's token + actor model (FR-7) — they never re-implement HTTP.
 *
 * ── WHY REACT IS AN INJECTED SEAM, NOT A STATIC IMPORT ──────────────────────
 * `react` is a peer dep — it is NOT in this repo's `dependencies`, and there is no
 * `@types/react`. A static `import … from "react"` would not typecheck under the
 * existing `tsc` pass. So the hooks the bindings need (`useState`/`useEffect`/
 * `useCallback`) are taken through a minimal, locally-typed {@link ReactRuntime}
 * seam. In an app, the caller passes its own `React` (or the relevant hooks); a
 * test passes a tiny fake. This keeps the module compiling with zero new deps while
 * the bindings still run against the real React at app runtime.
 */

import type { HoneycombClient, RecallResult } from "./contracts.js";

/**
 * The minimal React surface the bindings use, typed locally so the module compiles
 * without `@types/react` (FR-7). An app passes its real `React`; the shapes are the
 * standard hook signatures, narrowed to what the bindings call.
 */
export interface ReactRuntime {
	useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
	useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	useCallback<T extends (...args: never[]) => unknown>(cb: T, deps: readonly unknown[]): T;
}

/** The state a recall hook surfaces (FR-7 / e-AC-4): results + loading + typed error. */
export interface UseRecallState {
	/** The recall results, or `undefined` while loading / on error. */
	readonly results?: readonly RecallResult[];
	/** True while the request is in flight (e-AC-4). */
	readonly loading: boolean;
	/** The typed error, when the request failed (e-AC-4). */
	readonly error?: unknown;
}

/** The callback + state a remember hook surfaces (FR-7). */
export interface UseRememberState {
	/** Store a memory via the core client; sets loading + error around the call. */
	readonly remember: (text: string) => Promise<void>;
	/** True while a store is in flight. */
	readonly loading: boolean;
	/** The typed error, when the last store failed. */
	readonly error?: unknown;
}

/**
 * `useRecall` (FR-7 / e-AC-4). Runs `client.recall(query)` against the core client
 * and returns results + loading + typed-error state. The `react` runtime is injected
 * (see the module header) so the binding compiles without the peer dep; in an app the
 * caller threads its `React`. The effect re-runs when `query` changes; an in-flight
 * flag guards against a stale resolution overwriting a newer one.
 */
export function useRecall(react: ReactRuntime, client: HoneycombClient, query: string): UseRecallState {
	const [state, setState] = react.useState<UseRecallState>({ loading: true });

	react.useEffect(() => {
		let cancelled = false;
		setState({ loading: true });
		client
			.recall(query)
			.then((results) => {
				if (!cancelled) setState({ loading: false, results });
			})
			.catch((error: unknown) => {
				// Surface the TYPED error (ApiError/NetworkError/TimeoutError) verbatim (e-AC-4).
				if (!cancelled) setState({ loading: false, error });
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	return state;
}

/**
 * `useRemember` (FR-7). Returns a callback that stores a memory via the core client,
 * with loading + typed-error state. The `react` runtime is injected like `useRecall`.
 */
export function useRemember(react: ReactRuntime, client: HoneycombClient): UseRememberState {
	const [loading, setLoading] = react.useState<boolean>(false);
	const [error, setError] = react.useState<unknown>(undefined);

	const remember = react.useCallback(
		async (text: string): Promise<void> => {
			setLoading(true);
			setError(undefined);
			try {
				await client.remember(text);
			} catch (err: unknown) {
				setError(err);
				throw err;
			} finally {
				setLoading(false);
			}
		},
		[client],
	);

	return { remember, loading, error };
}
