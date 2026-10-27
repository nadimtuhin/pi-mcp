import { test as bunTest, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Service } from './service';

const durableScript = process.env.PI_DURABLE_SCRIPT;
const statusScript = process.env.PI_STATUS_SCRIPT;
const test = durableScript && statusScript ? bunTest : bunTest.skip;
const realHome = process.env.HOME!;
const realPath = process.env.PATH!;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); process.env.HOME = realHome; process.env.PATH = realPath; });

async function until(check: () => any, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('fixture timed out');
    await Bun.sleep(20);
  }
}
const piScript = (events: string, tail: string) => `#!/bin/sh
cat <<'EOF_EVENTS'
${events}
EOF_EVENTS
${tail}
`;
async function setup(pi: string, policy = true) {
  const root = resolve(`.test-${crypto.randomUUID()}`);
  const home = `${root}/home`, bin = `${root}/bin`;
  mkdirSync(bin, { recursive: true });
  mkdirSync(`${home}/.pi/agent/extensions/pi-permission-system`, { recursive: true });
  if (policy) writeFileSync(`${home}/.pi/agent/extensions/pi-permission-system/config.json`, '{}');
  writeFileSync(`${bin}/pi`, pi, { mode: 0o700 });
  writeFileSync(`${bin}/osascript`, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(`${root}/brief`, 'fake brief');
  process.env.HOME = home;
  process.env.PATH = `${bin}:${realPath}`;
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'cx/test' }] }) });
  const service = new Service({ root: `${root}/state`, modelsUrl: `http://127.0.0.1:${http.port}/v1/models`, headroom: ['/usr/bin/false'],
    durable: [durableScript!], status: [statusScript!], stopGraceMs: 200 });
  cleanups.push(() => { http.stop(true); rmSync(root, { recursive: true, force: true }); });
  const args = (session: string) => ({ worktree: root, session, model: 'cx/test', brief_path: `${root}/brief` });
  const rows = () => existsSync(`${root}/state/runs.jsonl`) ? readFileSync(`${root}/state/runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, service, args, rows };
}
const events = [
  '{"type":"turn_start"}',
  '{"type":"tool_execution_start","toolName":"read","args":{"path":"a.ts"}}',
  '{"type":"turn_start"}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"handled 429 items"}]}}',
].join('\n');

test('real durable-pi.sh success: exit 0, ok state file, text status parsed, 429 in output is not quota', async () => {
  const { service, args, rows } = await setup(piScript(events, 'exit 0'));
  const started = await service.call('pi_start', args('real-ok'));
  await until(() => rows().length === 1);
  expect(rows()[0]).toMatchObject({ outcome: 'ok', rc: 0, turns: 2, tool_calls: 1, retries: 0 });
  expect(readFileSync(`${started.log}.state`, 'utf8').trim()).toBe('ok');
  expect(await service.call('pi_status', { session: 'real-ok' })).toMatchObject({ state: 'ok', turns: 2, tools: 1, retries: 0, last_tool: 'read' });
});

test('real durable-pi.sh exit 4 is a quota with retry metadata from the log', async () => {
  const { service, args, rows } = await setup(piScript(events, 'echo "429 rate limit exceeded, retry-after: 90" >&2\nexit 1'));
  const started = await service.call('pi_start', args('real-quota'));
  await until(() => rows().length === 1);
  expect(rows()[0]).toMatchObject({ outcome: 'quota', rc: 4, retry_after_s: 90 });
  expect(readFileSync(`${started.log}.state`, 'utf8').trim()).toBe('quota');
  expect((await service.call('pi_status', { session: 'real-quota' })).state).toBe('quota');
});

test('real durable-pi.sh exit 3 on unreadable policy is recorded as policy', async () => {
  const { service, args, rows } = await setup(piScript(events, 'exit 0'), false);
  const started = await service.call('pi_start', args('real-policy'));
  await until(() => rows().length === 1);
  expect(rows()[0]).toMatchObject({ outcome: 'policy', rc: 3 });
  expect(started.rc).toBe(3);
  expect(readFileSync(`${started.log}.state`, 'utf8').trim()).toBe('policy');
});

test('real stop of a running durable-pi.sh records killed and status says dead', async () => {
  const { service, args, rows } = await setup(piScript(events, 'sleep 60'));
  const started = await service.call('pi_start', args('real-kill'));
  await until(() => existsSync(`${started.log}.pid`));
  await until(async () => (await service.call('pi_status', { session: 'real-kill' })).tools === 1);
  expect(await service.call('pi_status', { session: 'real-kill' })).toMatchObject({ state: 'running' });
  expect(await service.call('pi_stop', { session: 'real-kill' })).toMatchObject({ stopped: true });
  expect(rows()).toMatchObject([{ session: 'real-kill', outcome: 'killed' }]);
  expect(await service.call('pi_status', { session: 'real-kill' })).toMatchObject({ state: 'dead', turns: 2 });
});

test('status of a log with no events yet parses the no-events line', async () => {
  const { root, service } = await setup(piScript(events, 'exit 0'));
  writeFileSync(`${root}/empty.log`, '=== attempt 1 ===\n');
  expect(await service.call('pi_status', { log: `${root}/empty.log` })).toMatchObject({ state: 'running', turns: 0, tools: 0 });
});

test('status of a finished log without state file maps the exit marker to ok', async () => {
  const { root, service } = await setup(piScript(events, 'exit 0'));
  writeFileSync(`${root}/done.log`, '=== attempt 1 ===\n=== pi exit 0 ===\n');
  expect(await service.call('pi_status', { log: `${root}/done.log` })).toMatchObject({ state: 'ok' });
});
