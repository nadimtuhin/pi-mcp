import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, accessSync, constants, statSync, openSync, closeSync, appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export type Config = { root: string; status?: string[]; modelsUrl?: string; headroom?: string[]; fallback?: string[]; durable?: string[]; policy?: string; db?: string;
  stopGraceMs?: number; lockWaitMs?: number; lockStaleMs?: number; launchGraceMs?: number; afterSpawn?: () => void;
  identity?: (pid: number) => Promise<string>; kill?: (pid: number, signal: NodeJS.Signals | 0) => void };
const poolOf = (model: string) => model.split('/')[0];
function jsonFile(path: string, fallback: any): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function readHistory(root: string): any[] {
  let text: string;
  try { text = readFileSync(`${root}/runs.jsonl`, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map((line, index, lines) => {
    try { return JSON.parse(line); }
    catch { if (index === lines.length - 1 && !text.endsWith('\n')) return null; throw new Error('corrupt run history'); }
  }).filter(Boolean);
}
const time = (value: any) => typeof value === 'number' ? value : Date.parse(value);
export function summarize(rows: any[], now = Date.now()): any[] {
  return [...new Set(rows.map(row => row.model))].map(model => {
    const attempts = rows.filter(row => row.model === model).sort((a, b) => time(a.ts_end) - time(b.ts_end));
    let hits = 0, cooldown: number | null = null;
    for (const row of attempts) {
      if (row.outcome === 'ok') { hits = 0; cooldown = null; }
      if (row.outcome === 'quota') {
        hits++;
        cooldown = row.reset_at ? time(row.reset_at) : time(row.ts_end) + (row.retry_after_s ? row.retry_after_s * 1000 : Math.min(60, 5 * 2 ** (hits - 1)) * 60_000);
      }
    }
    const durations = attempts.map(row => time(row.ts_end) - time(row.ts_start)).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const failures = attempts.filter(row => row.outcome !== 'ok');
    return { model, runs: attempts.length, success_pct: 100 * (attempts.length - failures.length) / attempts.length,
      quota_count: attempts.filter(row => row.outcome === 'quota').length,
      median_duration_ms: durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2,
      last_failure_reason: failures.at(-1)?.outcome ?? null,
      cooldown_until: cooldown && cooldown > now ? cooldown : null };
  });
}
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}
async function identity(pid: number) {
  const child = Bun.spawn(['ps', '-p', String(pid), '-o', 'lstart='], { stdout: 'pipe', stderr: 'ignore' });
  const result = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !result) throw new Error('process identity unavailable');
  return result;
}
async function commandOf(pid: number) {
  const child = Bun.spawn(['ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' });
  return (await new Response(child.stdout).text()).trim();
}
export function parseStatus(output: string): any {
  try { return JSON.parse(output); } catch {}
  const line = output.trim().split('\n').at(-1) ?? '';
  const match = line.match(/^[^:]*: (.*?)(?:, turns=(\d+) tools=(\d+) retries=(\d+) last=(\S+) ?(.*?) idle=(\d+)s|, no events yet|, events unreadable)$/);
  if (!match) throw new Error('unparseable status output');
  const raw = match[1];
  const state = raw.startsWith('dead') ? 'dead' : raw === 'pi exit 0' ? 'ok' : raw.startsWith('gave up') ? 'gaveup' : raw;
  const counted = match[2] !== undefined;
  return { state, detail: raw, turns: counted ? Number(match[2]) : 0, tools: counted ? Number(match[3]) : 0, retries: counted ? Number(match[4]) : 0,
    last_tool: counted && match[5] !== '-' ? match[5] : null, idle_s: counted ? Number(match[7]) : null };
}
export class Service {
  constructor(readonly config: Config) { mkdirSync(config.root, { recursive: true }); }
  async poolState(pool: string) {
    const now = Date.now();
    const limits = jsonFile(`${this.config.root}/limits.json`, {});
    const limit = limits[pool] ?? {};
    const base = limit.runs ?? 3;
    if (!Number.isInteger(base) || base < 1 || !Number.isInteger(limit.calls ?? 6) || (limit.calls ?? 6) < 1) throw new Error('invalid limits');
    const rows = readHistory(this.config.root).filter(row => poolOf(row.model) === pool).sort((a, b) => time(a.ts_end) - time(b.ts_end));
    let cap = base, clean = 0, learned_from: any = null;
    for (const row of rows.filter(row => time(row.ts_end) >= now - 86400_000)) {
      if (row.outcome === 'quota' && Number.isInteger(row.concurrency) && row.concurrency > 0) {
        cap = Math.min(cap, Math.max(1, row.concurrency - 1)); clean = 0; learned_from = row.ts_end;
      } else if (row.outcome === 'ok') {
        if (++clean === 10) { cap = Math.min(base, cap + 1); clean = 0; }
      } else clean = 0;
    }
    const aggregate = summarize(rows.map(row => ({ ...row, model: pool })), now)[0];
    const active = this.runs().filter(run => poolOf(run.model) === pool && this.isActive(run));
    return { pool, cap, call_cap: limit.calls ?? 6, in_flight: active.length,
      calls_in_flight: active.reduce((sum, run) => sum + (run.calls_in_flight ?? 1), 0),
      cooldown_until: aggregate?.cooldown_until ?? null, learned_from };
  }
  runs(): any[] { return jsonFile(`${this.config.root}/active.json`, []); }
  isActive(run: any): boolean {
    if (run.pid) return alive(run.pid);
    return !!run.launching && Date.now() - run.launched_at <= (this.config.launchGraceMs ?? 5000);
  }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.config.root}/start.lock`;
    const deadline = Date.now() + (this.config.lockWaitMs ?? 3000);
    for (;;) {
      try { mkdirSync(lock); break; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (this.lockIsStale(lock)) { rmSync(lock, { recursive: true, force: true }); continue; }
        if (Date.now() >= deadline) throw new Error('run registry locked; retry');
        await Bun.sleep(10);
      }
    }
    writeFileSync(`${lock}/owner`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  lockIsStale(lock: string): boolean {
    let owner: any;
    try { owner = JSON.parse(readFileSync(`${lock}/owner`, 'utf8')); }
    catch { try { return Date.now() - statSync(lock).mtimeMs > 2000; } catch { return true; } }
    return !alive(owner.pid) || Date.now() - owner.ts > (this.config.lockStaleMs ?? 60_000);
  }
  recordEnd(run: any, outcome: string, rc: number) {
    const rows = readHistory(this.config.root);
    if (rows.some(row => row.session === run.session && row.attempt === run.attempt)) return;
    appendFileSync(`${this.config.root}/runs.jsonl`, JSON.stringify({ ts_start: run.launched_at ?? Date.now(), ts_end: Date.now(), session: run.session, model: run.model,
      attempt: run.attempt, rc, outcome, turns: 0, tool_calls: 0, retries: 0, concurrency: run.concurrency, reconciled: true }) + '\n');
  }
  needsReconcile(): boolean {
    const history = readHistory(this.config.root);
    return this.runs().some(run => (run.launching && !this.isActive(run)) || (run.launching && run.descriptor && existsSync(`${run.descriptor}.pid`))
      || (run.pid && !alive(run.pid) && !history.some(row => row.session === run.session && row.attempt === run.attempt)));
  }
  async reconcile() {
    if (this.needsReconcile()) await this.withLock(() => this.reconcileLocked());
  }
  async reconcileLocked() {
    const runs = this.runs();
    let changed = false;
    for (const run of runs) {
      if (run.launching) {
        let pid = 0;
        try { pid = Number(readFileSync(`${run.descriptor}.pid`, 'utf8')); } catch {}
        if (pid && alive(pid) && (await commandOf(pid)).includes(run.descriptor)) {
          run.pid = pid; run.identity = await identity(pid); run.launching = false; changed = true;
        } else if (!this.isActive(run)) { run.launching = false; changed = true; this.recordEnd(run, 'nonzero', -1); }
      } else if (run.pid && !alive(run.pid)) this.recordEnd(run, 'killed', -1);
    }
    if (changed) this.saveRuns(runs);
  }
  saveRuns(runs: any[]) {
    const temporary = `${this.config.root}/active.${crypto.randomUUID()}.json`;
    writeFileSync(temporary, JSON.stringify(runs), { mode: 0o600 });
    renameSync(temporary, `${this.config.root}/active.json`);
  }
  async tokens(model: string) {
    if (!this.config.db) return null;
    const windows = readHistory(this.config.root).filter(row => row.model === model && time(row.ts_end) >= Date.now() - 7 * 86400_000);
    if (!windows.length) return null;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const ranges = windows.map(row => `(julianday(timestamp) >= julianday(${quote(new Date(time(row.ts_start)).toISOString())}) AND julianday(timestamp) <= julianday(${quote(new Date(time(row.ts_end)).toISOString())}))`).join(' OR ');
    try {
      accessSync(this.config.db, constants.R_OK);
      const child = Bun.spawn(['sqlite3', '-readonly', '-json', this.config.db, `SELECT coalesce(sum(promptTokens),0) AS prompt, coalesce(sum(completionTokens),0) AS completion FROM usageHistory WHERE model = ${quote(model)} AND (${ranges})`], { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(child.stdout).text();
      if (await child.exited !== 0) return null;
      return JSON.parse(output)[0] ?? null;
    } catch { return null; }
  }
  async models() {
    const response = await fetch(this.config.modelsUrl ?? 'http://127.0.0.1:20128/v1/models', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('model catalog unavailable');
    const catalog: any = await response.json();
    if (!Array.isArray(catalog.data) || catalog.data.some((row: any) => typeof row.id !== 'string')) throw new Error('invalid model catalog');
    let headroom: any[] = [];
    try {
      const command = Bun.spawn(this.config.headroom ?? ['model-headroom', '--json'], { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(command.stdout).text();
      if (await command.exited === 0) {
        const parsed = JSON.parse(output);
        headroom = Array.isArray(parsed) ? parsed : parsed.pools;
        if (!Array.isArray(headroom)) throw new Error('invalid headroom');
      }
    } catch { headroom = []; }
    const stats = await this.call('pi_history');
    return Promise.all(catalog.data.map(async ({ id }: any) => ({
      model: id, runs: 0, success_pct: null, quota_count: 0, median_duration_ms: null, last_failure_reason: null,
      ...stats.find((row: any) => row.model === id),
      status: 'UNKNOWN', percent_left: null, resets: null,
      ...headroom.find(row => row.pool === poolOf(id)),
      ...await this.poolState(poolOf(id)), tokens: await this.tokens(id),
    })));
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (name === 'pi_list') { await this.reconcile(); return { active: this.runs().filter(run => this.isActive(run)), recent: readHistory(this.config.root) }; }
    if (name === 'pi_resume' || name === 'pi_stop') {
      if (typeof args.session !== 'string') throw new Error('session required');
      await this.reconcile();
      const run = this.runs().find(row => row.session === args.session);
      if (!run) throw new Error('unknown session');
      if (name === 'pi_resume') return this.call('pi_start', run);
      if (run.pid === process.pid || !Number.isInteger(run.pid) || run.pid <= 1) throw new Error('unsafe pid');
      const kill = this.config.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));
      const current = alive(run.pid) ? await (this.config.identity ?? identity)(run.pid).catch(() => null) : null;
      if (current !== null || alive(run.pid)) {
        if (!run.identity || current !== run.identity) throw new Error('stale process identity');
        kill(-run.pid, 'SIGTERM');
        const deadline = Date.now() + (this.config.stopGraceMs ?? 3000);
        while (alive(run.pid) && Date.now() < deadline) await Bun.sleep(20);
        try { kill(-run.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      }
      const groupGone = () => { try { kill(-run.pid, 0); return false; } catch (error: any) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; return true; } };
      const groupDeadline = Date.now() + 1000;
      while (!groupGone() && Date.now() < groupDeadline) await Bun.sleep(10);
      if (!groupGone()) throw new Error('process group remains');
      const recorded = () => readHistory(this.config.root).some(row => row.session === run.session && row.attempt === run.attempt && row.outcome === 'killed');
      const historyDeadline = Date.now() + 300;
      while (!recorded() && Date.now() < historyDeadline) await Bun.sleep(10);
      if (!recorded()) this.recordEnd(run, 'killed', 137);
      return { stopped: true };
    }
    if (name === 'pi_start') {
      for (const key of ['worktree', 'session', 'model', 'brief_path']) {
        if (typeof args[key] !== 'string' || !args[key] || String(args[key]).includes('\0')) throw new Error(`invalid ${key}`);
      }
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(args.session))) throw new Error('invalid session');
      if (!statSync(String(args.worktree)).isDirectory()) throw new Error('invalid worktree');
      accessSync(String(args.brief_path), constants.R_OK);
      const models = await this.models();
      const target = models.find(row => row.model === args.model);
      if (!target) throw new Error('unknown model');
      return this.withLock(async () => {
        await this.reconcileLocked();
        const state = await this.poolState(target.pool);
        if (state.in_flight >= state.cap || state.calls_in_flight >= state.call_cap || state.cooldown_until) {
          const row = this.config.fallback ?? [];
          const index = row.indexOf(String(args.model));
          const candidates = index < 0 ? [] : row.slice(index + 1);
          const alternative = candidates.find(id => models.some(model => model.model === id && model.pool !== target.pool && !['LOW', 'EXHAUSTED', 'UNKNOWN'].includes(model.status) && !model.cooldown_until && model.in_flight < model.cap && model.calls_in_flight < model.call_cap));
          return { error: 'rate_limited', alternative: alternative ?? null, ...state };
        }
        if (this.runs().some(run => run.session === args.session && this.isActive(run))) throw new Error('session already active');
        const previous = this.runs().find(run => run.session === args.session);
        const attempt = (previous?.attempt ?? 0) + 1;
        const log = resolve(this.config.root, `${args.session}.${attempt}.log`);
        const descriptor = resolve(this.config.root, `${args.session}.${attempt}.json`);
        const run = { ...args, root: resolve(this.config.root), worktree: resolve(String(args.worktree)), brief_path: resolve(String(args.brief_path)), log, attempt, descriptor,
          status: this.config.status ?? ['pi-status.sh'], durable: this.config.durable ?? ['durable-pi.sh'], policy: this.config.policy, concurrency: state.in_flight + 1 };
        const others = this.runs().filter(row => row.session !== args.session);
        writeFileSync(descriptor, JSON.stringify(run), { mode: 0o600 });
        this.saveRuns([...others, { ...run, pid: null, launching: true, launched_at: Date.now() }]);
        const output = openSync(log, 'a', 0o600);
        let child;
        try {
          child = spawn(process.execPath, [resolve(import.meta.dir, 'worker.ts'), descriptor], { detached: true, stdio: ['ignore', output, output] });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        } catch (error) {
          this.saveRuns(previous ? [...others, previous] : others);
          throw error;
        } finally { closeSync(output); }
        child.unref();
        this.config.afterSpawn?.();
        const registered = this.runs().find(row => row.session === args.session);
        this.saveRuns([...others, { ...registered, pid: child.pid, identity: await (this.config.identity ?? identity)(child.pid!).catch(error => { if (alive(child.pid!)) throw error; return ''; }), launching: false }]);
        const warnings: string[] = [];
        if (['LOW', 'EXHAUSTED'].includes(target.status)) warnings.push(`pool ${target.status}`);
        if (target.success_pct !== null && 100 - target.success_pct > 30) warnings.push('7-day failure rate exceeds 30%');
        const limit = Date.now() + 3000;
        const acknowledged = `${descriptor}.started`;
        let settle: number | null = null;
        while (Date.now() < limit && (settle === null || Date.now() < settle) && alive(child.pid!)) {
          const ended = readHistory(this.config.root).find(row => row.session === args.session && row.attempt === attempt);
          if (ended) return { pid: child.pid, log, warnings, rc: ended.rc };
          if (settle === null && existsSync(acknowledged)) settle = Date.now() + 500;
          await Bun.sleep(10);
        }
        const finished = readHistory(this.config.root).find(row => row.session === args.session && row.attempt === attempt);
        if (finished) return { pid: child.pid, log, warnings, rc: finished.rc };
        return { pid: child.pid, log, warnings };
      });
    }
    if (name === 'pi_models') return this.models();
    if (name === 'pi_history') {
      await this.reconcile();
      const days = args.days ?? 7;
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) throw new Error('days must be positive');
      return summarize(readHistory(this.config.root).filter(row => time(row.ts_end) >= Date.now() - days * 86400_000 && (!args.model || row.model === args.model)));
    }
    if (name === 'pi_status') {
      await this.reconcile();
      const run = this.runs().find(row => args.session ? row.session === args.session : row.log === args.log);
      const log = args.log ?? run?.log;
      if (typeof log !== 'string' || !log || log.includes('\0')) throw new Error('log or known session required');
      const child = Bun.spawn([...(this.config.status ?? ['pi-status.sh']), log], { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(child.stdout).text();
      if (await child.exited) throw new Error('status script failed');
      const result = parseStatus(output);
      let finalState: string | null = null;
      try { finalState = readFileSync(`${log}.state`, 'utf8').trim() || null; } catch {}
      if (finalState) result.state = finalState;
      else if (run && !this.isActive(run) && !/=== pi exit \d+ ===/.test(readFileSync(log, 'utf8'))) result.state = 'dead';
      return result;
    }
    throw new Error('unknown tool');
  }
}
