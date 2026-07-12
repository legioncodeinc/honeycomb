---
"@legioncodeinc/honeycomb": minor
---

Fixes a fresh-install bug where an enabled Portkey gateway with no active model could silently POST empty-model requests that always failed; the gateway now fails closed with an honest `no_model` health state, and `/health` also reports swallowed extraction errors so stalled memory formation is visible.
