import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const boundary = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'o8-lead-thinking-'));
  return { root, resolve: vi.fn(), gateway: vi.fn(), profile: vi.fn(), publish: vi.fn() };
});

vi.mock('@/lib/lane/orchestrator-backends/openclaw-spawn-preflight', () => ({
  resolveOpenclawSpawnBinary: boundary.resolve,
}));
vi.mock('@/lib/lane/orchestrator-backends/openclaw-gateway', () => ({
  ensureOpenclawGateway: boundary.gateway,
}));
vi.mock('@/lib/lane/orchestrator-backends/openclaw-profile', () => ({
  prepareOpenclawProfile: boundary.profile,
  buildGovernedO8Profile: vi.fn(),
  OPENCLAW_O8_CONFIG: `${boundary.root}/profile.json`,
  OPENCLAW_SOURCE_CONFIG: `${boundary.root}/source.json`,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: boundary.publish }));

const { openclawBackend } = await import('@/lib/lane/orchestrator-backends/openclaw');
const executable = join(boundary.root, 'captured-lead');
writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ payloads: [{ text: 'fixture answer' }] }));
`);
chmodSync(executable, 0o755);
let sequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  boundary.resolve.mockResolvedValue(executable);
});
afterAll(() => rmSync(boundary.root, { recursive: true, force: true }));

async function turn(effort: unknown) {
  const repo = join(boundary.root, `repo-${++sequence}`);
  mkdirSync(repo);
  const events: OrchestratorEvent[] = [];
  await openclawBackend.sendTurn(repo, 'answer this', (event) => events.push(event), {
    thinkingEffort: effort as ThinkingEffort | undefined,
  });
  return { repo, events, capture: join(repo, 'argv.json') };
}

describe('lead thinking admission through the captured executable', () => {
  it.each(['ultra', 'unknown', '', null, 7, { effort: 'high' }])(
    'refuses unsupported explicit effort %j before setup or launch', async (effort) => {
      const { repo, events, capture } = await turn(effort);
      expect(events.find((event) => event.type === 'error')).toMatchObject({
        error: expect.stringContaining('Unsupported reasoning effort'),
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.some((event) => event.type === 'turn_receipt')).toBe(false);
      expect(existsSync(capture)).toBe(false);
      expect(boundary.resolve).not.toHaveBeenCalled();
      expect(boundary.profile).not.toHaveBeenCalled();
      expect(boundary.gateway).not.toHaveBeenCalled();
      expect(openclawBackend.peekSession(repo)).toBeNull();
    },
  );

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'adaptive'] as const)(
    'preserves supported effort %s in argv and the receipt', async (effort) => {
      const { events, capture } = await turn(effort);
      const args = JSON.parse(readFileSync(capture, 'utf8')) as string[];
      expect(args[args.indexOf('--thinking') + 1]).toBe(effort);
      expect(events.find((event) => event.type === 'turn_receipt')).toMatchObject({ effort });
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events).toContainEqual({ type: 'text', text: 'fixture answer' });
    },
  );

  it('retains the omitted runtime-default argument mapping', async () => {
    const { events, capture } = await turn(undefined);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).not.toContain('--thinking');
    expect(events.find((event) => event.type === 'turn_receipt')).toMatchObject({ effort: 'adaptive' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
