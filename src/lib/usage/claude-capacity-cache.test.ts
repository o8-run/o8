import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ jsonl: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const count = (path: unknown) => { if (String(path).endsWith('.jsonl')) reads.jsonl += 1; };
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      count(path);
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      count(path);
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof actual.openSync,
  };
});

const { readClaudeRuntimeCapacity } = await import('./cli-scrape');

const NOW_MS = Date.now();
const turn = (minutesAgo: number, input: number) => `${JSON.stringify({
  timestamp: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
  message: { usage: { input_tokens: input, output_tokens: 10 } },
})}\n`;

describe('Claude capacity read', () => {
  let projects = '';
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'o8-claude-capacity-'));
    vi.stubEnv('CLAUDE_HOME', home);
    projects = join(home, 'projects', 'repo');
    mkdirSync(projects, { recursive: true });
    for (let index = 0; index < 20; index += 1) writeFileSync(join(projects, `s-${index}.jsonl`), turn(30, 100));
    reads.jsonl = 0;
  });

  it('reads an unchanged transcript once across repeated capacity reads', () => {
    const first = readClaudeRuntimeCapacity(NOW_MS);
    expect(reads.jsonl).toBe(20);
    expect(readClaudeRuntimeCapacity(NOW_MS)).toEqual(first);
    expect(reads.jsonl).toBe(20);
  });

  it('rereads only the transcript that was written and counts its new turn', () => {
    const before = JSON.stringify(readClaudeRuntimeCapacity(NOW_MS).buckets);
    reads.jsonl = 0;
    appendFileSync(join(projects, 's-3.jsonl'), turn(5, 5_000));
    const after = readClaudeRuntimeCapacity(NOW_MS);
    expect(reads.jsonl).toBe(1);
    expect(JSON.stringify(after.buckets)).not.toBe(before);
  });
});
