# Contributing to Honeycomb

Thanks for wanting to help. Honeycomb is a cross-harness AI memory system, and the bar for changes is high because a lot of tools lean on it. This doc tells you how to get a change merged without friction.

## Before you start

- For anything bigger than a typo or a small fix, open an issue first and describe what you want to do. Saves you from building something that gets turned down on direction.
- Security bugs do not go in public issues. See [SECURITY.md](SECURITY.md).
- Honeycomb ships under the [AGPL-3.0-or-later](LICENSE) license. Your contribution lands under the same terms.

## Sign the CLA

Before your first contribution can be merged, you have to sign the Contributor License Agreement in [CLA.md](CLA.md). This is a one-time thing.

The CLA does two things. It confirms you have the right to contribute the code, and it grants Legion Code Inc. the rights to your contribution. We need that grant because Honeycomb is dual-licensed: it's AGPL for the community, and we offer commercial licenses to organizations that can't use the AGPL. Without the CLA we couldn't offer those commercial licenses without tracking down every contributor, so it's not optional.

- **Individuals**: sign the Individual CLA.
- **Contributing on behalf of a company** (the way Activeloop does): your company signs the Corporate CLA, and lists the people authorized to contribute.

We use a CLA bot. When you open your first PR it will check whether you've signed and walk you through it if you haven't. You keep the copyright to your work. You're granting a license, not handing it over.

## Setup

```bash
npm install
npm run build        # tsc + esbuild -> bundle/cli.js, the daemon, harness, MCP, and embed bundles
```

## The gate

Every change has to pass the same gate CI runs. Run it locally before you push:

```bash
npm run ci           # typecheck + duplication (jscpd) + tests (vitest) + SQL-safety audit
```

That's the hard line. If `npm run ci` is red, the PR is not ready. See [docs/ci.md](docs/ci.md) for what each stage does.

A few more you'll want:

```bash
npm run format       # biome: auto-format before you commit
npm run lint         # biome check
npm run test:watch   # vitest in watch mode while you work
```

## Code style

- Formatting and linting are handled by [Biome](https://biomejs.dev/). Run `npm run format` and don't hand-fight it.
- Keep the build direction intact. Dependents never import upward. The order is enforced by import direction under one `tsc` pass (see the `//build-order` note in `package.json`).
- Anything touching SQL has to clear `npm run audit:sql`. No string-built queries that dodge the safety layer.
- New behavior needs tests. We run `vitest`, with mutation testing (`stryker`) on the load-bearing modules.
- Every new source file gets the license header. The snippet is in [docs/license-header.txt](docs/license-header.txt).

## Pull requests

1. Fork and branch off `main`. Name the branch for what it does, e.g. `fix/recall-empty-result` or `feat/embed-batching`.
2. Keep the PR focused. One logical change. Smaller PRs get reviewed faster.
3. Make sure `npm run ci` passes.
4. Make sure you've signed the CLA. The bot will block the merge until you have.
5. Fill out the PR template. Explain what changed and why, and how you tested it.
6. Link the issue the PR resolves.

A maintainer will review. Expect feedback. Address it, push, and the review continues.

## Reporting bugs and requesting features

Use the issue templates. They ask for the things we need to actually act on the report. The more specific you are, the faster it moves.
