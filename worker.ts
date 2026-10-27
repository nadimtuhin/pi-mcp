import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseStatus } from './service';

writeFileSync(`${process.argv[2]}.pid`, String(process.pid));
const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ts_start = Date.now();
let killed = false;
let policy = false;
let child: ReturnType<typeof spawn> | undefined;
process.on('SIGTERM', () => { killed = true; child?.kill('SIGTERM'); });
let rc = 1;
try {
  if (run.policy) {
    const data = readFileSync(run.policy, 'utf8');
    JSON.parse(data);
  }
} catch { policy = true; rc = 3; }
if (!policy) {
  rc = await new Promise<number>(resolve => {
    child = spawn(run.durable[0], [...run.durable.slice(1), run.worktree, run.session, run.model, run.brief_path, run.log], {
      cwd: run.worktree, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PI_RUN_ROOT: run.root, PI_RUN_SESSION: run.session },
    });
    child.once('error', () => resolve(127));
    child.once('spawn', () => writeFileSync(`${process.argv[2]}.started`, ''));
    child.once('exit', (code, signal) => { if (signal === 'SIGTERM') killed = true; resolve(code ?? 143); });
  });
}
const text = readFileSync(run.log, 'utf8');
const outcome = killed ? 'killed' : policy || rc === 3 ? 'policy' : rc === 4 ? 'quota' : rc === 0 ? 'ok' : 'nonzero';
const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
const retryAfter = outcome === 'quota' ? last(/retry[-_ ]?after\D{0,3}(\d+)/gi) : undefined;
const resetAt = outcome === 'quota' ? last(/reset(?:s|_at)?\D{0,4}(\d{4}-\d\d-\d\dT[\d:.]+Z?)/gi) : undefined;
let counters = { turns: 0, tool_calls: 0, retries: 0 };
try {
  const status = Bun.spawn([...run.status, run.log], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(status.stdout).text();
  if (await status.exited === 0) {
    const data = parseStatus(output);
    counters = { turns: data.turns, tool_calls: data.tools, retries: data.retries };
  }
} catch {}
appendFileSync(`${run.root}/runs.jsonl`, JSON.stringify({ ts_start, ts_end: Date.now(), session: run.session, model: run.model, attempt: run.attempt, rc, outcome, ...counters, concurrency: run.concurrency, ...(retryAfter ? { retry_after_s: Number(retryAfter) } : {}), ...(resetAt ? { reset_at: resetAt } : {}) }) + '\n');
process.exitCode = rc;
