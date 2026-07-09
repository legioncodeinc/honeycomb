---
"@legioncodeinc/honeycomb": minor
---

Adds a fast, single-round-trip recall path for per-turn memory lookups (opt-in via a `fast` flag), with dedicated concurrency, deadlines, and load-shedding so per-turn recall stays within its latency budget without changing the existing heavy recall behavior.
