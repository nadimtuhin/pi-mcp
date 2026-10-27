# pi MCP (thin layer over durable-pi.sh + pi-status.sh)

The scripts remain the source of truth. All state lives in files, so a crash of the MCP server never orphans or loses a run. Runs are detached (setsid), never children of the MCP.

## Tools
1. `pi_start(worktree, session, model, brief_path)` -> {pid, log}. It warns if the model's pool is LOW or EXHAUSTED, or if the 7-day failure rate is over 30%.
2. `pi_status(log | session)` -> {state, turns, tools, retries, last_tool, idle_s}. This is the pi-status.sh output as JSON.
3. `pi_stop(session)` kills the wrapper and its children, and verifies none are left.
4. `pi_resume(session)` reruns durable-pi.sh with the same session.
5. `pi_list()` lists active and recent runs from the run history.
6. `pi_models()` lists live models from `/v1/models`, joined with:
   - `model-headroom --json`: pool, % left, resets
   - the run history: 7-day runs, success %, 429/quota count, median duration, last failure reason
7. `pi_history(model?, days=7)` returns per-model rows from the run history.

## Run history (new)
- Append-only JSONL at `~/.cache/pi-runs/runs.jsonl`, with one row per attempt end, written by durable-pi.sh (not the MCP), so history survives without the MCP.
- Fields: ts_start, ts_end, session, model, attempt, rc, outcome. Outcome is one of:
  - `ok`
  - `nonzero`
  - `quota` (429/quota text in the log)
  - `policy` (rc 3)
  - `killed`
- Further fields: turns, tool_calls, retries.
- Token counts come from 9router `usageHistory`, read-only (`sqlite3 -readonly`), joined by time window. Never write to 9router's DB.
- No secrets in rows. Briefs are referenced by path, not content.

## Rate limits (assume them, learn them)
- Every pool is assumed rate-limited. Default caps per pool are 3 concurrent runs and 6 concurrent calls (the 9router guidance). They are overridable in `~/.cache/pi-runs/limits.json`.
- pi_start refuses with `rate_limited` and a suggested alternative model when either holds:
  - the pool is at its concurrency cap
  - the pool is in cooldown
- Cooldown is set by a `quota` outcome and lasts:
  - the 9router retry-after or reset time if known
  - otherwise 5 min, doubling per consecutive quota hit, capped at 60 min
  It clears on the next `ok`.
- Learned cap: if a pool hit quota at concurrency N in the last 24h, its cap drops to N-1 (floor 1). It rises by 1 after 10 clean runs.
- pi_models shows per pool: cap, in-flight, cooldown_until, learned_from.
- The alternative model is the next model in the pi-delegate fallback row whose pool is not LOW, EXHAUSTED or in cooldown.

## Scenarios (Given/When/Then)
1. Given a run is in progress, when pi_status is called, then turns and tools rise across polls.
2. Given a run, when pi_stop is called, then no process for that session remains and the history row says `killed`.
3. Given a stopped run, when pi_resume is called, then the same session continues and its log ends with `=== pi exit 0 ===`.
4. Given an unreadable permission policy, when pi_start is called, then rc 3 is returned and the history row says `policy`.
5. Given a log with a 429 line, then the history outcome is `quota`, and pi_models shows a higher failure % for that model.
6. Given the MCP restarts mid-run, when pi_list is called, then the run is still listed and controllable.
7. Negative: given the 9router DB is missing, pi_models still returns models, with token fields null.

8. Given a pool with 3 runs in flight, when a 4th pi_start targets it, then the result is `rate_limited` with an alternative model from another pool.
9. Given two consecutive `quota` outcomes on cx, then cx cooldown is 10 min, and a later `ok` clears it.
10. Given a quota hit at concurrency 3, then that pool's learned cap is 2 for 24h.

11. Given a killed run (control test C2/C5 showed `running` with idle growing), pi_status reports `dead` when the wrapper pid is gone and no exit marker exists.

Every test must fail when its guard is deleted.
