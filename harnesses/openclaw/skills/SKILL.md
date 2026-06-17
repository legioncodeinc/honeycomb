---
name: honeycomb
description: Honeycomb persistent shared memory for the OpenClaw harness — auto-capture and recall across sessions via the local Honeycomb daemon.
---

# honeycomb (OpenClaw)

Thin OpenClaw adapter for Honeycomb. Routes capture/recall through the local
Honeycomb daemon on port 3850. No DeepLake access path ships in this bundle.

Runtime tuning is supplied via `openclaw.json` under
`plugins.entries.honeycomb.config.tuning` and applied by the plugin's
`register()` into `globalThis.__honeycomb_tuning__` (PRD-001b FR-7).
