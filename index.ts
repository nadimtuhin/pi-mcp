import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { Service } from './service';

const root = process.env.PI_RUN_ROOT ?? `${homedir()}/.cache/pi-runs`;
const service = new Service({ root, modelsUrl: process.env.PI_MODELS_URL,
  status: process.env.PI_STATUS_SCRIPT ? [process.env.PI_STATUS_SCRIPT] : undefined,
  durable: process.env.PI_DURABLE_SCRIPT ? [process.env.PI_DURABLE_SCRIPT] : undefined,
  headroom: process.env.PI_HEADROOM_SCRIPT ? [process.env.PI_HEADROOM_SCRIPT, '--json'] : undefined,
  policy: process.env.PI_POLICY_PATH, db: process.env.PI_ROUTER_DB,
  fallback: process.env.PI_FALLBACK_ROW?.split(',').filter(Boolean),
});
const definitions: Record<string, { description: string; required: string[]; properties: Record<string, any> }> = {
  pi_start: { description: 'Start detached pi run with pool admission checks.', required: ['worktree', 'session', 'model', 'brief_path'], properties: { worktree: { type: 'string' }, session: { type: 'string' }, model: { type: 'string' }, brief_path: { type: 'string' } } },
  pi_status: { description: 'Read current script status by log or session.', required: [], properties: { log: { type: 'string' }, session: { type: 'string' } } },
  pi_stop: { description: 'Stop session process group and verify history.', required: ['session'], properties: { session: { type: 'string' } } },
  pi_resume: { description: 'Resume saved session using original arguments.', required: ['session'], properties: { session: { type: 'string' } } },
  pi_list: { description: 'List live runs and attempt history.', required: [], properties: {} },
  pi_models: { description: 'Join live models with pool and history statistics.', required: [], properties: {} },
  pi_history: { description: 'Summarize model attempts within day window.', required: [], properties: { model: { type: 'string' }, days: { type: 'number', exclusiveMinimum: 0, default: 7 } } },
};
async function dispatch(request: any) {
  const id = request?.id ?? null;
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && typeof request.id !== 'number' && typeof request.id !== 'string' && request.id !== null)) return error(-32600, 'Invalid Request');
  if (request.id === undefined) return;
  let result: any;
  if (request.method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
    result = { protocolVersion: supported.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pi-mcp', version: '0.1.0' } };
  } else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: Object.entries(definitions).map(([name, definition]) => ({ name, description: definition.description, inputSchema: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false } })) };
  else if (request.method === 'tools/call') {
    const name = request.params?.name;
    const definition = definitions[name];
    if (!definition) return error(-32602, 'Unknown tool');
    const args = request.params.arguments ?? {};
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !definition.properties[key]) || definition.required.some(key => args[key] === undefined) || Object.entries(args).some(([key, value]) => typeof value !== definition.properties[key].type)) throw new Error('invalid arguments');
      const value = await service.call(name, args);
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], ...(value?.error ? { isError: true } : {}) };
    } catch (error: any) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
  } else return error(-32601, 'Method not found');
  return { jsonrpc: '2.0', id, result };
}
async function handle(line: string) {
  let reply: any;
  try { const request = JSON.parse(line); reply = await dispatch(request); }
  catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
}
const pending: Promise<void>[] = [];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) pending.push(handle(line));
await Promise.all(pending);
