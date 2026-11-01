import { describe, it, expect } from 'vitest';

import { BRAIN_PROMPT_SECTION } from '@/lib/orchestrator/brain-access';
import { buildCodexOrchestratorPrompt, codexOrchestratorModelFlags } from './codex-orchestrator-session';

describe('codexOrchestratorModelFlags', () => {
  it('keeps a legacy cloud model selection verbatim', () => {
    // Explicit cloud selections must reach Codex unchanged.
    expect(codexOrchestratorModelFlags('gpt-5.5', 'xhigh')).toEqual([
      '-c',
      'model=gpt-5.5',
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
  });

  it('emits the gpt-5.6-sol flagship at max reasoning effort', () => {
    // The Sol-only `max` tier reaches the CLI as -c model_reasoning_effort=max.
    expect(codexOrchestratorModelFlags('gpt-5.6-sol', 'max')).toEqual([
      '-c',
      'model=gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=max',
    ]);
  });

  it('emits the gpt-5.6-sol ultra tier', () => {
    expect(codexOrchestratorModelFlags('gpt-5.6-sol', 'ultra')).toEqual([
      '-c',
      'model=gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=ultra',
    ]);
  });

  it('emits the gpt-6-astra ultra tier', () => {
    expect(codexOrchestratorModelFlags('gpt-6-astra', 'ultra')).toEqual([
      '-c',
      'model=gpt-6-astra',
      '-c',
      'model_reasoning_effort=ultra',
    ]);
  });

  it('expands an Ollama model to the --oss local form (no reasoning effort)', () => {
    expect(codexOrchestratorModelFlags('ollama:qwen2.5-coder:32b', 'xhigh')).toEqual([
      '--oss',
      '--local-provider',
      'ollama',
      '--model',
      'qwen2.5-coder:32b',
    ]);
  });

  it('expands an LM Studio model to the --oss local form', () => {
    expect(codexOrchestratorModelFlags('lmstudio:qwen2.5-coder', 'high')).toEqual([
      '--oss',
      '--local-provider',
      'lmstudio',
      '--model',
      'qwen2.5-coder',
    ]);
  });
});

describe('buildCodexOrchestratorPrompt', () => {
  it('assembles the real orchestrator prompt with the Brain-first section', () => {
    const prompt = buildCodexOrchestratorPrompt(
      '/tmp/o8-test-repo',
      'Review the latest packet.',
    );

    expect(prompt).toContain('You are the orchestrator for o8');
    expect(prompt).toContain('o8-test-repo');
    expect(prompt).toContain(BRAIN_PROMPT_SECTION);
    expect(prompt).toContain('## ENGINEERING BRAIN');
    expect(prompt).toContain('cortex_ask');
    expect(prompt).toContain('before grepping or re-reading broad files');
    expect(prompt).toContain('## USER MESSAGE\n\nReview the latest packet.');
  });
});

describe('resolveOrchestratorModelSync — cross-backend bleed guard', () => {
  it('falls through to the codex default when the explicit model is a Claude id', async () => {
    const { resolveOrchestratorModelSync } = await import('./codex-orchestrator-session');
    expect(resolveOrchestratorModelSync('claude-opus-4-8')).not.toMatch(/^claude/i);
    expect(resolveOrchestratorModelSync('Claude-Sonnet-5')).not.toMatch(/^claude/i);
  });

  it('keeps a genuine explicit codex model', async () => {
    const { resolveOrchestratorModelSync } = await import('./codex-orchestrator-session');
    expect(resolveOrchestratorModelSync('gpt-5.5-codex')).toBe('gpt-5.5-codex');
  });

  it('treats a saved runtime id as no model, not as a model named "codex" (#5199)', async () => {
    const { resolveOrchestratorModelSync } = await import('./codex-orchestrator-session');
    const fallback = resolveOrchestratorModelSync(undefined);
    expect(resolveOrchestratorModelSync('codex')).toBe(fallback);
    expect(resolveOrchestratorModelSync(' Codex ')).toBe(fallback);
    expect(resolveOrchestratorModelSync('claude-code')).toBe(fallback);
  });
});
