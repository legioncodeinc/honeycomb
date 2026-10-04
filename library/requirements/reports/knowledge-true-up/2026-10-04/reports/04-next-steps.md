# Next steps

1. Read the master report and the dirty diff under `library/knowledge/private`. The working tree also contains uncommitted PRD folder moves (071-074 and 077 to completed, 078 to in-work, 019 and 020 to in-work). Those moves were not made by this audit. Decide whether they stay.
2. `node_modules` is absent. A later `npm ci` then `npm run ci` is the way to turn the red scheduled CI signal into a local reproduction. This audit did not install dependencies.
3. Open PRs 318, 322, and 324 are still open. Hermes production wiring is the subject of 322 and issue 319. The tree already has a Hermes shim and no connector.
4. Remote heads `cla-signatures`, `feat/session-recall-cache`, and `fix/sessions-token-columns-zero-fill` are not merged. Cleanup commands were not run.
5. Knowledge pages still describe Doctor internals, a React dashboard tree, and a VS Code manifest that are not in this checkout. The true-up marked the missing files. A later pass can shorten those historical sections if the owner wants less legacy prose.

Owner-gated: commit and push of the knowledge diff, any PR, any branch deletion, any npm install. Recommended default: review the diff, then commit only `library/knowledge/private` and `library/requirements/reports/knowledge-true-up` when you want that history.
