import { describe, expect, it } from 'vitest';
import { formatModelLabel } from '@/lib/format';
import { MODEL_IDS } from '@/lib/models';
import { BRAIN_CODEX_MODEL_OPTIONS, ORCHESTRATOR_MODEL_OPTIONS } from './settings/dispatch-shared';
import { CLI_RUNTIME_MODELS } from './llm-chat/shared';
import { CLAUDE_CLI_MODELS, CODEX_CLI_MODELS } from './workspace-terminal/constants';
import { COMPOSER_MODEL_GROUPS } from './thoughts/ModelThinkingChip';
import { VOICE_BRAIN_MODELS } from './settings/voice-brain-models';
import { CLI_MODELS, API_MODELS, DEFAULT_MOBILE_CHAT_MODEL } from '@/app/mobile/mobile-approvals-shared';

/**
 * Three surfaces each keep a hand-written Claude model list. Until they are
 * generated from the registry, a new flagship has to be copied into all three
 * — and Opus 5 reached the composer and Settings but not the workspace CLI
 * picker, so a model already in the registry could not be selected (#1808).
 */
const CURRENT_CLAUDE_FLAGSHIPS = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  MODEL_IDS.raw.anthropicClaudeOpus5,
  MODEL_IDS.raw.anthropicClaudeSonnet5,
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
] as const;

const CURRENT_CODEX_FLAGSHIPS = [
  'gpt-6.1-sol',
  MODEL_IDS.raw.openAiGpt6Astra,
  MODEL_IDS.raw.openAiGpt6Sol,
  MODEL_IDS.raw.openAiGpt6Luna,
  MODEL_IDS.raw.openAiGpt56Sol,
] as const;

describe('Claude model picker coverage', () => {
  it('offers every current Claude flagship in Settings → Models', () => {
    const ids = ORCHESTRATOR_MODEL_OPTIONS.map((option) => option.value);
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) expect(ids).toContain(id);
  });

  it('offers every current Claude flagship in the workspace CLI picker', () => {
    const ids = CLAUDE_CLI_MODELS.map((option) => option.id);
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) expect(ids).toContain(id);
  });

  it('offers Sonnet 5.5 and Haiku 5.5 in the composer with real labels', () => {
    const claude = COMPOSER_MODEL_GROUPS.find((group) => group.key === 'claude')?.options ?? [];
    expect(claude).toContainEqual(expect.objectContaining({ value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', backend: 'claude', model: 'claude-sonnet-5-5' }));
    expect(claude).toContainEqual(expect.objectContaining({ value: 'claude-haiku-5-5', label: 'Haiku 5.5', backend: 'claude', model: 'claude-haiku-5-5' }));
  });

  it('has a real label for each of them, never the bare id', () => {
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) {
      const settingsOption = ORCHESTRATOR_MODEL_OPTIONS.find((option) => option.value === id);
      const workspaceOption = CLAUDE_CLI_MODELS.find((option) => option.id === id);
      expect(settingsOption?.label.trim()).toBeTruthy();
      expect(settingsOption?.label).not.toBe(id);
      expect(workspaceOption?.label.trim()).toBeTruthy();
      expect(workspaceOption?.label).not.toBe(id);
    }
  });
});

describe('Codex model picker coverage', () => {
  it('offers GPT-6.1 Sol in the composer, voice and mobile pickers with real labels', () => {
    expect(COMPOSER_MODEL_GROUPS.find((group) => group.key === 'codex')?.options)
      .toContainEqual(expect.objectContaining({ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }));
    expect(VOICE_BRAIN_MODELS.codex).toContainEqual({ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' });
    expect(CLI_MODELS).toContainEqual(expect.objectContaining({ id: 'cli:codex:gpt-6.1-sol', label: 'GPT-6.1 Sol' }));
    expect(API_MODELS).toContainEqual(expect.objectContaining({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }));
    expect(DEFAULT_MOBILE_CHAT_MODEL).toBe('cli:codex:gpt-6.1-sol');
  });
  it('offers current Codex models in settings and both CLI pickers', () => {
    const settingsIds = BRAIN_CODEX_MODEL_OPTIONS.map((option) => option.value);
    const workspaceIds = CODEX_CLI_MODELS.map((option) => option.id);
    const chatIds = CLI_RUNTIME_MODELS.codex.map((option) => option.id.replace('cli:codex:', ''));

    for (const id of CURRENT_CODEX_FLAGSHIPS) {
      expect(settingsIds).toContain(id);
      expect(workspaceIds).toContain(id);
      expect(chatIds).toContain(id);
    }
  });
});

it('formats current model IDs without dropping their minor versions', () => {
  expect(formatModelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
  expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  expect(formatModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  expect(formatModelLabel('anthropic/claude-sonnet-5-5')).toBe('Sonnet 5.5');
  expect(formatModelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
  expect(formatModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
  expect(formatModelLabel('gpt-6-sol')).toBe('GPT-6 Sol');
  expect(formatModelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
  expect(formatModelLabel('openai-codex/gpt-6.1-sol')).toBe('Codex GPT-6.1 Sol');
});

it('labels the built-in agent\'s receipt ids by whole id only', () => {
  expect(formatModelLabel('o8-free')).toBe('o8');
  expect(formatModelLabel('pi')).toBe('Pi');
  expect(formatModelLabel('o8-operator')).toBe('o8-operator');
  expect(formatModelLabel('pi-custom')).toBe('pi-custom');
});

it('advances only the Sol-class defaults', () => {
  expect(MODEL_IDS.codexCliDefault).toBe('gpt-6.1-sol');
  expect(MODEL_IDS.mobileOpenAiDefault).toBe('gpt-6.1-sol');
  expect(MODEL_IDS.mobileCliDefault).toBe('cli:codex:gpt-6.1-sol');
  expect(MODEL_IDS.codexDefault).toBe('gpt-6-astra');
  expect(MODEL_IDS.codexWorkerDefault).toBe('gpt-5.6-terra');
  expect(CLI_RUNTIME_MODELS.codex.find((option) => option.description === 'Everyday orchestrator')?.id)
    .toBe('cli:codex:gpt-6.1-sol');
});

it('preserves longer model variants before shorter ID replacements', () => {
  // Longer/more-specific IDs must win: flash-lite before flash; vendor-prefixed [1m] before bare fable-5.
  expect(formatModelLabel('gemini-2.5-flash-lite')).toBe('Gemini 2.5 Flash Lite');
  expect(formatModelLabel('anthropic/claude-fable-5[1m]')).toBe('Fable 5 (1M)');
  // Stable controls: shorter sibling and already-correct bare [1m] form.
  expect(formatModelLabel('gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
  expect(formatModelLabel('claude-fable-5[1m]')).toBe('Fable 5 (1M)');
});
