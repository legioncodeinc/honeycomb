# CLI Command Architecture

> Category: Operations | Version: 1.0 | Date: June 2026 | Status: Active

Architecture of the Honeycomb unified command-line tool, subcommand dispatching, authentication flows, and operational database commands routed through the daemon.

**Related:**
- [`../auth/auth-architecture.md`](../auth/auth-architecture.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../overview.md`](../overview.md)
- [`../architecture/system-overview.md`](../architecture/system-overview.md)
- [`notifications-and-health.md`](notifications-and-health.md)
- [`../infrastructure/monorepo-build-release.md`](../infrastructure/monorepo-build-release.md)

---

## Why this architecture exists

Honeycomb is built with a single unified command-line interface (CLI) to reduce complexity for users and developers. Rather than requiring distinct setup tools for each of the six supported coding assistants, the global `honeycomb` executable handles all environments. It performs auto-detection of assistants, wires local plugin shims, synchronizes codebase graphs, and hosts secure authentication controls.

The CLI is a thin client of the Honeycomb daemon (port 3850). It never opens the DeepLake backend directly; commands that touch memory, sessions, the codebase graph, or any other table issue requests to the daemon, which is the only process that talks to DeepLake. This keeps the CLI fast to start and means storage, encryption, and tenancy logic live in exactly one place.

The design relies on a split:
* **The Unified Entry Point (`src/cli/index.ts`):** Parses global CLI flags and dispatches arguments to specialized subcommands or separate scripts.
* **The Command Handlers (`src/commands/`):** Contains the actual business logic for auth sessions, rules manipulation, codebase graphs, local trace mining, and database cleanups, all expressed as daemon calls.

This split guarantees that CLI presentation details never entangle core storage, encryption, or synchronization logic.

---

## Command surface

The merged Honeycomb CLI consolidates the hivemind product verbs with our memory engine's verbs into one dispatcher. The full top-level command set is:

| Command | Purpose |
|---|---|
| `setup` | Detect installed assistants, wire hooks, and bring up the daemon |
| `status` | Report daemon connectivity, login state, and environment health |
| `dashboard` | Open the local dashboard webview / TUI |
| `remember` | Write a memory entry to the `memory` table via the daemon |
| `recall` | Query memory (lexical + semantic) via the daemon |
| `agent` | Manage `agent_id` scoping and per-agent settings |
| `ontology` | Inspect and edit the memory ontology |
| `secret` | Store and retrieve scoped secrets |
| `skill` | Skillify scope, pull, unpull, and force operations (team skills sharing) |
| `hook` | Inspect and re-wire lifecycle hooks for each assistant |
| `route` | Manage routing rules between agents and tables |
| `sources` | Register and sync external source connectors |
| `graph` | Build, query, and inspect the codebase graph |
| `goal` | Manage org and session goals surfaced in agent context |
| `org` | Organization administration (create, switch, list) |
| `workspace` | Workspace administration within the active org |
| `sessions prune` | Scoped cleanup of captured trace history |
| `update` | Self-update the CLI, daemon, and bundles |

Skillify operations that the hivemind docs referenced as `hivemind skillify ...` are reached under `honeycomb skill ...` in the merged surface (for example `honeycomb skill scope team --users alice,bob` and `honeycomb skill pull --force`). The `org` and `workspace` verbs are the merged home of the multi-tenant administration that used to live behind the auth passthrough.

---

## Command Dispatching

The unified CLI routes input arguments inside a centralized dispatcher. It recognizes standard commands and handles fallback routes, such as delegating account and organization administration tasks directly to the auth module.

```409:445:src/cli/index.ts
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    log(USAGE);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    log(getVersion());
    return;
  }

  if (cmd === "setup") { await runSetup(args.slice(1)); return; }
  if (cmd === "uninstall") {
    const only = parseOnly(args.slice(1));
    const targets: PlatformId[] = only ?? detectPlatforms().map(p => p.id);
    for (const id of targets) runSingleUninstall(id);
    return;
  }

  if (cmd === "login") { await ensureLoggedIn(); return; }
  if (cmd === "status") { runStatus(); return; }
  if (cmd === "update") {
    const code = await runUpdate({ dryRun: hasFlag(args.slice(1), "--dry-run") });
    process.exit(code);
  }

  if (cmd === "skill") {
    runSkillCommand(args.slice(1));
    return;
  }

  if (cmd === "route") {
    await runRouteCommand(args.slice(1));
    return;
  }
```

If a command matches one of the organization or workspace subcommands, the dispatcher forwards the complete arguments array to the auth-login router:

```486:491:src/cli/index.ts
  // org / workspace subcommands — passthrough to the auth-login dispatcher.
  if (AUTH_SUBCOMMANDS.has(cmd)) {
    await runAuthCommand(args);
    return;
  }
```

---

## Authentication and Device Authorization Flow

Honeycomb relies on the RFC 8628 Device Authorization Flow to handle sign-ins securely. This enables headless installs, remote-SSH environments, and local terminals to authenticate against the DeepLake cloud without manual token generation.

The flow operates as follows:
1. **Device Code Request:** The client calls `/auth/device/code` on the API and receives a verification URI and user code.
2. **User Authorization:** The client opens the default browser pointing to the complete URI or instructs the user to open it manually.
3. **Token Polling:** The client polls the `/auth/device/token` endpoint at the prescribed interval. If the authorization is pending, it continues; if verified, it receives a short-lived token.
4. **Credential Storage:** The token is validated against the `/me` endpoint, a preferred organization is selected (supporting overrides like `HONEYCOMB_ORG_ID`), and a long-lived API token is minted through the `/users/me/tokens` endpoint.
5. **Serialization:** Credentials are written to `~/.honeycomb/credentials.json` with user-private filesystem permissions (`0600`).

The daemon reads the same credential file at startup, so once the CLI logs in, every hook and the daemon share one authenticated identity.

### Resolving Token Drift

A known challenge in multi-tenant SaaS environments is JWT organization drift. If a user switches organizations through the CLI, their stored active organization ID changes, but their existing org-bound JWT API token remains unchanged. This causes queries to execute against the previous tenant space or fail due to invalid claims.

To resolve this, Honeycomb implements a self-healing algorithm `healDriftedOrgToken` that automatically runs on session start. It decodes the JWT payload, compares the `org_id` claim with the active organization ID, and re-mints a corrected token if they mismatch:

```217:240:src/commands/auth.ts
export async function healDriftedOrgToken(
  creds: Credentials,
  log: (msg: string) => void = () => {},
): Promise<Credentials> {
  if (!creds.token || !creds.orgId) return creds;
  const payload = decodeJwtPayload(creds.token);
  const claimOrg = payload && typeof payload.org_id === "string" ? payload.org_id : undefined;
  if (!claimOrg || claimOrg === creds.orgId) return creds;
  log(`token org drift detected: jwt.org_id=${claimOrg} creds.orgId=${creds.orgId} — re-minting`);
  try {
    const apiUrl = creds.apiUrl ?? DEFAULT_API_URL;
    // Per-mint unique name. DeepLake rejects duplicate (user_id, name) with
    // a 500 ("token creation failed"), and the heal runs on EVERY session
    // start across multiple agents — a date-only suffix would collide as
    // soon as the second agent heals on the same day. Date.now() suffices:
    // resolution is ms, only one heal per session, single process per agent.
    const tokenName = `deeplake-plugin-heal-${Date.now()}`;
    const tokenData = await apiPost("/users/me/tokens", {
      name: tokenName,
      duration: 365 * 24 * 3600,
      organization_id: creds.orgId,
    }, creds.token, apiUrl) as { token: { token: string } };
    const healed: Credentials = { ...creds, token: tokenData.token.token };
```

---

## Operational Database Management: Session Pruning

As coding sessions accumulate, users need a way to inspect, prune, and clear their captured trace history. The `honeycomb sessions prune` subcommand provides scoped cleanup of session data by the logged-in author.

The pruning command asks the daemon to run direct, safe SQL statements against both the `sessions` table (where raw event traces are stored) and the `memory` table (where session summaries reside) in DeepLake.

### Querying and Filtering Sessions

Pruning first queries the sessions table to group events by their session path, extracting the event counts, dates, and active projects:

```70:90:src/commands/session-prune.ts
async function listSessions(
  daemon: DaemonClient,
  sessionsTable: string,
  author: string,
): Promise<SessionInfo[]> {
  const rows = await daemon.query(
    `SELECT path, COUNT(*) as cnt, MIN(creation_date) as first_event, ` +
    `MAX(creation_date) as last_event, MAX(project) as project ` +
    `FROM "${sessionsTable}" WHERE author = '${sqlStr(author)}' ` +
    `GROUP BY path ORDER BY first_event DESC`
  );

  return rows.map(r => ({
    path: String(r.path),
    rowCount: Number(r.cnt),
    firstEvent: String(r.first_event),
    lastEvent: String(r.last_event),
    project: String(r.project ?? ""),
  }));
}
```

### Performing Deletion

The client filters the sessions matching the user's criteria (such as `--before <date>` or `--session-id <id>`). For each target, the daemon executes a DELETE statement on the sessions table and removes the corresponding summary from the memory table:

```91:133:src/commands/session-prune.ts
async function deleteSessions(
  config: Config,
  sessionPaths: string[],
): Promise<{ sessionsDeleted: number; summariesDeleted: number }> {
  if (sessionPaths.length === 0) return { sessionsDeleted: 0, summariesDeleted: 0 };

  const sessionsClient = daemonClient(
    config.token, config.apiUrl, config.orgId, config.workspaceId,
    config.sessionsTableName,
  );
  const memoryClient = daemonClient(
    config.token, config.apiUrl, config.orgId, config.workspaceId,
    config.tableName,
  );

  let sessionsDeleted = 0;
  let summariesDeleted = 0;

  for (const sessionPath of sessionPaths) {
    // Delete all rows for this session from the sessions table
    await sessionsClient.query(
      `DELETE FROM "${config.sessionsTableName}" WHERE path = '${sqlStr(sessionPath)}'`
    );
    sessionsDeleted++;

    // Delete the corresponding summary from the memory table
    // Summary path: /summaries/<user>/<sessionId>.md
    const sessionId = extractSessionId(sessionPath);
    const summaryPath = `/summaries/${config.userName}/${sessionId}.md`;

    const existing = await memoryClient.query(
      `SELECT path FROM "${config.tableName}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`
    );
    if (existing.length > 0) {
      await memoryClient.query(
        `DELETE FROM "${config.tableName}" WHERE path = '${sqlStr(summaryPath)}'`
      );
      summariesDeleted++;
    }
  }

  return { sessionsDeleted, summariesDeleted };
}
```

This ensures that trace history and their generated summaries never get out of sync, preventing empty references or orphaned summary entries in DeepLake.
