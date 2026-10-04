# State of the union

Honeycomb at `c1cb6bf` is a single npm package `@legioncodeinc/honeycomb` version 0.22.0, Node `>=22.5.0`, ESM. VERIFIED: `package.json`, `node -v` is v22.22.1. `node_modules` is absent, so `npm run ci` was not executed. Live typecheck and vitest are UNVERIFIABLE-HERE.

The daemon default bind is `127.0.0.1:3850`. The Hive portal constant is `127.0.0.1:3853`. VERIFIED: `src/shared/constants.ts`. `HONEYCOMB_HOST` and `HONEYCOMB_BIND` can widen the bind. VERIFIED by the security lens against `src/daemon/runtime/config.ts` and re-stated in `architecture/daemon-surface.md`.

Durable memory is DeepLake, reached by the daemon. Local files under the fleet root (`src/shared/fleet-root.ts`, default `~/.apiary/honeycomb`) hold the registry, telemetry sqlite, pid, and notifications state. Those call sites that still open a legacy `~/.honeycomb` file do so only as a read fallback when the fleet-root file is absent. The local SQLite job queue path is the fleet-root production file. It has no legacy read fallback. VERIFIED: `src/shared/fleet-root.ts` and the call sites cited in the true-up.

Embeddings default on. Only `HONEYCOMB_EMBEDDINGS=false` or `0` disables them. VERIFIED: `src/daemon/runtime/services/embed-client.ts` lines 160-176. The local SQLite queue defaults on for an undeclared topology. VERIFIED: `resolveLocalQueueTopology` in `src/daemon/runtime/services/local-queue-diagnostics.ts`.

Install-wired harnesses are Claude Code, Codex, and Cursor. Hermes, pi, and OpenClaw have source trees and are not in the connector registry. REPORTED by the harnesses-mcp lens, consistent with `harness-registry.ts` citations in `load-bearing-boundaries.md`. MCP is a stdio server. `/mcp` on the daemon is a 501 scaffold. VERIFIED: `src/daemon/runtime/server.ts` route group and 501 handler.

License is AGPL-3.0-or-later. VERIFIED by the deps lens against LICENSE and package.json. Optional dependencies include `@huggingface/transformers` and `pg`. REPORTED by that lens.

`terraform` and `go` are absent. Docker is installed. Live cloud is UNVERIFIABLE-HERE.
