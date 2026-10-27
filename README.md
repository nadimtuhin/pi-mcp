# pi-mcp

MCP server (stdio, newline-delimited JSON-RPC) that starts, monitors, stops and resumes detached [pi](https://github.com/badlogic/pi-mono) agent runs, with per-pool concurrency limits and run history. No dependencies; requires [Bun](https://bun.sh).

## Tools

- `pi_start` - start a detached run (worktree, session, model, brief_path) after pool admission checks
- `pi_status` - status by log or session
- `pi_stop` - stop a session's process group and record history
- `pi_resume` - resume a saved session
- `pi_list` - live runs and attempt history
- `pi_models` - live models joined with pool state and history
- `pi_history` - per-model attempt summary over a day window

## Install

```
claude mcp add -s user pi-mcp -- bun /absolute/path/to/pi-mcp/index.ts
```

Add `-e NAME=value` for any variable below.

## Configuration (environment)

- `PI_RUN_ROOT`: state directory; default `~/.cache/pi-runs`.
- `PI_DURABLE_SCRIPT`: absolute path to the executable taking `worktree session model brief_path`; default `durable-pi.sh` looked up on PATH. Set this unless the script is on PATH.
- `PI_STATUS_SCRIPT`: absolute path to the executable taking a log path and printing status; default `pi-status.sh` looked up on PATH. Set this unless the script is on PATH.
- `PI_MODELS_URL`: default `http://127.0.0.1:20128/v1/models`. No credentials are read or sent.
- `PI_HEADROOM_SCRIPT`: executable accepting `--json`, returning an array or `{pools: [...]}` of `pool`, `status`, `percent_left`, `resets`.
- `PI_POLICY_PATH`: optional policy JSON checked before launch.
- `PI_ROUTER_DB`: optional SQLite path; token totals are read with `sqlite3 -readonly`. Missing DB yields null tokens.
- `PI_FALLBACK_ROW`: comma-separated ordered fallback model IDs.

Per-pool limits live in `$PI_RUN_ROOT/limits.json`: `{"cx":{"runs":3,"calls":6}}`.

## Safety

- The router database is only ever opened read-only; no key values are selected.
- Every pool is treated as rate limited: default 3 concurrent runs and 6 concurrent calls per pool, quota exits (rc 4) trigger a cooldown that doubles from 5 to 60 minutes.
- Prompts and briefs are not logged.

## Tests

```
bun test server.test.ts
bun test protocol.test.ts
PI_DURABLE_SCRIPT=/path/durable-pi.sh PI_STATUS_SCRIPT=/path/pi-status.sh bun test durable.test.ts
bun check-guards.ts
```

The 6 tests in `durable.test.ts` exercise the real scripts and are skipped when `PI_DURABLE_SCRIPT` or `PI_STATUS_SCRIPT` is unset. `check-guards.ts` mutates source temporarily and restores it; run it alone.

## Known gaps

- One history row per durable invocation, not per internal attempt.
- PID reuse risk is reduced but not eliminated.
- Script subprocesses have no execution or output bounds.
