import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { transcriptTurns, transcriptTurnFiles } from './turns';

const entry = (id: string, role: MobileTranscriptEntry['role'], text = id): MobileTranscriptEntry => ({ id, role, text });
const sample = [entry('prompt', 'user'), entry('progress', 'assistant'), entry('tool', 'tool'), entry('answer', 'assistant')];

describe('transcript turns', () => {
  it('shows live work then folds only intermediate activity after completion', () => {
    expect(transcriptTurns(sample, true)[0].history).toEqual([]);
    expect(transcriptTurns(sample, false)[0]).toEqual({ start: 0, end: 4, final: 3, history: [1, 2] });
    const restored = deserializeStoredTranscript(serializeTranscriptForStorage(sample));
    expect(transcriptTurns(restored, false)[0].history).toEqual([1, 2]);
  });
  it('keeps errors, permissions and status events exposed, including incomplete turns', () => {
    const entries = [sample[0], { ...sample[1], isError: true }, { ...sample[2], role: 'system' as const }, sample[3]];
    expect(transcriptTurns(entries, false)[0].history).toEqual([]);
    expect(transcriptTurns(sample.slice(0, 3), false)[0].final).toBeNull();
    expect(transcriptTurns([sample[0], { ...sample[1], toolCalls: [{ name: 'exec', status: 'running' }] }, sample[3]], false)[0].history).toEqual([]);
    expect(transcriptTurns([{ ...sample[1], claudeCodeEvents: [{ type: 'permission_request' }] as MobileTranscriptEntry['claudeCodeEvents'] }, sample[3]], false)[0].history).toEqual([]);
  });
  it('keeps activity on the correct side of an exposed error', () => {
    const entries = [sample[0], sample[1], { ...sample[2], isError: true }, entry('recovery', 'assistant'), sample[3]];
    expect(transcriptTurns(entries, false)[0].history).toEqual([3]);
  });
  it('folds ordinary CLI events while preserving a later system message', () => {
    const progress = { ...sample[1], claudeCodeEvents: [{ type: 'thinking' as const, text: 'Inspecting' }] };
    expect(transcriptTurns([sample[0], progress, sample[3], entry('peer', 'system')], false)[0]).toEqual({ start: 0, end: 4, final: 2, history: [1] });
  });
  it('keeps earlier turns settled while a new turn streams and never hides a user interruption', () => {
    expect(transcriptTurns([...sample, entry('next', 'user'), entry('working', 'assistant')], true).map(turn => turn.history)).toEqual([[1, 2], []]);
    expect(transcriptTurns([sample[0], sample[1], entry('steering', 'user'), sample[3]], false)).toHaveLength(2);
  });
});

describe('turn file attribution', () => {
  it('deduplicates successful receipts without claiming failed or unrelated checkout changes', () => {
    const tool = { id: 'edit1', name: 'Edit', status: 'done' as const, args: { file_path: 'src/app.ts', old_string: 'before\n', new_string: 'after\nmore\n' } };
    const entries = [{ ...sample[1], toolCalls: [tool, tool, { ...tool, id: 'failure', status: 'error' as const, args: { ...tool.args, file_path: 'failed.ts' } }] }];
    expect(transcriptTurnFiles(entries)).toEqual([{ path: 'src/app.ts', added: 2, removed: 1 }]);
    expect(transcriptTurnFiles(sample)).toEqual([]);
  });
  it('keeps unknown counts unknown and recognizes patch paths', () => {
    expect(transcriptTurnFiles([{ ...sample[1], toolCalls: [
      { name: 'apply_patch', status: 'done', args: { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' } },
      { name: 'Write', status: 'done', args: { file_path: 'src/b.ts', content: 'hello' } },
    ] }])).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  });
});
