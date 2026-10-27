import { readFileSync, writeFileSync } from 'node:fs';

const cases = [
  ['service.ts', "const child = Bun.spawn([...(this.config.status ?? ['pi-status.sh']), log]", "const child = Bun.spawn(['/usr/bin/false', log]", 'status delegates'],
  ['service.ts', 'hits++;', 'hits = 1;', 'two quotas'],
  ['service.ts', 'hits = 0; cooldown = null;', 'hits = 0;', 'two quotas'],
  ['service.ts', 'row.concurrency - 1', 'row.concurrency', 'quota concurrency'],
  ['service.ts', 'now - 86400_000', 'now - 86400_0000', 'quota concurrency'],
  ['service.ts', 'cap = Math.min(base, cap + 1)', 'cap = cap', 'quota concurrency'],
  ['service.ts', 'state.in_flight >= state.cap', 'false', 'start refuses'],
  ['service.ts', 'state.calls_in_flight >= state.call_cap', 'false', 'start refuses'],
  ['service.ts', '|| state.cooldown_until', '|| false', 'start refuses'],
  ['service.ts', "!['LOW', 'EXHAUSTED', 'UNKNOWN'].includes(model.status)", 'true', 'start refuses'],
  ['service.ts', 'tokens: await this.tokens(id)', 'tokens: null', 'sqlite usage'],
  ['service.ts', "tokens: await this.tokens(id)", "tokens: { prompt: 0, completion: 0 }", 'models survive'],
  ['service.ts', "result.state = 'dead'", "result.state = 'running'", 'gone wrapper'],
  ['service.ts', 'process.kill(-run.pid, \'SIGTERM\')', 'process.kill(run.pid, \'SIGTERM\')', 'detached run'],
  ['service.ts', 'return this.call(\'pi_start\', run)', "return { error: 'disabled' }", 'detached run'],
  ['worker.ts', 'policy = true; rc = 3;', 'policy = false; rc = 0;', 'unreadable policy'],
  ['worker.ts', 'rc === 4 ? \'quota\'', 'false ? \'quota\'', 'quota log'],
  ['worker.ts', "killed ? 'killed'", "killed ? 'nonzero'", 'detached run'],
  ['worker.ts', 'turns: data.turns, tool_calls: data.tools', 'turns: 0, tool_calls: 0', 'keeps status counters'],
  ['index.ts', 'if (request.id === undefined) return;', '', 'stdio handshake'],
  ['index.ts', "throw new Error('invalid arguments')", "return { jsonrpc: '2.0', id, result: {} }", 'stdio handshake'],
  ['service.ts', "this.saveRuns([...others, { ...run, pid: null, launching: true, launched_at: Date.now() }]);", 'void 0;', 'crash between'],
  ['service.ts', '(await commandOf(pid)).includes(run.descriptor)', 'false', 'crash between'],
  ['worker.ts', 'writeFileSync(`${process.argv[2]}.pid`, String(process.pid));', '', 'crash between'],
  ['service.ts', '<= (this.config.launchGraceMs ?? 5000)', '<= 1e15', 'launch with no worker'],
  ['service.ts', "this.recordEnd(run, 'nonzero', -1)", 'void 0', 'launch with no worker'],
  ['service.ts', 'if (rows.some(row => row.session === run.session && row.attempt === run.attempt)) return;', '', 'stop after a normal finish'],
  ['service.ts', "} else if (run.pid && !alive(run.pid)) this.recordEnd", "} else if (false) this.recordEnd", 'dead worker'],
  ['service.ts', 'if (this.needsReconcile())', 'if (false)', 'dead worker'],
  ['service.ts', 'return !alive(owner.pid) ||', 'return false ||', 'stale start lock'],
  ['service.ts', 'Date.now() - owner.ts > (this.config.lockStaleMs ?? 60_000)', 'false', 'stale start lock'],
  ['service.ts', 'if (this.lockIsStale(lock))', 'if (true)', 'stale start lock'],
  ['service.ts', "if (Date.now() >= deadline) throw new Error('run registry locked; retry');", "throw new Error('run registry locked; retry');", 'concurrent starts'],
  ['service.ts', "if (!recorded()) this.recordEnd(run, 'killed', 137);", '', 'forced termination'],
  ['service.ts', 'if (finalState) result.state = finalState;', 'if (false) result.state = finalState;', 'exit 4 is a quota', 'durable.test.ts'],
  ['service.ts', "last_tool: counted && match[5] !== '-' ? match[5] : null", 'last_tool: null', 'real durable-pi.sh success', 'durable.test.ts'],
  ['service.ts', "raw === 'pi exit 0' ? 'ok'", "raw === 'pi exit 0' ? 'finished'", 'maps the exit marker', 'durable.test.ts'],
  ['worker.ts', 'run.brief_path, run.log]', 'run.brief_path]', 'real durable-pi.sh success', 'durable.test.ts'],
  ['worker.ts', 'policy || rc === 3 ?', 'policy ?', 'exit 3 on unreadable', 'durable.test.ts'],
  ['worker.ts', "rc === 4 ? 'quota'", "/429|quota/i.test(text) ? 'quota'", '429 text in output'],
  ['worker.ts', "outcome === 'quota' ? last(/retry", "false ? last(/retry", 'quota run records retry-after'],
  ['worker.ts', "outcome === 'quota' ? last(/reset", "false ? last(/reset", 'quota run records absolute'],
  ['worker.ts', "if (signal === 'SIGTERM') killed = true;", '', 'terminated by a signal'],
  ['index.ts', 'pending.push(handle(line));', 'await handle(line);', 'a slow tool call'],
];
let failed = 0;
for (const [file, before, after, filter, suite] of cases) {
  const original = readFileSync(file, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`ambiguous mutation: ${before}`);
  let code: number;
  try {
    writeFileSync(file, original.replace(before, after));
    const child = Bun.spawn([process.execPath, 'test', suite ?? (file === 'index.ts' ? 'protocol.test.ts' : 'server.test.ts'), '-t', filter], { stdout: 'ignore', stderr: 'ignore' });
    code = await child.exited;
  } finally { writeFileSync(file, original); }
  console.log(`${code !== 0 ? 'KILLED' : 'SURVIVED'} ${file}: ${before}`);
  if (code === 0) failed++;
}
if (failed) throw new Error(`${failed} mutations survived`);
