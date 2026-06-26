# Self-hosting the storage backend

> Category: Guides | Version: 1.0 | Date: June 2026 | Status: Active

Run Honeycomb against your own storage backend instead of Activeloop's hosted Deep Lake. The backend is Activeloop's open-source `pg_deeplake` Postgres extension, and Honeycomb can point at it either through an HTTP gateway or directly over a Postgres connection.

**Related:**
- [Getting started](getting-started.md)
- [Honeycomb for teams](teams.md)

---

## What you get, and the one limitation

Honeycomb's storage layer is pluggable. The daemon is the only process that talks to storage, so pointing it at a self-hosted backend is a single decision made at login time. Everything above storage (capture, recall, the dashboard, the harnesses) is unchanged.

The one honest limitation: only the storage path is self-hostable today. `honeycomb login` (the device and headless flows) and `honeycomb org switch` still call `api.deeplake.ai` for authentication and token re-mint. The `honeycomb login --endpoint` path documented below avoids that call by writing the credential directly, so a fully self-hosted deployment should establish its credential with `--endpoint` and avoid the auth-server verbs until a self-hosted auth issuer exists. This is an open question raised for the maintainers.

---

## 1. Run pg_deeplake

`pg_deeplake` is Activeloop's open-source Postgres extension. It speaks Honeycomb's SQL dialect natively, so Honeycomb talks to it with no translation layer.

```bash
docker run -d --name pg-deeplake \
  -e POSTGRES_PASSWORD=deeplake \
  -p 5432:5432 \
  quay.io/activeloopai/pg-deeplake:18
```

That gives you a Postgres 18 server with the extension loaded, reachable at `postgres://postgres:deeplake@localhost:5432/postgres`.

---

## 2. Point Honeycomb at it

There are two ways in, both established with one command. Neither touches `api.deeplake.ai`.

### Direct Postgres (recommended for a single box)

Point Honeycomb straight at the Postgres URL. The daemon connects directly, with no HTTP gateway in the middle.

```bash
honeycomb login --endpoint "postgres://postgres:deeplake@localhost:5432/postgres"
```

When the endpoint starts with `postgres://` (or `postgresql://`), Honeycomb selects the direct Postgres transport automatically.

### HTTP gateway

If you front `pg_deeplake` with an HTTP gateway that exposes the Deep Lake query API, point at that URL instead.

```bash
honeycomb login --endpoint "https://deeplake.internal.example.com"
```

Any non-`postgres://` endpoint uses the HTTP transport.

### Flags

```
honeycomb login --endpoint <url> [--token <tok>] [--org <o>] [--workspace <w>]
```

- `--endpoint` selects the self-hosted path. This is the trigger: with it set, the device flow and the `GET /me` validation are skipped and the credential is written directly with `apiUrl = <url>`.
- `--token` is optional. If you omit it, Honeycomb mints a local, verifiable token bound to your org and workspace, so a self-hoster needs no Activeloop token at all.
- `--org` defaults to `local`.
- `--workspace` defaults to `default`.

The credential is written to the shared `~/.deeplake/credentials.json` at mode `0600`, exactly like every other login. The token is never printed.

---

## 3. The contract a backend must honor

If you write or front your own backend rather than using `pg_deeplake` as shipped, two behaviors are load-bearing. Both were reverse-engineered and proved end to end; getting either wrong breaks Honeycomb quietly.

### A workspace is a Postgres schema

Honeycomb introspects a workspace's columns with `information_schema.columns WHERE table_schema = '<workspace>'` and then issues statements with UNqualified table names (for example `memory`, not `<workspace>.memory`). A backend MUST therefore map each workspace to its own Postgres schema and `SET search_path` to that schema so the unqualified names resolve inside it. The direct Postgres transport does this for you: it runs `CREATE SCHEMA IF NOT EXISTS "<workspace>"` and sets the search path on every connection checkout.

### Return RAW error text, never JSON-wrapped

Honeycomb's schema-heal engine classifies failures by regex-matching the RAW Postgres error message, for example `relation "memory" does not exist`. A backend MUST return that text unmodified. If you wrap the error in JSON, `JSON.stringify` escapes the quotes (`relation \"memory\" does not exist`) and the heal regexes stop matching, so tables and columns silently stop self-healing. Pass the database error message through verbatim.

### Why pg_deeplake is a pure passthrough

`pg_deeplake` speaks Honeycomb's SQL dialect natively: `USING deeplake` table storage, `float4[768]` embedding columns, the `<#>` cosine-distance operator, and `deeplake_index` BM25 indexes. Because the dialect matches, the transport forwards every statement verbatim and returns the result rows as-is. There is no query rewriting to maintain.

---

## 4. Verify

```bash
honeycomb status
honeycomb remember "self-hosted backend is live"
honeycomb recall "self hosted"
```

If `recall` returns the memory you just wrote, the daemon is reading and writing your self-hosted backend.
