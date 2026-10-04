# deps-licenses

Read-only lens. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb`. Date: 2026-10-04. `npm install` was not run. No secrets are recorded in this note.

## Declared identity

| Item | Value | Label |
|---|---|---|
| `package.json` `license` | `AGPL-3.0-or-later` | VERIFIED |
| `package-lock.json` root `license` | `AGPL-3.0-or-later` | VERIFIED |
| `LICENSE` | GNU Affero General Public License, Version 3, 19 November 2007 | VERIFIED |
| `docs/license-header.txt` | version 3, or any later version | VERIFIED |
| `engines.node` | `>=22.5.0` in `package.json` and the lockfile root | VERIFIED |
| `package-lock.json` | present, `lockfileVersion` 3 | VERIFIED |
| `node_modules` | absent | VERIFIED |
| `npm ls` | not run | UNVERIFIABLE-HERE |

## Embeddings optional dependency

The embeddings optional dependency name is `@huggingface/transformers`.

`package.json` `optionalDependencies` and the lockfile root both list:

- `@huggingface/transformers` at `^3.8.1`
- `pg` at `^8.13.1`

`pg` is the other optional dependency (self-hosted postgres transport). It is not the embeddings runtime.

Lockfile package entries (file metadata, not an installed tree):

- `node_modules/@huggingface/transformers`: version `3.8.1`, `license` `Apache-2.0`, `optional` true
- `node_modules/pg`: version `8.22.0`, `license` `MIT`, `optional` true

Optional peers, declared under `peerDependencies` with `peerDependenciesMeta.optional` true, are `ai` (`>=3.0.0`) and `react` (`>=18.0.0`). They are not `optionalDependencies`.

## Top-level names

Names only. No dependency tree.

`dependencies`:

- `@hono/node-server`
- `@legioncodeinc/cli-kit`
- `@modelcontextprotocol/sdk`
- `@noble/ciphers`
- `hono`
- `tree-sitter-wasms`
- `web-tree-sitter`
- `yaml`
- `zod`

`devDependencies`:

- `@biomejs/biome`
- `@stryker-mutator/core`
- `@stryker-mutator/vitest-runner`
- `@types/node`
- `@types/pg`
- `@types/react`
- `@types/react-dom`
- `@vitest/coverage-v8`
- `esbuild`
- `fast-check`
- `jscpd`
- `jsdom`
- `react`
- `react-dom`
- `typescript`
- `vitest`

`optionalDependencies`:

- `@huggingface/transformers`
- `pg`

## Reproducibility

`package-lock.json` is present (`lockfileVersion` 3). `node_modules` is absent. Install was not run. `npm ls` is UNVERIFIABLE-HERE. Versions quoted from the lockfile are text in that file, not output of an install.

## Knowledge comparison (AGPL)

`library/knowledge/private/overview.md` contains no AGPL or license claim. VERIFIED by read.

`library/knowledge/private/architecture/system-overview.md` contains no AGPL or license claim. VERIFIED by search.

`library/knowledge/public/overview/` (`how-it-works.md`, `what-is-honeycomb.md`, `glossary.md`) contains no AGPL or license claim. VERIFIED by search.

`library/knowledge/private/infrastructure/npm-publishing.md` states License `AGPL-3.0-or-later`. That string matches `package.json`. VERIFIED.

`library/knowledge/private/infrastructure/monorepo-build-release.md` contains no AGPL string. It names `@huggingface/transformers` as the embedding optional dependency kept out of the `files` allowlist. That name matches `optionalDependencies`. VERIFIED.

`library/knowledge/private/infrastructure/release-automation.md` contains no AGPL or license claim. VERIFIED by search.

Adjacent pages, outside the overview and infrastructure set: `library/knowledge/private/architecture/load-bearing-boundaries.md` states licensed `AGPL-3.0-or-later`, and `library/knowledge/public/faqs/faq.md` states `AGPL-3.0-or-later`. Both match the package field. VERIFIED.

No overview or infrastructure page states a license that conflicts with `AGPL-3.0-or-later`. The private overview and the public overview pages simply omit the license. The infrastructure page that states it (`npm-publishing.md`) matches the package field.

## Findings

### deps-licenses-1

Label: VERIFIED

The project license is `AGPL-3.0-or-later`. `package.json` and the lockfile root both set `license` to that SPDX id. `LICENSE` is the GNU Affero General Public License, Version 3, dated 19 November 2007. `docs/license-header.txt` grants terms "either version 3 of the License, or (at your option) any later version", which is the or-later grant named by the SPDX id.

### deps-licenses-2

Label: VERIFIED

`engines.node` is `>=22.5.0` in `package.json` and in the lockfile root package entry. Host Node was not measured for this lens.

### deps-licenses-3

Label: VERIFIED

The embeddings optional dependency is `@huggingface/transformers` at range `^3.8.1`. `optionalDependencies` also includes `pg` at `^8.13.1`. Optional peers `ai` and `react` sit in `peerDependencies`, not in `optionalDependencies`.

### deps-licenses-4

Label: VERIFIED

Top-level runtime dependency names are `@hono/node-server`, `@legioncodeinc/cli-kit`, `@modelcontextprotocol/sdk`, `@noble/ciphers`, `hono`, `tree-sitter-wasms`, `web-tree-sitter`, `yaml`, and `zod`. Top-level devDependency names are `@biomejs/biome`, `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`, `@vitest/coverage-v8`, `esbuild`, `fast-check`, `jscpd`, `jsdom`, `react`, `react-dom`, `typescript`, and `vitest`. This list is the manifest, not a resolved tree.

### deps-licenses-5

Label: UNVERIFIABLE-HERE

Reproducibility of the installed graph: the lockfile is present and `node_modules` is absent. Install was not run, so `npm ls` is UNVERIFIABLE-HERE.

### deps-licenses-6

Label: VERIFIED

Lockfile text records `@huggingface/transformers` `3.8.1` (`Apache-2.0`, optional) and `pg` `8.22.0` (`MIT`, optional). Those lines were read from `package-lock.json`. They are not `npm ls` output.

### deps-licenses-7

Label: UNVERIFIABLE-HERE

A full third-party license inventory of the lockfile was not produced. `node_modules` is absent and `npm ls` was not run. Per-package `license` strings exist in the lockfile beyond the root and the two optional packages named above. This lens did not enumerate them.

### deps-licenses-8

Label: VERIFIED

License claims in knowledge: `library/knowledge/private/infrastructure/npm-publishing.md` states `AGPL-3.0-or-later`, matching `package.json` and `LICENSE` plus the or-later header. `library/knowledge/private/overview.md`, `library/knowledge/public/overview/`, `library/knowledge/private/architecture/system-overview.md`, `library/knowledge/private/infrastructure/monorepo-build-release.md`, and `library/knowledge/private/infrastructure/release-automation.md` do not state an AGPL license. `monorepo-build-release.md` and `npm-publishing.md` both name `@huggingface/transformers` as the embeddings optional dependency, matching `optionalDependencies`. No conflicting license string was found in those overview or infrastructure pages.
