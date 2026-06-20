# Logs API (daemon side) — CONVENTIONS (PRD-021d, d-AC-2)

`mountLogsApi` (`api.ts`) is the daemon-side seam serving the `/api/logs` ring-buffer reads. It
mirrors `mountDashboardApi` (020b): the daemon assembly (021a `assembleDaemon`) calls it ONCE after
`createDaemon(...)`, and it attaches handlers onto the ALREADY-MOUNTED `/api/logs` route group via
`daemon.group("/api/logs")` — ZERO `server.ts` edits. The group is scaffolded + protected in
`server.ts`, so attaching inherits auth/RBAC.

**Seam signature (the assembly / 021f calls this):**

```ts
mountLogsApi(daemon: Daemon, options: { logger: RequestLogger; streamPollMs?: number; streamKeepaliveMs?: number }): void
```

**Two reads off the ONE ring buffer (`logger.ts`):**

- `GET /api/logs` — a JSON snapshot `{ records, count }` of recent records (newest last), bounded
  by `?limit=` (clamped to `[1, MAX_LOGS_LIMIT]`, default `DEFAULT_LOGS_LIMIT`). The `honeycomb logs`
  one-shot + the dashboard live-log panel's initial paint.
- `GET /api/logs/stream` — a Server-Sent-Events stream: backfill the recent records, then poll the
  ring buffer (`DEFAULT_STREAM_POLL_MS`) and push each NEW record as an `event: log` frame. The
  `honeycomb logs --follow` tail + the dashboard live-log panel (d-AC-4). A `:` keepalive comment is
  interleaved (`DEFAULT_STREAM_KEEPALIVE_MS`) so a proxy never idles the stream out. The loop ends on
  `stream.aborted`.

**SSE was the choice** (resolving the PRD open question) — one long-lived GET over the ring buffer,
no websocket upgrade, the daemon pushes lines. `logs --follow` backfills recent events on attach (the
open question's other half — yes, backfill).

**No secrets in the payload (verified).** The records are `RequestLogRecord`s VERBATIM: method, path
(no query string), status, duration, mode, resolved org/workspace. The request logger NEVER records a
header, a bearer token, or a request body (see `logger.ts`), so this handler cannot leak one — it adds
NO field to the payload.

**Deferred assembly (D-1 / D-7).** The production assembly owns the logger (`daemon.logger`) and calls
`mountLogsApi(daemon, { logger: daemon.logger })` once. Constructed-and-tested here against an
in-memory logger (`tests/daemon/runtime/logs/api.test.ts` drives `app.request(...)`); importing the
daemon does not auto-invoke it. The assembly attach is wired by 021a/021f via the `mountLogsApi` seam
(this module is NOT imported into `assemble.ts` by 021d — the assembly calls the seam).
