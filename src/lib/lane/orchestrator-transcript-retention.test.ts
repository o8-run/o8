import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), rmSync: vi.fn(actual.rmSync), statSync: vi.fn(actual.statSync) };
});

describe('orchestrator transcript retention', () => {
  let root: string;
  let turns: typeof import('./orchestrator-crash-survival');
  const now = Date.UTC(2030, 0, 2);
  const cutoff = now - 24 * 60 * 60 * 1000;
  const sweepInterval = 10 * 60 * 1000;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(join(tmpdir(), 'o8-orch-retention-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
    vi.useFakeTimers({ now });
    vi.clearAllMocks();
    turns = await import('./orchestrator-crash-survival');
  });

  afterEach(async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.rmSync).mockImplementation(actual.rmSync);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function transcript(id: string, mtime = cutoff - 1_000): string {
    const dir = join(root, 'subagent-transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{"type":"assistant","message":{"content":"Saved answer"}}\n');
    fs.utimesSync(file, mtime / 1_000, mtime / 1_000);
    return file;
  }

  it('sweeps expired transcripts with settled turns and keeps fresh files and the exact cutoff', () => {
    const expired = transcript('toolu_expired');
    const fresh = transcript('toolu_fresh', cutoff + 1_000);
    const boundary = transcript('toolu_boundary', cutoff);
    const settled = turns.createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'settled-parent', repoPath: root,
      threadId: 'thoughts-settled', pid: 0,
    });
    turns.finishOrchestratorTurn(settled);
    fs.writeFileSync(join(root, 'orchestrator-turns', `${settled.id}.json`), JSON.stringify({
      ...settled, settledAt: cutoff - 1_000, outcome: 'completed',
    }));
    fs.writeFileSync(settled.stdoutPath, `${JSON.stringify({ parent_tool_use_id: 'toolu_expired' })}\n`);
    const retained = [fresh, boundary];
    const contents = retained.map(file => fs.readFileSync(file, 'utf8'));

    expect(turns.listActiveOrchestratorTurns()).toEqual([]);

    expect(fs.existsSync(expired)).toBe(false);
    expect(retained.map(file => fs.readFileSync(file, 'utf8'))).toEqual(contents);
    expect(fs.existsSync(join(root, 'orchestrator-turns', `${settled.id}.json`))).toBe(false);
    expect(fs.existsSync(settled.stdoutPath)).toBe(false);
    expect(fs.existsSync(settled.stderrPath)).toBe(false);
  });

  it('throttles transcript sweeps for ten minutes without delaying settled-turn pruning', () => {
    const expired = transcript('toolu_expired');
    const fresh = transcript('toolu_fresh', now);
    expect(turns.listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(vi.mocked(fs.statSync).mock.calls.map(([file]) => file)).toEqual(expect.arrayContaining([expired, fresh]));
    expect(fs.statSync).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync).toHaveBeenCalledTimes(1);

    const nextExpired = transcript('toolu_next_expired');
    vi.clearAllMocks();
    vi.setSystemTime(now + sweepInterval - 1);

    expect(turns.listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.existsSync(nextExpired)).toBe(true);

    const settled = turns.createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'settled-parent', repoPath: root, pid: 0,
    });
    fs.writeFileSync(join(root, 'orchestrator-turns', `${settled.id}.json`), JSON.stringify({
      ...settled, settledAt: cutoff - 1_000, outcome: 'completed',
    }));
    expect(turns.listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.existsSync(settled.stdoutPath)).toBe(false);
    expect(fs.existsSync(nextExpired)).toBe(true);

    vi.clearAllMocks();
    vi.setSystemTime(now + sweepInterval);

    expect(turns.listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.statSync).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(nextExpired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('sweeps expired transcripts even when no turn ledger exists', () => {
    const expired = transcript('toolu_orphan');
    const fresh = transcript('toolu_fresh', now);

    expect(turns.listActiveOrchestratorTurns()).toEqual([]);

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('continues after one file cannot be removed and reports that failure', async () => {
    const blocked = transcript('toolu_blocked');
    const expired = transcript('toolu_expired');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rmSync: remove } = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.rmSync).mockImplementation((file, options) => {
      if (file === blocked) throw new Error('permission denied');
      remove(file, options);
    });

    expect(() => turns.listActiveOrchestratorTurns()).not.toThrow();

    expect(fs.existsSync(blocked)).toBe(true);
    expect(fs.existsSync(expired)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolu_blocked.jsonl'), expect.any(Error));
  });

  it('tolerates a missing transcript directory', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(turns.listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.existsSync(join(root, 'subagent-transcripts'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
