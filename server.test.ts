import { test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Service } from './service';
import { Database } from 'bun:sqlite';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extra: Record<string, any> = {}) {
  const root = resolve(`.test-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const status = `${root}/status.sh`;
  writeFileSync(status, '#!/bin/sh\nread n < "$1"\nprintf \'{"state":"running","turns":%s,"tools":%s,"retries":0,"last_tool":"read","idle_s":0}\\n\' "$n" "$n"\n', { mode: 0o700 });
  return { root, service: new Service({ root, status: [status], ...extra }) };
}

function history(root: string, rows: any[]) {
  writeFileSync(`${root}/runs.jsonl`, rows.map(row => JSON.stringify({ ts_start: Date.now() - 1000, ts_end: Date.now(), session: 's', model: 'cx/test', attempt: 1, rc: 0, turns: 0, tool_calls: 0, retries: 0, ...row })).join('\n') + '\n');
}

test('two quotas double cooldown, later success clears it', async () => {
  const { root, service } = fixture();
  history(root, [{ outcome: 'quota' }, { outcome: 'quota' }]);
  const [row] = await service.call('pi_history');
  expect(row.cooldown_until).toBeGreaterThan(Date.now() + 590_000);
  expect(row.success_pct).toBe(0);
  history(root, [{ outcome: 'quota' }, { outcome: 'quota' }, { outcome: 'ok' }]);
  expect((await service.call('pi_history'))[0].cooldown_until).toBeNull();
});

test('quota concurrency lowers cap for 24h; ten clean runs recover one slot', async () => {
  const { root, service } = fixture({ modelsUrl: 'http://127.0.0.1:1/v1/models', headroom: ['/usr/bin/false'] });
  history(root, [{ outcome: 'quota', concurrency: 3 }]);
  expect((await service.poolState('cx')).cap).toBe(2);
  history(root, [{ outcome: 'quota', concurrency: 3, ts_end: Date.now() - 86400_001 }]);
  expect((await service.poolState('cx')).cap).toBe(3);
  history(root, [{ outcome: 'quota', concurrency: 3 }, ...Array.from({ length: 10 }, () => ({ outcome: 'ok' }))]);
  expect((await service.poolState('cx')).cap).toBe(3);
});

test('models survive missing DB and expose history, headroom and caps', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }, { id: 'glm/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: [process.execPath, '-e', 'console.log(JSON.stringify([{pool:"cx",status:"LOW",percent_left:4,resets:"soon"}]))'], db: 'missing.sqlite' });
    history(root, [{ outcome: 'ok' }, { outcome: 'quota', concurrency: 3 }]);
    const models = await service.call('pi_models');
    expect(models[0]).toMatchObject({ model: 'cx/test', runs: 2, success_pct: 50, quota_count: 1, status: 'LOW', percent_left: 4, resets: 'soon', cap: 2, tokens: null });
    expect(models[1]).toMatchObject({ model: 'glm/test', tokens: null, cap: 3 });
  } finally { http.stop(true); }
});

test('start refuses run/call caps and cooldown with eligible fallback', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }, { id: 'glm/test' }, { id: 'lc/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: [process.execPath, '-e', 'console.log(JSON.stringify([{pool:"glm",status:"LOW"},{pool:"lc",status:"OK"}]))'], fallback: ['cx/test', 'glm/test', 'lc/test'] });
    const args = { worktree: root, session: 'fourth', model: 'cx/test', brief_path: `${root}/brief` };
    writeFileSync(args.brief_path, 'fake brief');
    writeFileSync(`${root}/active.json`, JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ session: `s${i}`, model: 'cx/test', pid: process.pid }))));
    expect(await service.call('pi_start', args)).toMatchObject({ error: 'rate_limited', alternative: 'lc/test' });
    writeFileSync(`${root}/active.json`, JSON.stringify([{ session: 's', model: 'cx/test', pid: process.pid, calls_in_flight: 6 }]));
    expect(await service.call('pi_start', args)).toMatchObject({ error: 'rate_limited' });
    writeFileSync(`${root}/active.json`, '[]');
    history(root, [{ outcome: 'quota' }]);
    expect(await service.call('pi_start', args)).toMatchObject({ error: 'rate_limited' });
  } finally { http.stop(true); }
});

test('detached run survives service restart; stop kills children; resume keeps session', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: [process.execPath, '-e', 'console.log("[]")'] });
  const fake = `${root}/durable.sh`;
  writeFileSync(fake, '#!/bin/sh\nif [ -f "$PI_RUN_ROOT/continue" ]; then echo "=== pi exit 0 ==="; exit 0; fi\nsh -c \'trap "echo termed > \\"$PI_RUN_ROOT/termed\\"; exit 0" TERM; sleep 60 \& wait $!\' \&\necho $! > "$PI_RUN_ROOT/child"\nwait\n', { mode: 0o700 });
  service.config.durable = [fake];
  const args = { worktree: root, session: 'stable', model: 'cx/test', brief_path: `${root}/brief` };
  writeFileSync(args.brief_path, 'fake');
  let pid: number | undefined;
  try {
    const started = await service.call('pi_start', args);
    pid = started.pid;
    expect(pid).toBeGreaterThan(1);
    await until(() => Bun.file(`${root}/child`).exists());
    const restarted = new Service(service.config);
    expect((await restarted.call('pi_list')).active[0]).toMatchObject({ session: 'stable', pid });
    const child = Number(await Bun.file(`${root}/child`).text());
    expect(await restarted.call('pi_stop', { session: 'stable' })).toMatchObject({ stopped: true });
    expect((await restarted.call('pi_history'))[0].last_failure_reason).toBe('killed');
    expect(historyRows(root)[0].reconciled).toBeUndefined();
    expect(existsSync(`${root}/termed`)).toBe(true);
    expect(() => process.kill(child, 0)).toThrow();
    writeFileSync(`${root}/continue`, 'yes');
    const resumed = await restarted.call('pi_resume', { session: 'stable' });
    pid = resumed.pid;
    await until(async () => (await Bun.file(resumed.log).text()).includes('=== pi exit 0 ==='));
    await until(async () => (await restarted.call('pi_history'))[0]?.success_pct === 50);
    expect((await restarted.call('pi_list')).recent.every((row: any) => row.session === 'stable')).toBe(true);
  } finally { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } http.stop(true); }
});
async function until(check: () => any) {
  const deadline = Date.now() + 4000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('fixture timed out');
    await Bun.sleep(10);
  }
}

test('unreadable policy returns rc 3; wrapper records policy without invoking durable', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: ['/usr/bin/false'], durable: ['/usr/bin/false'] });
    service.config.policy = `${root}/missing-policy`;
    writeFileSync(`${root}/brief`, 'fake');
    const started = await service.call('pi_start', { worktree: root, session: 'policy', model: 'cx/test', brief_path: `${root}/brief` });
    expect(started.rc).toBe(3);
    expect((await service.call('pi_history'))[0].last_failure_reason).toBe('policy');
  } finally { http.stop(true); }
});

test('gone wrapper overrides stale running status without exit marker', async () => {
  const { root, service } = fixture();
  const log = `${root}/dead.log`;
  writeFileSync(log, '9\n');
  writeFileSync(`${root}/active.json`, JSON.stringify([{ session: 'dead', pid: 2147483647, log, model: 'cx/test' }]));
  expect(await service.call('pi_status', { session: 'dead' })).toMatchObject({ state: 'dead', turns: 9 });
});

test('quota log produces wrapper history and model failure warning; sqlite usage read-only join', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: [process.execPath, '-e', 'console.log(JSON.stringify([{pool:"cx",status:"LOW"}]))'], durable: [process.execPath, '-e', 'console.log("429 quota"); process.exit(4)'] });
    service.config.db = `${root}/fake.sqlite`;
    const db = new Database(service.config.db);
    db.run('CREATE TABLE usageHistory (model TEXT, timestamp TEXT, promptTokens INTEGER, completionTokens INTEGER)');
    db.run('INSERT INTO usageHistory VALUES (?, ?, 11, 7)', ['cx/test', new Date().toISOString()]);
    db.close();
    writeFileSync(`${root}/brief`, 'fake');
    const started = await service.call('pi_start', { worktree: root, session: 'quota', model: 'cx/test', brief_path: `${root}/brief` });
    expect(started.warnings).toContain('pool LOW');
    await until(async () => (await service.call('pi_history'))[0]?.quota_count === 1);
    const ended = JSON.parse((await Bun.file(`${root}/runs.jsonl`).text()).trim());
    const update = new Database(service.config.db);
    update.run('UPDATE usageHistory SET timestamp = ?', [new Date(ended.ts_start).toISOString()]);
    update.close();
    const [model] = await service.call('pi_models');
    expect(model).toMatchObject({ success_pct: 0, quota_count: 1, tokens: { prompt: 11, completion: 7 } });
  } finally { http.stop(true); }
});

test('failure warning, limits overrides, history windows and invalid input stay enforced', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: ['/usr/bin/false'], durable: ['/usr/bin/true'] });
    history(root, [{ outcome: 'nonzero' }, { outcome: 'ok', model: 'glm/test' }, { outcome: 'ok', ts_end: Date.now() - 8 * 86400_000 }]);
    expect((await service.call('pi_history', { model: 'cx/test' }))[0].runs).toBe(1);
    writeFileSync(`${root}/limits.json`, JSON.stringify({ cx: { runs: 1, calls: 2 } }));
    expect(await service.poolState('cx')).toMatchObject({ cap: 1, call_cap: 2 });
    writeFileSync(`${root}/brief`, 'fake');
    const result = await service.call('pi_start', { worktree: root, session: 'warning', model: 'cx/test', brief_path: `${root}/brief` });
    expect(result.warnings).toContain('7-day failure rate exceeds 30%');
    await expect(service.call('pi_start', { worktree: root, session: '../bad', model: 'cx/test', brief_path: `${root}/brief` })).rejects.toThrow('invalid session');
    await expect(service.call('pi_history', { days: 0 })).rejects.toThrow();
  } finally { http.stop(true); }
});

test('wrapper history keeps status counters instead of zero defaults', async () => {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  try {
    const { root, service } = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: ['/usr/bin/false'], durable: [process.execPath, '-e', 'console.log("4")'] });
    writeFileSync(`${root}/brief`, 'fake');
    await service.call('pi_start', { worktree: root, session: 'counters', model: 'cx/test', brief_path: `${root}/brief` });
    await until(() => Bun.file(`${root}/runs.jsonl`).exists());
    const row = JSON.parse((await Bun.file(`${root}/runs.jsonl`).text()).trim());
    expect(row).toMatchObject({ turns: 4, tool_calls: 4 });
  } finally { http.stop(true); }
});

test('stop rejects stale process identity before signaling live unrelated group', async () => {
  const { root, service } = fixture();
  const child = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    writeFileSync(`${root}/active.json`, JSON.stringify([{ session: 'stale', pid: child.pid, identity: 'not-this-process' }]));
    await expect(service.call('pi_stop', { session: 'stale' })).rejects.toThrow('stale process identity');
    expect(process.kill(child.pid, 0)).toBe(true);
  } finally { child.kill(); await child.exited; }
});

test('status delegates fresh counters to status script on every poll', async () => {
  const { root, service } = fixture();
  const log = `${root}/run.log`;
  writeFileSync(log, '1\n');
  expect(await service.call('pi_status', { log })).toMatchObject({ turns: 1, tools: 1 });
  writeFileSync(log, '2\n');
  expect(await service.call('pi_status', { log })).toMatchObject({ turns: 2, tools: 2 });
});

async function startable(extra: Record<string, any> = {}, models = ['cx/test']) {
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: models.map(id => ({ id })) }) });
  const made = fixture({ modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: ['/usr/bin/false'], ...extra });
  writeFileSync(`${made.root}/brief`, 'fake');
  const args = (session: string, model = 'cx/test') => ({ worktree: made.root, session, model, brief_path: `${made.root}/brief` });
  return { ...made, http, args };
}
const slowDurable = (root: string, body = 'sleep 60 &\nwait\n') => {
  const path = `${root}/slow.sh`;
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o700 });
  return [path];
};
const killGroup = (pid?: number) => { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } };
const historyRows = (root: string) => existsSync(`${root}/runs.jsonl`) ? readFileSync(`${root}/runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

test('crash between spawn and registry save leaves run listed, adopted and stoppable', async () => {
  const crash = { afterSpawn: () => { throw new Error('simulated crash'); } };
  const { root, service, http, args } = await startable({ ...crash });
  service.config.durable = slowDurable(root);
  let adopted: any;
  try {
    await expect(service.call('pi_start', args('crashy'))).rejects.toThrow('simulated crash');
    const restarted = new Service({ ...service.config, afterSpawn: undefined });
    await until(async () => (await restarted.call('pi_list')).active[0]?.pid > 1);
    adopted = (await restarted.call('pi_list')).active[0];
    expect(adopted).toMatchObject({ session: 'crashy' });
    expect(adopted.pid).toBeGreaterThan(1);
    expect(await restarted.call('pi_stop', { session: 'crashy' })).toMatchObject({ stopped: true });
    expect(historyRows(root)).toMatchObject([{ outcome: 'killed' }]);
  } finally { killGroup(adopted?.pid); http.stop(true); }
});

test('launch with no worker is listed during grace, then failed once and recorded', async () => {
  const { root, service } = fixture({ launchGraceMs: 5000 });
  const launching = { session: 'ghost', model: 'cx/test', attempt: 1, pid: null, launching: true, launched_at: Date.now(), descriptor: `${root}/ghost.1.json`, log: `${root}/ghost.1.log` };
  writeFileSync(`${root}/active.json`, JSON.stringify([launching]));
  expect((await service.call('pi_list')).active.map((row: any) => row.session)).toEqual(['ghost']);
  expect(historyRows(root)).toEqual([]);
  writeFileSync(`${root}/active.json`, JSON.stringify([{ ...launching, launched_at: Date.now() - 6000 }]));
  expect((await service.call('pi_list')).active).toEqual([]);
  await service.call('pi_list');
  expect(historyRows(root)).toMatchObject([{ session: 'ghost', attempt: 1, outcome: 'nonzero' }]);
});

test('dead worker without history row is recorded killed exactly once', async () => {
  const { root, service } = fixture();
  writeFileSync(`${root}/active.json`, JSON.stringify([{ session: 'gone', model: 'cx/test', attempt: 2, pid: 2147483647, log: `${root}/gone.log` }]));
  await service.call('pi_list');
  await service.call('pi_history');
  expect(historyRows(root)).toMatchObject([{ session: 'gone', attempt: 2, outcome: 'killed' }]);
});

test('stale start lock from dead owner is recovered; live owner lock is respected', async () => {
  const { root, service, http, args } = await startable({ lockWaitMs: 300 });
  service.config.durable = ['/usr/bin/true'];
  try {
    mkdirSync(`${root}/start.lock`);
    writeFileSync(`${root}/start.lock/owner`, JSON.stringify({ pid: 2147483647, ts: Date.now() }));
    expect(await service.call('pi_start', args('after-crash'))).toMatchObject({ log: expect.any(String) });
    mkdirSync(`${root}/start.lock`);
    writeFileSync(`${root}/start.lock/owner`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await expect(service.call('pi_start', args('blocked'))).rejects.toThrow('run registry locked');
    rmSync(`${root}/start.lock`, { recursive: true });
    mkdirSync(`${root}/start.lock`);
    writeFileSync(`${root}/start.lock/owner`, JSON.stringify({ pid: process.pid, ts: Date.now() - 120_000 }));
    expect(await service.call('pi_start', args('old-lock'))).toMatchObject({ log: expect.any(String) });
  } finally { http.stop(true); }
});

test('concurrent starts serialize: one session admits once, cap one admits one', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = slowDurable(root);
  const pids: number[] = [];
  try {
    const same = await Promise.allSettled([service.call('pi_start', args('twin')), service.call('pi_start', args('twin'))]);
    for (const row of same) if (row.status === 'fulfilled') pids.push(row.value.pid);
    expect(same.filter(row => row.status === 'fulfilled').length).toBe(1);
    expect(same.find(row => row.status === 'rejected')).toMatchObject({ reason: { message: 'session already active' } });
    await service.call('pi_stop', { session: 'twin' });
    writeFileSync(`${root}/limits.json`, JSON.stringify({ cx: { runs: 1, calls: 6 } }));
    const capped = await Promise.all([service.call('pi_start', args('one')), service.call('pi_start', args('two'))]);
    for (const row of capped) if (row.pid) pids.push(row.pid);
    expect(capped.filter(row => row.error === 'rate_limited').length).toBe(1);
    expect(capped.filter(row => row.pid).length).toBe(1);
  } finally { pids.forEach(killGroup); http.stop(true); }
});

test('forced termination: stop records killed itself and status reports dead', async () => {
  const { root, service, http, args } = await startable({ stopGraceMs: 150 });
  service.config.durable = slowDurable(root, 'echo 3\ntrap "" TERM\nwhile true; do sleep 1; done\n');
  let pid: number | undefined;
  try {
    pid = (await service.call('pi_start', args('stubborn'))).pid;
    await Bun.sleep(300);
    expect(await service.call('pi_stop', { session: 'stubborn' })).toMatchObject({ stopped: true });
    expect(historyRows(root)).toMatchObject([{ session: 'stubborn', outcome: 'killed' }]);
    expect(await service.call('pi_status', { session: 'stubborn' })).toMatchObject({ state: 'dead' });
  } finally { killGroup(pid); http.stop(true); }
});

test('quota run records retry-after and reset metadata that drive cooldown', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = [process.execPath, '-e', 'console.log("429 too many requests, retry-after: 120"); process.exit(4)'];
  try {
    await service.call('pi_start', args('limited'));
    await until(() => historyRows(root).length === 1);
    const [row] = historyRows(root);
    expect(row).toMatchObject({ outcome: 'quota', rc: 4, retry_after_s: 120 });
    const [summary] = await service.call('pi_history');
    expect(summary.cooldown_until).toBeGreaterThan(Date.now() + 100_000);
    expect(summary.cooldown_until).toBeLessThan(Date.now() + 130_000);
  } finally { http.stop(true); }
});

test('quota run records absolute reset time', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = [process.execPath, '-e', 'console.log("quota resets at 2099-01-01T00:00:00Z"); process.exit(4)'];
  try {
    await service.call('pi_start', args('limited'));
    await until(() => historyRows(root).length === 1);
    expect(historyRows(root)[0]).toMatchObject({ outcome: 'quota', reset_at: '2099-01-01T00:00:00Z' });
    expect((await service.call('pi_history'))[0].cooldown_until).toBe(Date.parse('2099-01-01T00:00:00Z'));
  } finally { http.stop(true); }
});

test('429 text in output of a successful run is not a quota', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = [process.execPath, '-e', 'console.log("handled 429 items")'];
  try {
    await service.call('pi_start', args('fine'));
    await until(() => historyRows(root).length === 1);
    expect(historyRows(root)[0]).toMatchObject({ outcome: 'ok' });
  } finally { http.stop(true); }
});

test('stop after a normal finish adds no second history row', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = ['/usr/bin/true'];
  try {
    await service.call('pi_start', args('finished'));
    await until(() => historyRows(root).length === 1);
    expect(await service.call('pi_stop', { session: 'finished' })).toMatchObject({ stopped: true });
    expect(historyRows(root)).toMatchObject([{ outcome: 'ok' }]);
  } finally { http.stop(true); }
});

test('durable terminated by a signal is recorded killed, not nonzero', async () => {
  const { root, service, http, args } = await startable();
  service.config.durable = slowDurable(root, 'kill -TERM $$\n');
  try {
    await service.call('pi_start', args('signalled'));
    await until(() => historyRows(root).length === 1);
    expect(historyRows(root)[0]).toMatchObject({ outcome: 'killed', rc: 143 });
  } finally { http.stop(true); }
});

test('pid file pointing at an unrelated live process is not adopted or signalled', async () => {
  const { root, service } = fixture({ launchGraceMs: 60_000 });
  const stranger = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const descriptor = `${root}/alien.1.json`;
    writeFileSync(`${descriptor}.pid`, String(stranger.pid));
    writeFileSync(`${root}/active.json`, JSON.stringify([{ session: 'alien', model: 'cx/test', attempt: 1, pid: null, launching: true, launched_at: Date.now(), descriptor, log: `${root}/alien.1.log` }]));
    const [run] = (await service.call('pi_list')).active;
    expect(run.pid).toBeNull();
    await expect(service.call('pi_stop', { session: 'alien' })).rejects.toThrow('unsafe pid');
    expect(process.kill(stranger.pid, 0)).toBe(true);
  } finally { stranger.kill(); await stranger.exited; }
});
