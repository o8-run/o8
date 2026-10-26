import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { resolveTurnReceiptMode } from '@/lib/lane/orchestrator-send-entry';
import { buildTurnSummaryStats, TurnSummaryCard } from './TurnSummaryCard';
import { parseTerminalTurnReceipt } from '../use-orchestrator-stream/terminal-receipt';

describe('TurnSummaryCard', () => {
  it('keeps default and service-tier provenance through receipt parsing and transcript reload', () => {
    for (const source of ['runtime-default', 'service-tier'] as const) {
      const receipt = parseTerminalTurnReceipt({ leadModel: source === 'service-tier' ? 'o8-next' : 'pi',
        effort: source === 'service-tier' ? 'low' : 'adaptive', effortSource: source, mode: 'solo' });
      expect(receipt).toMatchObject({ effortSource: source });
      const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
        id: source, role: 'assistant', text: 'Complete.', receipt,
      }]));
      expect(persistedEntry.receipt).toMatchObject({ effortSource: source });
      const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));
      expect(html).toContain(source === 'service-tier' ? 'low service tier' : 'runtime default');
      expect(html).not.toContain('medium');
    }
  });
  it('keeps the outside-workspace grant visible after receipt parsing and transcript reload', () => {
    const receipt = parseTerminalTurnReceipt({ leadModel: 'pi', effort: 'medium', mode: 'solo', permissionMode: 'outside-workspace' });
    expect(receipt?.permissionMode).toBe('outside-workspace');
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'outside-receipt', role: 'assistant', text: 'Complete.', receipt,
    }]));
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));
    expect(html).toContain('Outside workspace');
  });
  it('keeps Shared in the persisted receipt instead of reporting a fleet-engine mode change', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'shared-return', role: 'assistant', text: 'Worker returned.',
      receipt: { leadModel: 'o8-free', effort: 'low', pickedMode: 'fast',
        mode: resolveTurnReceiptMode('o8', 'fleet', 'fast') },
    }]));
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));
    expect(html).toContain('o8 · Shared');
    expect(html).not.toContain('ran as');
  });
  it('shows billable cost separately from parent context tokens', () => {
    const summary = {
        assistantMessageId: 'assistant-one',
        elapsedMs: 1_500,
        toolCount: 1,
        toolNames: ['dispatch'],
        toolNameTotal: 1,
        filesEditedCount: 0,
        filePaths: [],
        tokensUsed: 410,
        freshInputTokens: 203,
        cacheReadTokens: 40_448,
        cacheWriteTokens: 0,
        costUsd: 0.0045,
        missionFunnel: {
          totalDurationMs: 62_000,
          terminalPacketCount: 1,
          packetCount: 1,
          attemptCount: 2,
          retryCount: 1,
          interventionCount: 1,
          recoveryEventCount: 0,
          strictAutonomousCloseCount: 0,
          governedAutonomousCloseCount: 0,
        },
        repoPath: '/repo',
    };
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { summary }));

    expect(html).toContain('$0.0045');
    expect(buildTurnSummaryStats(summary).map((stat) => stat.value)).toEqual(expect.arrayContaining([
      '2 attempts · 1 retry',
      '1 interventions · 0 recoveries',
      '1/1 terminal',
      '99.5% prompt cached',
    ]));
    expect(html).not.toContain('50,000');
  });

  it('labels a reported first turn as a cold prompt without hiding its usage', () => {
    const stats = buildTurnSummaryStats({
      assistantMessageId: 'assistant-cold',
      elapsedMs: 5_000,
      toolCount: 0,
      toolNames: [],
      toolNameTotal: 0,
      filesEditedCount: 0,
      filePaths: [],
      tokensUsed: 40_635,
      freshInputTokens: 40_624,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      repoPath: '/repo',
    });
    expect(stats).toContainEqual({ key: 'cache', value: 'cold prompt' });
  });

  it('renders effective receipt labels and workers from a persisted entry after reload', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-receipt',
      role: 'assistant',
      text: 'Complete.',
      receipt: {
        leadModel: 'gpt-6-astra',
        effort: 'xhigh',
        mode: 'fusion',
        pickedMode: 'solo',
        workers: [{ packetId: 'packet-1', runtime: 'codex', model: 'gpt-5.6-terra' }],
      },
    }]));
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));

    expect(html).toContain('GPT-6 Astra');
    expect(html).toContain('extra');
    expect(html).toContain('ran as Fusion, picked Solo');
    expect(html).toContain('Codex · GPT-5.6 Terra');
  });

  it('leaves the effort out of an o8 lead receipt, which has one setting (#3660)', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-o8',
      role: 'assistant',
      text: 'Done.',
      receipt: { leadModel: 'o8-free', effort: 'low', mode: 'solo' },
    }]));
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));

    expect(html).toContain('o8 · Solo');
    expect(html).not.toMatch(/\bLow\b|\blow\b/);
  });

  it('renders no receipt line and does not crash for a legacy persisted entry', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-legacy',
      role: 'assistant',
      text: 'Legacy turn.',
    }]));

    expect(renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }))).toBe('');
  });
});
