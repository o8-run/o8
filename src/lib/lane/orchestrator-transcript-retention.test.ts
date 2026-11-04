import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOrchestratorTurnRecord,
  finishOrchestratorTurn,
  listActiveOrchestratorTurns,
} from './orchestrator-crash-survival';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

describe('orchestrator transcript retention', () => {
  let root: string;
  const now = Date.UTC(2030, 0, 2);
  const cutoff = now - 24 * 60 * 60 * 1000;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'o8-orch-retention-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.rmSync).mockImplementation(actual.rmSync);
    vi.restoreAllMocks();
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

  it('sweeps expired transcripts with settled turns and keeps fresh files and live parents', () => {
    const expired = transcript('toolu_expired');
    const fresh = transcript('toolu_fresh', cutoff + 1_000);
    const boundary = transcript('toolu_boundary', cutoff);
    const liveStream = transcript('toolu_live_stream');
    const liveHistory = transcript('toolu_live_history');
    const live = createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'live-parent', repoPath: root,
      threadId: 'thoughts-live', pid: process.pid,
    });
    fs.writeFileSync(live.stdoutPath, `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: 'toolu_live_stream',
      message: { content: [{ type: 'text', text: 'Still working' }] },
    })}\n`);
    fs.mkdirSync(join(root, 'chat-history'));
    fs.writeFileSync(join(root, 'chat-history', 'thoughts-live.json'), JSON.stringify({
      messages: [{ role: 'assistant', toolCalls: [{ id: 'toolu_live_history', name: 'Agent', status: 'done' }] }],
    }));
    const settled = createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'settled-parent', repoPath: root,
      threadId: 'thoughts-settled', pid: 0,
    });
    finishOrchestratorTurn(settled);
    fs.writeFileSync(join(root, 'orchestrator-turns', `${settled.id}.json`), JSON.stringify({
      ...settled, settledAt: cutoff - 1_000, outcome: 'completed',
    }));
    fs.writeFileSync(settled.stdoutPath, `${JSON.stringify({ parent_tool_use_id: 'toolu_expired' })}\n`);
    const retained = [fresh, boundary, liveStream, liveHistory];
    const contents = retained.map(file => fs.readFileSync(file, 'utf8'));

    expect(listActiveOrchestratorTurns().map(turn => turn.id)).toEqual([live.id]);

    expect(fs.existsSync(expired)).toBe(false);
    expect(retained.map(file => fs.readFileSync(file, 'utf8'))).toEqual(contents);
    expect(fs.existsSync(settled.stdoutPath)).toBe(false);
    expect(fs.existsSync(live.stdoutPath)).toBe(true);

    finishOrchestratorTurn(live);
    expect(listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.existsSync(liveStream)).toBe(false);
    expect(fs.existsSync(liveHistory)).toBe(false);
  });

  it('sweeps expired transcripts even when no turn ledger exists', () => {
    const expired = transcript('toolu_orphan');
    const fresh = transcript('toolu_fresh', now);

    expect(listActiveOrchestratorTurns()).toEqual([]);

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

    expect(() => listActiveOrchestratorTurns()).not.toThrow();

    expect(fs.existsSync(blocked)).toBe(true);
    expect(fs.existsSync(expired)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolu_blocked.jsonl'), expect.any(Error));
  });

  it('tolerates a missing transcript directory', () => {
    expect(listActiveOrchestratorTurns()).toEqual([]);
    expect(fs.existsSync(join(root, 'subagent-transcripts'))).toBe(false);
  });

  it('protects a live parent tool call before its child output has been checkpointed', () => {
    const child = transcript('toolu_live');
    const expired = transcript('toolu_expired');
    const live = createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'live-parent', repoPath: root, pid: process.pid,
    });
    fs.writeFileSync(live.stdoutPath, `${JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_live', name: 'Agent' }] },
    })}\n{"partial":`);

    expect(listActiveOrchestratorTurns().map(turn => turn.id)).toEqual([live.id]);

    expect(fs.existsSync(child)).toBe(true);
    expect(fs.existsSync(expired)).toBe(false);
  });

  it('keeps transcripts when live parent ownership cannot be read', () => {
    const child = transcript('toolu_live');
    const live = createOrchestratorTurnRecord({
      backend: 'claude', sessionName: 'live-parent', repoPath: root,
      threadId: 'thoughts-live', pid: process.pid,
    });
    fs.mkdirSync(join(root, 'chat-history'));
    fs.writeFileSync(join(root, 'chat-history', 'thoughts-live.json'), '{unreadable history');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(listActiveOrchestratorTurns().map(turn => turn.id)).toEqual([live.id]);

    expect(fs.existsSync(child)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping subagent transcripts'), expect.any(Error));
  });
});
