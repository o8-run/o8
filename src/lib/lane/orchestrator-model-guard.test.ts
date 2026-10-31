import { describe, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import { ORCHESTRATOR_RUNTIMES, getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { modelBelongsToRuntime, resolveRuntimeOrchestratorModel, selectedOrchestratorModel } from './orchestrator-model-guard';

const CLAUDE_DEFAULT = MODEL_IDS.orchestratorDefault;

describe('modelBelongsToRuntime', () => {
  it('accepts each single-house runtime its own ids', () => {
    expect(modelBelongsToRuntime(MODEL_IDS.raw.openAiGpt56Sol, 'codex')).toBe(true);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.anthropicClaudeOpus5, 'claude-code')).toBe(true);
    expect(modelBelongsToRuntime('anthropic/claude-opus-5', 'claude-code')).toBe(true);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.gemini25Flash, 'gemini')).toBe(true);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.xaiGrok45, 'grok')).toBe(true);
  });

  it('refuses every cross-house pairing, not just the two that were reported', () => {
    // Both directions were patched one house at a time. With 18 dispatchable
    // runtimes that does not converge -- each new pairing is the same bug.
    expect(modelBelongsToRuntime(MODEL_IDS.raw.anthropicClaudeOpus5, 'codex')).toBe(false);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.openAiGpt56Sol, 'claude-code')).toBe(false);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.gemini25Flash, 'codex')).toBe(false);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.xaiGrok45, 'claude-code')).toBe(false);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.anthropicClaudeOpus5, 'gemini')).toBe(false);
    expect(modelBelongsToRuntime(MODEL_IDS.raw.openAiGpt56Terra, 'grok')).toBe(false);
  });

  it('does not guess for a runtime that fronts several providers', () => {
    // cursor and opencode legitimately run models from more than one house. A
    // wrong constraint would block a valid selection.
    for (const runtimeId of ['cursor', 'opencode'] as OrchestratorRuntime[]) {
      expect(getRuntimeCapability(runtimeId).modelIdPattern).toBeUndefined();
      expect(modelBelongsToRuntime(MODEL_IDS.raw.anthropicClaudeOpus5, runtimeId)).toBe(true);
      expect(modelBelongsToRuntime(MODEL_IDS.raw.openAiGpt56Sol, runtimeId)).toBe(true);
    }
  });

  it('accepts every runtime default under its own pattern', () => {
    // A registry row that constrains itself out of its own default is a bug in
    // the row, and this is the assertion that catches it when #19 is added.
    for (const id of Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[]) {
      const capability = getRuntimeCapability(id);
      if (!capability.modelIdPattern || !capability.defaultModel) continue;
      expect(
        modelBelongsToRuntime(capability.defaultModel, id),
        `${id} rejects its own defaultModel ${capability.defaultModel}`,
      ).toBe(true);
    }
  });

  it('treats an empty id as no model', () => {
    expect(modelBelongsToRuntime('', 'codex')).toBe(false);
    expect(modelBelongsToRuntime('   ', 'claude-code')).toBe(false);
  });
});

describe('resolveRuntimeOrchestratorModel (#1807)', () => {
  it('refuses the Codex dispatch model on a solo Claude turn', () => {
    // A fresh Orchestrator tab in solo mode on the Claude Code runtime launched
    // with gpt-5.6-sol -- default_dispatch_model, the Codex WORKER model.
    const onReject = vi.fn();
    expect(resolveRuntimeOrchestratorModel(MODEL_IDS.raw.openAiGpt56Sol, 'claude-code', CLAUDE_DEFAULT, onReject))
      .toBe(CLAUDE_DEFAULT);
    expect(onReject).toHaveBeenCalledWith(MODEL_IDS.raw.openAiGpt56Sol, CLAUDE_DEFAULT, 'claude-code');
  });

  it('passes a real selection through untouched', () => {
    const onReject = vi.fn();
    expect(resolveRuntimeOrchestratorModel(MODEL_IDS.raw.anthropicClaudeOpus5, 'claude-code', CLAUDE_DEFAULT, onReject))
      .toBe(MODEL_IDS.raw.anthropicClaudeOpus5);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('treats the runtime placeholder as no model, not a Claude id', () => {
    // Threads created without a lead saved the runtime id "claude-code" as their
    // model; it starts with "claude", so the CLI was handed --model claude-code
    // and every turn failed with "There's an issue with the selected model".
    expect(modelBelongsToRuntime('claude-code', 'claude-code')).toBe(false);
    const onReject = vi.fn();
    expect(resolveRuntimeOrchestratorModel('claude-code', 'claude-code', CLAUDE_DEFAULT, onReject)).toBe(CLAUDE_DEFAULT);
    // No selection is not a mismatch, and it is not an explicit model for an effort pin.
    expect(onReject).not.toHaveBeenCalled();
    expect(selectedOrchestratorModel(' claude-code ', 'claude-code')).toBeUndefined();
    expect(selectedOrchestratorModel('codex', 'codex')).toBeUndefined();
    expect(selectedOrchestratorModel(MODEL_IDS.raw.anthropicClaudeOpus5, 'claude-code')).toBe(MODEL_IDS.raw.anthropicClaudeOpus5);
  });

  it('falls back quietly when nothing was selected', () => {
    const onReject = vi.fn();
    expect(resolveRuntimeOrchestratorModel(undefined, 'claude-code', CLAUDE_DEFAULT, onReject)).toBe(CLAUDE_DEFAULT);
    expect(resolveRuntimeOrchestratorModel('  ', 'claude-code', CLAUDE_DEFAULT, onReject)).toBe(CLAUDE_DEFAULT);
    // An absent selection is not a mismatch, so it is not reported as one.
    expect(onReject).not.toHaveBeenCalled();
  });

  it('works without a reporter', () => {
    expect(resolveRuntimeOrchestratorModel(MODEL_IDS.raw.openAiGpt56Sol, 'claude-code', CLAUDE_DEFAULT))
      .toBe(CLAUDE_DEFAULT);
  });
});
