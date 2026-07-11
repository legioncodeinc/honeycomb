---
"@legioncodeinc/honeycomb": minor
---

Adds an in-daemon local ANN vector index that dramatically speeds up per-turn memory recall, with automatic fallback to the previous behavior when disabled or not yet built. Includes a new HONEYCOMB_LOCAL_ANN_INDEX configuration flag (on by default) and improved recall observability.
