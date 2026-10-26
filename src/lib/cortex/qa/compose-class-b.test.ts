import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TypedRow } from '@/lib/cortex/qa/types';

vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({ callCodex: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({ callOpenRouter: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ callSonnet: vi.fn() }));
vi.mock('@/lib/cortex/qa/compose-class-a', () => ({
  composeClassA: vi.fn(),
  limitCitationMarkers: (answer: string) => answer,
}));
vi.mock('@/lib/cortex/qa/contradictions', () => ({ detectContradictions: vi.fn(async () => []) }));
vi.mock('@/lib/cortex/qa/brain-quota-alert', () => ({
  flushBrainQuotaAlerts: vi.fn(),
  noteBrainQuotaError: vi.fn(),
}));
vi.mock('@/lib/operator/brain-routing', () => ({
  resolveBrainUseClaudeCliSync: vi.fn(),
  resolveBrainUseCodexCliSync: vi.fn(),
  usesManagedBrainInferenceSync: vi.fn(),
}));
vi.mock('@/lib/operator/role-routing-ledger', () => ({ recordRoleRoutingReceiptSafely: vi.fn() }));

import { KnowledgeSourcesChangedError } from '@/lib/cortex/knowledge/answer-validity';
import { composeClassA } from '@/lib/cortex/qa/compose-class-a';
import { composeClassB } from '@/lib/cortex/qa/compose-class-b';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { resolveBrainUseClaudeCliSync, resolveBrainUseCodexCliSync, usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';

const row: TypedRow = {
  citation: {
    kind: 'directive',
    rowId: 'subscription-routing',
    table: 'directives',
    excerpt: 'Use the available subscription.',
  },
  fields: {
    title: 'Subscription routing',
    body: 'Use the available subscription.',
  },
};

function collectEvents() {
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    emit: (name: string, payload: unknown) => events.push({ name, payload }),
  };
}

async function* tokens(text: string) {
  yield text;
}

describe('Class B Brain subscription routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(false);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(true);
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(false);
    vi.mocked(callCodex).mockResolvedValue('Codex answer. [D-subscription-routing]');
  });

  it('uses Codex directly for a Codex-only subscription', async () => {
    const { events, emit } = collectEvents();

    await composeClassB('How is this routed?', '/repo/o8', [row], emit, { terse: true });

    expect(callSonnet).not.toHaveBeenCalled();
    expect(callCodex).toHaveBeenCalledOnce();
    expect(callCodex).toHaveBeenCalledWith(expect.any(String), { timeoutMs: 300_000 });
    expect(events.find((event) => event.name === 'token')?.payload).toEqual({
      text: 'Codex answer. [CITATION:directive-subscription-routing]',
    });
  });

  it('falls sideways to Codex when a stale both-profile returns a disabled Claude subscription message', async () => {
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(true);
    vi.mocked(callSonnet).mockResolvedValue({
      tier: 'cli',
      tokens: tokens('Your organization has disabled Claude subscription access for Claude Code.'),
    });
    const { events, emit } = collectEvents();

    await composeClassB('How is this routed?', '/repo/o8', [row], emit, { terse: true });

    expect(callSonnet).toHaveBeenCalledOnce();
    expect(callCodex).toHaveBeenCalledOnce();
    const answer = events.find((event) => event.name === 'token')?.payload as { text: string };
    expect(answer.text).toContain('Codex answer.');
    expect(answer.text).not.toContain('disabled Claude subscription');
  });

  it('receipts a managed Class B answer and never launches a CLI', async () => {
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(true);
    vi.mocked(callOpenRouter).mockResolvedValue('Managed answer. [D-subscription-routing]');
    const { events, emit } = collectEvents();

    await composeClassB('How is this routed?', '/repo/o8', [row], emit, { terse: true });

    expect(callCodex).not.toHaveBeenCalled();
    expect(callSonnet).not.toHaveBeenCalled();
    expect(recordRoleRoutingReceiptSafely).toHaveBeenCalledWith(expect.objectContaining({
      role: 'brain',
      effective: expect.objectContaining({ backend: 'managed-inference' }),
    }));
    expect(events.find((event) => event.name === 'token')?.payload).toEqual({
      text: 'Managed answer. [CITATION:directive-subscription-routing]',
    });
  });
  it.each(['codex', 'sonnet', 'eval'])('never starts a fallback after knowledge revocation in the %s composer', async tier => {
    const refusal = new KnowledgeSourcesChangedError();
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(tier !== 'codex');
    const result = { tier: 'cli' as const, text: 'An answer. [D-subscription-routing]', tokens: tokens('An answer. [D-subscription-routing]') };
    vi.mocked(callSonnet).mockResolvedValue(result);
    vi.stubEnv('O8_EVAL_MODE', tier === 'eval' ? '1' : '0');
    try {
      await expect(composeClassB('How is this routed?', '/repo/o8', [row], () => { throw refusal; }, { terse: true })).rejects.toBe(refusal);
      expect(composeClassA).not.toHaveBeenCalled();
      expect(callCodex).toHaveBeenCalledTimes(tier === 'codex' ? 1 : 0);
      expect(callSonnet).toHaveBeenCalledTimes(tier === 'codex' ? 0 : 1);
    } finally { vi.unstubAllEnvs(); }
  });

});
