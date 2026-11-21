// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { composeComposerTurnMessage } from '../composer-mode';
import { prepareOrchestratorTurn } from '../use-orchestrator-stream/turn-option-resolution';
import {
  clampEffortToLead,
  composerSupportsFastMode,
  cycleComposerSelectorMode,
  defaultComposerMode,
  isHotComposerEffort,
  providerMarkForLead,
  providerMarkForRuntime,
  resolveEffectiveComposerLeadModelId,
  resolveComposerSelectorState,
  readComposerEffortMaps,
  setModelEffort,
  supportedEffortsForLead,
  type ComposerSelectorMode,
} from './state';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { MODEL_IDS } from '@/lib/models';

const MODES: ComposerSelectorMode[] = ['solo', 'multitask', 'fast', 'moa', 'fusion'];
const EFFORTS: ThinkingEffort[] = ['low', 'medium', 'adaptive', 'high', 'xhigh', 'max', 'ultra'];

describe('composer selector state', () => {
  beforeEach(() => localStorage.clear());

  it('preserves explicit model choices while retaining the fallback for absent choices', () => {
    expect(prepareOrchestratorTurn('fixture', { backend: 'acp', model: '' }).model).toBe('');
    expect(prepareOrchestratorTurn('fixture', { backend: 'acp', model: '  agent-model  ' }).model).toBe('agent-model');
    expect(prepareOrchestratorTurn('fixture', { backend: 'acp' }).model).toBe(MODEL_IDS.orchestratorDefault);
  });

  it('keeps mode, wire directive, execution mode, and effort in one resolved state', () => {
    for (const mode of MODES) {
      for (const effort of EFFORTS) {
        const resolved = resolveComposerSelectorState({
          mode,
          leadModelId: 'gpt-6-astra',
          leadModelLabel: 'Astra',
          leadBackend: 'codex',
          inSessionEffortByModel: { 'gpt-6-astra': effort },
          threadEffortByModel: {},
          operatorDefaultEffort: 'medium',
          adaptiveEnabled: true,
          ultraEnabled: true,
          workerRuntimeLabel: 'Codex',
          workerModelLabel: 'Sol',
        });
        const turn = composeComposerTurnMessage('Build it', resolved.mode, false);
        const route = prepareOrchestratorTurn(turn.wireMessage, {
          displayMessage: turn.displayMessage,
          wireMessage: turn.wireMessage,
          orchestrationMode: turn.orchestrationMode,
          thinkingEffort: resolved.effort,
        });

        expect(turn.orchestrationMode, mode).toBe(resolved.orchestrationMode);
        expect(turn.wireMessage, mode).toContain(resolved.modeDirective);
        expect(route.orchestrationMode, mode).toBe(resolved.orchestrationMode);
        expect(route.wireMessage, mode).toContain(resolved.modeDirective);
        const expected = effort === 'adaptive' ? 'high' : effort;
        expect(route.thinkingEffort, `${mode}:${effort}`).toBe(expected);
        expect(resolved.effort, `${mode}:${effort}`).toBe(expected);
        expect(resolved.effortOptions).not.toContain('adaptive');
      }
    }
  });

  it('restores each model effort across A to B to A', () => {
    let efforts = setModelEffort({}, 'model-a', 'high');
    efforts = setModelEffort(efforts, 'model-b', 'low');
    const resolve = (modelId: string) => resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: modelId,
      leadModelLabel: modelId,
      leadBackend: 'claude',
      inSessionEffortByModel: efforts,
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
    }).effort;

    expect(resolve('model-a')).toBe('high');
    expect(resolve('model-b')).toBe('low');
    expect(resolve('model-a')).toBe('high');
  });

  it('migrates the legacy effort once without consuming the classic key', () => {
    localStorage.setItem('o8:orchestrator:thinking-effort', 'high');
    expect(readComposerEffortMaps(null, 'model-a').global['model-a']).toBe('high');
    expect(localStorage.getItem('o8:orchestrator:thinking-effort')).toBe('high');

    localStorage.setItem('o8:orchestrator:thinking-effort', 'low');
    expect(readComposerEffortMaps(null, 'model-b').global['model-b']).toBeUndefined();
  });

  it('shows catalog-verified Terra max and ultra without a client-only predicate', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'gpt-5.6-terra',
      leadModelLabel: 'Terra',
      leadBackend: 'codex',
      inSessionEffortByModel: { 'gpt-5.6-terra': 'ultra' },
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
      adaptiveEnabled: true,
      ultraEnabled: true,
      workerRuntimeLabel: 'Codex',
    });

    expect(resolved.effort).toBe('ultra');
    expect(resolved.effortOptions).toContain('max');
    expect(resolved.effortOptions).toContain('ultra');
  });

  it('hides Ultra until enabled and clamps a stored Ultra effort to Max', () => {
    const hidden = supportedEffortsForLead('codex', 'gpt-6-astra', true, false);
    const shown = supportedEffortsForLead('codex', 'gpt-6-astra', true, true);

    expect(hidden).not.toContain('ultra');
    expect(shown).toContain('ultra');
    expect(clampEffortToLead('ultra', hidden)).toEqual({ effort: 'max', clampedFrom: 'ultra' });
  });

  it('treats Extra, Max, and Ultra as the hot effort band', () => {
    expect(['xhigh', 'max', 'ultra'].every((effort) => isHotComposerEffort(effort as ThinkingEffort))).toBe(true);
    expect(['low', 'medium', 'adaptive', 'high'].some((effort) => isHotComposerEffort(effort as ThinkingEffort))).toBe(false);
  });

  it('keeps o8 on Low with no effort options, ignoring a saved High', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'o8-free',
      leadModelLabel: 'o8',
      leadBackend: 'o8',
      inSessionEffortByModel: { 'o8-free': 'high' },
      threadEffortByModel: {},
      operatorDefaultEffort: 'max',
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
    });

    expect(resolved.effort).toBe('low');
    expect(resolved.effortOptions).toEqual([]);
    expect(resolved.lockedEffortOptions).toEqual([]);
    expect(resolved.atRestText).toBe('o8 / workers Codex');
  });

  it('defaults o8 to Low without a saved preference', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'o8-free',
      leadModelLabel: 'o8',
      leadBackend: 'o8',
      inSessionEffortByModel: {},
      threadEffortByModel: {},
      operatorDefaultEffort: 'high',
      adaptiveEnabled: true,
    });
    expect(resolved.effort).toBe('low');
    expect(resolved.effortClampedFrom).toBeNull();
    expect(resolved.lockedEffortOptions).toEqual([]);
  });

  it('offers the o8 lead no effort options', () => {
    expect(supportedEffortsForLead('o8', 'o8-free', true)).toEqual([]);
  });

  it('maps lead families and worker runtimes to provider marks', () => {
    expect(providerMarkForLead('codex', 'gpt-6-astra')).toBe('openai');
    expect(providerMarkForLead('codex', 'ollama:qwen:32b')).toBe('ollama');
    expect(providerMarkForLead('opencode', 'google/gemini-3-pro')).toBe('gemini');
    expect(providerMarkForRuntime('claude-code')).toBe('anthropic');
    expect(providerMarkForRuntime('antigravity')).toBe('antigravity');
    expect(providerMarkForRuntime('hermes')).toBe('terminal');
  });

  it('resolves in-session over thread over operator default', () => {
    const base = {
      mode: 'solo' as const,
      leadModelId: 'model-a',
      leadModelLabel: 'Model A',
      leadBackend: 'claude' as const,
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
      workerModelLabel: 'Sol',
    };

    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: { 'model-a': 'max' },
      threadEffortByModel: { 'model-a': 'high' },
      operatorDefaultEffort: 'medium',
    }).effort).toBe('max');
    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: {},
      threadEffortByModel: { 'model-a': 'high' },
      operatorDefaultEffort: 'medium',
    }).effort).toBe('high');
    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: {},
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
    }).effort).toBe('medium');
  });

  it.each([
    ['solo', 'Codex', 'Sol', 'single'],
    ['multitask', 'OpenCode', null, 'fleet'],
    ['fast', 'Codex', 'Sol', 'fleet'],
    ['moa', 'Codex', 'Sol', 'fleet'],
    ['fusion', 'Codex', null, 'fusion'],
  ] as const)('keeps resolved mode and worker fields coherent for %s', (mode, runtime, workerModel, execution) => {
    const resolved = resolveComposerSelectorState({
      mode,
      leadModelId: 'gpt-5.6-sol', leadModelLabel: 'Sol', leadBackend: 'codex',
      inSessionEffortByModel: {}, threadEffortByModel: {}, operatorDefaultEffort: 'high',
      adaptiveEnabled: true, workerRuntimeLabel: runtime, workerModelLabel: workerModel,
    });
    expect(resolved.modeLabel).toBe({ solo: 'Solo', multitask: 'Worktrees', fast: 'Shared', moa: 'Compare plans', fusion: 'Fusion' }[mode]);
    expect(resolved.orchestrationMode).toBe(execution);
    expect(resolved.workerRuntimeLabel).toBe(runtime);
    expect(resolved.workerModelLabel).toBe(workerModel);
  });

  it('offers Shared only for compatible leads and cycles the two checkout choices', () => {
    expect(composerSupportsFastMode('codex')).toBe(true);
    expect(composerSupportsFastMode('claude')).toBe(true);
    expect(composerSupportsFastMode('fable')).toBe(true);
    expect(composerSupportsFastMode('pi')).toBe(true);
    expect(composerSupportsFastMode('o8')).toBe(true);
    expect(composerSupportsFastMode('openclaw')).toBe(false);
    expect(cycleComposerSelectorMode('solo', 1, 'openclaw')).toBe('multitask');
    expect(cycleComposerSelectorMode('solo', 1, 'codex')).toBe('fast');
    expect(cycleComposerSelectorMode('fast', 1, 'codex')).toBe('multitask');
    expect(cycleComposerSelectorMode('multitask', 1, 'codex')).toBe('fast');
    expect(cycleComposerSelectorMode('fusion', 1, 'codex')).toBe('fast');
    const state = resolveComposerSelectorState({
      mode: 'fast', leadModelId: 'external', leadModelLabel: 'External', leadBackend: 'openclaw',
      inSessionEffortByModel: {}, threadEffortByModel: {}, operatorDefaultEffort: 'medium', adaptiveEnabled: false,
    });
    expect(state.mode).toBe('solo');
    expect(defaultComposerMode('codex')).toBe('fast');
    expect(defaultComposerMode('claude')).toBe('fast');
    expect(defaultComposerMode('acp')).toBe('solo');
  });

  it('resolves mode and worker settings by session, thread, then operator default', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'gpt-5.6-sol', leadModelLabel: 'Sol', leadBackend: 'codex',
      inSessionEffortByModel: {}, threadEffortByModel: {}, operatorDefaultEffort: 'high',
      adaptiveEnabled: true,
      inSessionSettings: { mode: 'fusion', workerRuntime: 'opencode' },
      threadSettings: { mode: 'moa', workerRuntime: 'antigravity', workerStartMode: 'huddle' },
      operatorDefaultSettings: {
        mode: 'multitask',
        workerRuntime: 'codex',
        workerModel: 'provider/default-model',
        workerStartMode: 'autonomous',
      },
    });
    expect(resolved.mode).toBe('fusion');
    expect(resolved.workerRuntime).toBe('opencode');
    expect(resolved.workerModel).toBe('provider/default-model');
    expect(resolved.workerModelLabel).toBe('default-model');
    expect(resolved.workerStartMode).toBe('huddle');
    expect(resolved.workerStartModeLabel).toBe('Plan');
  });

  it('matches the Codex backend fallback, including local dispatch defaults', () => {
    expect(resolveEffectiveComposerLeadModelId('codex', 'claude-opus-4-8', 'gpt-5.6-terra'))
      .toBe(MODEL_IDS.codexDefault);
    expect(resolveEffectiveComposerLeadModelId('codex', undefined, 'ollama:local-code:32b'))
      .toBe('ollama:local-code:32b');
    expect(resolveEffectiveComposerLeadModelId('codex', 'gpt-5.6-sol', 'ollama:local-code:32b'))
      .toBe('gpt-5.6-sol');
  });
});
