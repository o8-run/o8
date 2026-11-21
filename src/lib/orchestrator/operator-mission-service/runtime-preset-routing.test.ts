import { describe, expect, it } from 'vitest';

import { resolveRuntimePreset } from '@/lib/orchestrator/runtime-capabilities';
import { resolveRuntimePresetModel } from './runtime-preset-routing';

describe('resolveRuntimePresetModel', () => {
  it('returns the preset model for a runtime the preset knows', () => {
    expect(resolveRuntimePresetModel('ui-edit-low-latency', 'codex', 'operator/model', undefined))
      .toBe(resolveRuntimePreset('ui-edit-low-latency', 'codex')!.model);
  });

  it('keeps the operator model for a runtime without a preset entry', () => {
    expect(resolveRuntimePresetModel('ui-edit-low-latency', 'antigravity', 'operator/model', undefined))
      .toBe('operator/model');
  });

  it('returns the fallback untouched when no preset is armed', () => {
    expect(resolveRuntimePresetModel(undefined, 'antigravity', 'operator/model', undefined))
      .toBe('operator/model');
  });

  it('yields model ownership to a claude-code carrier', () => {
    expect(resolveRuntimePresetModel('ui-edit-low-latency', 'claude-code', 'operator/model', { on: true }))
      .toBeNull();
  });
});
