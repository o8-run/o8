import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';

const delayed = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const root = realpathSync(mkdtempSync(path.join(getDataDir(), 'o8-pi-warming-')));
const agentDir = path.join(root, 'agent');
const cwd = path.join(root, 'project');
const history = path.join(agentDir, 'sessions');
const source = path.join(history, 'saved.jsonl');
const binary = path.join(root, 'pi.mjs');
const receipt = path.join(root, 'calls.jsonl');
// Seed a non-allowlisted parent name so each real provider launch proves it is dropped.
const env = { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: history, O8_PI_BIN: binary,
  O8_OWNED_PI_ROOT: path.join(root, 'owned'), O8_OWNED_PI_ARCHIVE_ROOT: path.join(root, 'archive'), PI_WARM_FIXTURE_ROOT: root };
const prior = new Map(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
for (const dir of [cwd, history]) mkdirSync(dir, { recursive: true });
const usage = (cost: number) => ({ input: 10, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 16,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const header = { type: 'session', version: 3, id: 'fixture-session', timestamp: new Date().toISOString(), cwd };
// A copied history entry can have a future timestamp. Byte boundaries, rather
// than timestamp guessing, must prevent it from being charged to the new run.
const original = [header, { type: 'usage', id: 'old-warm', parentId: null,
  timestamp: '2099-01-01T00:00:00.000Z', kind: 'cache_warm', provider: 'fixture', model: 'fixture-model', usage: usage(99) }]
  .map(entry => JSON.stringify(entry)).join('\n') + '\n';
writeFileSync(source, original);
// Provider children only inherit allowlisted names (#4585); embed fixture plumbing.
writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('pi 1.1.0'); process.exit(0); }
const root = ${JSON.stringify(root)};
const file = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : path.join(root, 'fresh-' + process.pid + '.jsonl');
appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ argv, file, pid: process.pid, fixtureRootEnv: process.env.PI_WARM_FIXTURE_ROOT ?? null }) + '\\n');
const usage = cost => ({ input: 10, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 16, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') console.log(JSON.stringify({ type: 'response', command: 'get_state', data: { sessionId: 'fixture-session', sessionFile: file } }));
  if (command.type === 'prompt' || command.type === 'follow_up') {
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: 'session', id: 'fixture-session', cwd: process.cwd() }) + '\\n');
    const add = entry => appendFileSync(file, JSON.stringify({ id: process.pid + '-' + Math.random(), parentId: null, timestamp: new Date().toISOString(), ...entry }) + '\\n');
    add({ type: 'message', message: { role: 'assistant', usage: usage(0.75) } });
    add({ type: 'usage', kind: 'other', usage: usage(8) });
    if (command.message !== 'cold') {
      add({ type: 'usage', kind: 'cache_warm', provider: 'fixture', model: 'fixture-model', usage: usage(0.002) });
      add({ type: 'usage', kind: 'cache_warm', provider: 'fixture', model: 'fixture-model', usage: command.message === 'unknown' ? {} : usage(0.003) });
    }
    console.log(JSON.stringify({ type: 'response', command: 'get_session_stats', data: { tokens: { input: 10, output: 1 }, cost: command.message === 'cold' ? 0.75 : 0.755 } }));
    console.log(JSON.stringify({ type: 'agent_end' }));
    if (command.message === 'late') {
      const timer = setInterval(() => {
        if (!existsSync(path.join(root, 'read-started'))) return;
        clearInterval(timer);
        add({ type: 'usage', kind: 'cache_warm', usage: usage(7) });
        writeFileSync(path.join(root, 'late-written'), 'ready');
        setTimeout(() => process.exit(0), 100);
      }, 10);
    } else setTimeout(() => process.exit(0), 100);
  }
});
`);
chmodSync(binary, 0o755);
const { piRuntime } = await import('@/lib/runtimes/pi');
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
const { GET } = await import('@/app/api/runtime/transcript/route');
invalidateCliCache('pi');
const keys: string[] = [];
interface Call { argv: string[]; file: string; pid: number; fixtureRootEnv: string | null }
const calls = (): Call[] => existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
async function settled(count: number) {
  await vi.waitFor(() => expect(calls()).toHaveLength(count));
  expect(process.env.PI_WARM_FIXTURE_ROOT).toBe(root);
  expect(calls()[count - 1].fixtureRootEnv).toBeNull();
  await vi.waitFor(() => expect(() => process.kill(calls()[count - 1].pid, 0)).toThrow());
}
afterAll(async () => {
  for (const key of keys) await piRuntime.interrupt(key).catch(() => undefined);
  for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  invalidateCliCache('pi'); rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('user Pi cache warming through runtime entry points', () => {
  it('shows recorded warming separately in a launched run receipt and the transcript API', async () => {
    const count = calls().length + 1;
    const result = await piRuntime.launch({ cwd, prompt: 'warm' });
    expect(result.ok).toBe(true); keys.push(result.sessionKey!); await settled(count);
    const entries = await piRuntime.readTranscript(result.sessionKey!);
    expect(entries.filter(entry => entry.text.includes('Cache warming'))).toMatchObject([
      { role: 'system', text: 'Cache warming: 2 refreshes · $0.0050' },
    ]);
    expect(await piRuntime.getTelemetry!(result.sessionKey!)).toMatchObject({ estimatedCostUsd: 0.75 });
    const response = await GET(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${encodeURIComponent(result.sessionKey!)}`));
    expect(response.status).toBe(200);
    expect((await response.json()).transcript).toContainEqual(expect.objectContaining({ text: 'Cache warming: 2 refreshes · $0.0050' }));
  });

  it('attributes only newly appended usage in a private resume copy and keeps each follow-up separate', async () => {
    const count = calls().length + 1;
    const result = await piRuntime.resume(`pi:${source}`, 'warm');
    expect(result.ok).toBe(true); keys.push(result.sessionKey!); await settled(count);
    const copy = calls()[count - 1].file;
    expect(copy).not.toBe(source);
    expect(readFileSync(source, 'utf8')).toBe(original);
    expect(copy.startsWith(env.O8_OWNED_PI_ROOT + path.sep)).toBe(true);
    expect((await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming')))
      .toMatchObject([{ text: 'Cache warming: 2 refreshes · $0.0050' }]);
    const metadata = path.join(path.dirname(copy), 'session.json');
    const persisted = JSON.parse(readFileSync(metadata, 'utf8'));
    expect(persisted.recentRuns[0].usage).toMatchObject({ startByte: Buffer.byteLength(original), cacheWarming: { refreshes: 2, costUsd: 0.005 } });
    appendFileSync(copy, JSON.stringify({ type: 'usage', kind: 'cache_warm', id: 'between-runs', timestamp: new Date().toISOString(), usage: usage(7) }) + '\n');
    expect((await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming')))
      .toMatchObject([{ text: 'Cache warming: 2 refreshes · $0.0050' }]);
    await piRuntime.resume(result.sessionKey!, 'warm'); await settled(count + 1);
    const twice = (await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming'));
    expect(twice.map(entry => entry.text)).toEqual(['Cache warming: 2 refreshes · $0.0050', 'Cache warming: 2 refreshes · $0.0050']);
    expect(new Set(twice.map(entry => entry.id)).size).toBe(2);
    expect((await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming'))).toEqual(twice);
    expect(readFileSync(source, 'utf8')).toBe(original);
  });

  it('reports missing provider cost explicitly instead of inventing a zero total', async () => {
    const count = calls().length + 1;
    const result = await piRuntime.launch({ cwd, prompt: 'unknown' });
    expect(result.ok).toBe(true); keys.push(result.sessionKey!); await settled(count);
    expect((await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming')))
      .toMatchObject([{ text: 'Cache warming: 2 refreshes · cost unavailable' }]);
    expect(await piRuntime.getTelemetry!(result.sessionKey!)).toMatchObject({ estimatedCostUsd: 0.75 });
  });

  it('freezes the completion boundary before a delayed read can include idle warming', async () => {
    const count = calls().length + 1;
    const originalOpen = vi.mocked(fs.open).getMockImplementation()!;
    delayed.enabled = true;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (delayed.enabled && String(args[0]).includes('fresh-')) {
        writeFileSync(path.join(root, 'read-started'), 'ready');
        await vi.waitFor(() => expect(existsSync(path.join(root, 'late-written'))).toBe(true));
      }
      return originalOpen(...args);
    });
    try {
      const result = await piRuntime.launch({ cwd, prompt: 'late' });
      expect(result.ok).toBe(true); keys.push(result.sessionKey!); await settled(count);
      expect(readFileSync(calls()[count - 1].file, 'utf8')).toContain('"total":7');
      expect((await piRuntime.readTranscript(result.sessionKey!)).filter(entry => entry.text.includes('Cache warming')))
        .toMatchObject([{ text: 'Cache warming: 2 refreshes · $0.0050' }]);
    } finally { delayed.enabled = false; vi.mocked(fs.open).mockImplementation(originalOpen); }
  });

  it('shows no warming line when the run has no refreshes', async () => {
    const count = calls().length + 1;
    const result = await piRuntime.launch({ cwd, prompt: 'cold' });
    expect(result.ok).toBe(true); keys.push(result.sessionKey!); await settled(count);
    expect((await piRuntime.readTranscript(result.sessionKey!)).some(entry => entry.text.includes('Cache warming'))).toBe(false);
  });
});
