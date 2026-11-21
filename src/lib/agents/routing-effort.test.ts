/**
 * Worker reasoning-effort routing. Two must-proves:
 *  1. PARITY — no requested effort ⇒ selectedEffort/requestedEffort are null and
 *     nothing else changes (the blast radius is zero unless effort is set).
 *  2. PER-RUNTIME — effort is honored only for runtimes with a reasoning-effort
 *     surface (codex/claude-code); antigravity/opencode → clean no-op (null).
 */

import { describe, it, expect } from 'vitest';

import { resolveWorkerRouting } from './routing';

describe('resolveWorkerRouting — effort parity (unset)', () => {
  it('no requested effort ⇒ both effort fields null, other fields unchanged', () => {
    const r = resolveWorkerRouting({});
    expect(r.requestedEffort).toBeNull();
    expect(r.selectedEffort).toBeNull();
    // Untouched: default codex selection, no model.
    expect(r.selectedRuntime).toBe('codex');
    expect(r.selectedModel).toBeNull();
    expect(r.modelDisposition).toBe('runtime-default');
  });

  it("'adaptive' retains the reset while the concrete selected effort stays null", () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'adaptive' });
    expect(r.requestedEffort).toBe('adaptive');
    expect(r.selectedEffort).toBeNull();
  });

  it('a bogus effort value ⇒ null (fails safe to runtime default)', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'turbo' });
    expect(r.selectedEffort).toBeNull();
  });
});

describe('resolveWorkerRouting — effort per-runtime', () => {
  it('keeps explicit remote placement and model without a local fallback', () => {
    expect(resolveWorkerRouting({ requestedRuntime: 'cloud', requestedModel: 'gpt-6-sol', requestedEffort: 'medium' }))
      .toMatchObject({ selectedRuntime: 'cloud', selectedModel: 'gpt-6-sol', selectedEffort: 'medium' });
  });
  it('codex honors the effort', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'high' });
    expect(r.selectedEffort).toBe('high');
    expect(r.requestedEffort).toBe('high');
  });

  it('default (no runtime) → codex → effort honored', () => {
    expect(resolveWorkerRouting({ requestedEffort: 'low' }).selectedEffort).toBe('low');
  });

  it('antigravity remains selected and treats effort as a clean no-op', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'antigravity', requestedEffort: 'high' });
    expect(r.selectedRuntime).toBe('antigravity');
    expect(r.selectedEffort).toBeNull();
    expect(r.requestedEffort).toBe('high');
  });

  it('opencode → no-op too', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'opencode', requestedEffort: 'max' });
    // opencode may fall back to codex if not dispatchable; either way effort is
    // only applied on an effort-capable runtime.
    expect(r.selectedEffort === null || (r.selectedRuntime === 'codex' && r.selectedEffort === 'max')).toBe(true);
  });
});

describe('resolveWorkerRouting — effort round-trip (persist → normalize)', () => {
  it('feeding requestedEffort back in re-derives the same selectedEffort', () => {
    const first = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'high' });
    // Simulate normalizeWorkerRouting: re-resolve from the persisted request.
    const restored = resolveWorkerRouting({
      requestedRuntime: first.requestedRuntime ?? undefined,
      requestedModel: first.requestedModel ?? undefined,
      requestedEffort: first.requestedEffort ?? undefined,
    });
    expect(restored.selectedEffort).toBe('high');
  });
});

describe('resolveWorkerRouting — model house', () => {
  it('rejects a Codex model for a selected Claude runtime', () => {
    const routing = resolveWorkerRouting({
      requestedRuntime: 'claude-code',
      requestedModel: 'gpt-5.6-sol',
    });
    expect(routing.selectedRuntime).toBe('claude-code');
    expect(routing.requestedModel).toBe('gpt-5.6-sol');
    expect(routing.selectedModel).toBeNull();
    expect(routing.modelDisposition).toBe('rejected-incompatible');
    expect(routing.reason).toContain('gpt-5.6-sol');
    expect(routing.reason).toContain('claude-code');
    expect(routing.reason).toContain('runtime default will be used');
  });

  it('honors a Claude model hint for a selected Claude runtime', () => {
    const routing = resolveWorkerRouting({
      requestedRuntime: 'claude-code',
      requestedModel: 'claude-opus-5',
    });
    expect(routing.selectedModel).toBe('claude-opus-5');
    expect(routing.modelDisposition).toBe('requested');
  });

  it('rejects a Claude model for a selected Codex runtime', () => {
    expect(resolveWorkerRouting({
      requestedRuntime: 'codex',
      requestedModel: 'claude-opus-5',
    }).selectedModel).toBeNull();
  });

  it('preserves provider-qualified models for model-agnostic runtimes', () => {
    const routing = resolveWorkerRouting({
      requestedRuntime: 'opencode',
      requestedModel: 'google/gemini-2.5-flash',
    });
    expect(routing.selectedModel).toBe('google/gemini-2.5-flash');
    expect(routing.modelDisposition).toBe('requested');
  });
});
