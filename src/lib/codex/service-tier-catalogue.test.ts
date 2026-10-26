import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const spawn = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn(async () => ({ mtimeMs: 1 })));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs/promises', () => ({ stat }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: '/fixture/codex', version: '1.0.0' }) }));
import { getCodexSpeedCatalogue, readCodexSpeedCatalogue } from './service-tier-catalogue';
class FakeServer extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); kill = vi.fn(() => true);
  requests: Array<{ id: number; method: string; params: unknown }> = [];
  constructor() { super(); this.stdin.on('data', (data) => { for (const line of String(data).trim().split('\n')) this.requests.push(JSON.parse(line)); }); }
  reply(id: number, result: unknown) { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
}
describe('read-only installed Codex service tiers', () => {
  let child: FakeServer;
  beforeEach(() => { child = new FakeServer(); spawn.mockReset().mockReturnValue(child); stat.mockClear(); });
  afterEach(() => { vi.unstubAllEnvs(); });
  function complete() { child.reply(1, {}); child.reply(3, { config: { service_tier: 'priority' } }); child.reply(2, { data: [{ model: 'test-model', serviceTiers: [{ id: 'priority', description: 'Faster' }, { id: 'ultrafast' }, { id: 'unknown' }] }] }); }
  it('reads a catalogue/config in either order, handles split frames and never starts a thread', async () => {
    const promise = readCodexSpeedCatalogue('/fixture/codex', { NODE_ENV: 'test' });
    child.stdout.write('null\nnoise\n{"id":1,'); child.stdout.write('"result":{}}\n');
    child.reply(3, { config: { service_tier: 'priority' } }); child.reply(2, { data: [{ model: 'test', additionalSpeedTiers: ['priority', 'ultrafast'] }] });
    expect(await promise).toMatchObject({ configuredTier: 'priority', models: { test: [{ id: 'default' }, { id: 'priority' }, { id: 'ultrafast' }] } });
    expect(child.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'model/list', 'config/read']); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0);
  });
  it('uses the same source home as orchestration instead of an unrelated CODEX_HOME', async () => {
    vi.stubEnv('CODEX_HOME', '/fixture/unrelated-account');
    const promise = getCodexSpeedCatalogue(); await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce()); complete(); await promise;
    expect(spawn.mock.calls[0][2].env.CODEX_HOME).toBe(path.join(homedir(), '.codex')); child.emit('exit', 0);
  });
  it('validates against the prepared launch home when supplied', async () => {
    const promise = getCodexSpeedCatalogue('/fixture/prepared-home'); await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce()); complete(); await promise;
    expect(spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/fixture/prepared-home'); child.emit('exit', 0);
  });
  it('bounds a stalled CLI and kills it without issuing any provider turn', async () => {
    const promise = readCodexSpeedCatalogue('/fixture/codex', { NODE_ENV: 'test' }, 10);
    await expect(promise).rejects.toThrow('timed out'); expect(child.kill).toHaveBeenCalledWith('SIGTERM'); child.emit('exit', 0);
  });
  it('rejects malformed model replies with a sanitized error', async () => {
    const promise = readCodexSpeedCatalogue('/fixture/codex', { NODE_ENV: 'test' }); child.reply(1, {}); child.reply(2, {});
    await expect(promise).rejects.toThrow('did not return a model catalogue'); child.emit('exit', 0);
  });
  it.each([true, false])('keeps the native default separate from configured model (config first: %s)', async configFirst => {
    const promise = readCodexSpeedCatalogue('/fixture/codex', { NODE_ENV: 'test' });
    child.reply(1, {});
    if (configFirst) child.reply(3, { config: { model: 'configured-high' } });
    child.reply(2, { data: [
      { model: 'native-low', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { model: 'configured-high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ] });
    if (!configFirst) child.reply(3, { config: { model: 'configured-high' } });
    expect(await promise).toMatchObject({ nativeDefaultModel: 'native-low', defaultModel: 'configured-high',
      reasoningEfforts: { 'native-low': ['low'], 'configured-high': ['high'] } });
    child.emit('exit', 0);
  });
});
