import { test, expect } from 'bun:test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

test('stdio handshake, discovery, notification silence, errors and tool validation', async () => {
  const proc = Bun.spawn([process.execPath, 'index.ts'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, PI_RUN_ROOT: `${import.meta.dir}/.protocol-unused` } });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pi_start', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'absent' },
  ];
  proc.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n{bad\n');
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  rmSync(`${import.meta.dir}/.protocol-unused`, { recursive: true, force: true });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  expect(replies.length).toBe(5);
  expect(replies.find(row => row.id === 1).result).toMatchObject({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  expect(replies.find(row => row.id === 2).result.tools.map((row: any) => row.name).sort()).toEqual(['pi_history', 'pi_list', 'pi_models', 'pi_resume', 'pi_start', 'pi_status', 'pi_stop']);
  expect(replies.find(row => row.id === 3).result.isError).toBe(true);
  expect(replies.find(row => row.id === 4).error.code).toBe(-32601);
  expect(replies.find(row => row.id === null).error.code).toBe(-32700);
});

test('a slow tool call does not block later requests', async () => {
  const dir = `${import.meta.dir}/.protocol-slow`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/slow.sh`, '#!/bin/sh\nsleep 1\necho \'{"state":"running","turns":1,"tools":1,"retries":0}\'\n', { mode: 0o700 });
  const proc = Bun.spawn([process.execPath, 'index.ts'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, PI_RUN_ROOT: dir, PI_STATUS_SCRIPT: `${dir}/slow.sh` } });
  try {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pi_status', arguments: { log: `${dir}/x.log` } } }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    const ids = output.trim().split('\n').map(line => JSON.parse(line).id);
    expect(ids).toEqual([2, 1]);
  } finally { await proc.exited; rmSync(dir, { recursive: true, force: true }); }
});
