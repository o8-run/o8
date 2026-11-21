/**
 * "Workers use the Brain" resolution matrix (2026-06-11).
 *
 * Precedence: packet.useBrain override > operator mode > runtime tier (auto).
 * The tier table says codex/claude-code are frontier (stay lean by default),
 * gemini/opencode are standard (get the Brain in auto) — and future local
 * runtimes will declare tier 'local', which auto must treat as Brain-on.
 */

import { describe, expect, it } from 'vitest';

import { resolveBrainEnabledWith } from '@/lib/orchestrator/brain-access';

describe('resolveBrainEnabledWith', () => {
  it('per-packet override wins over every mode', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex', useBrain: true }, 'off')).toBe(true);
    expect(resolveBrainEnabledWith({ runtime: 'antigravity', useBrain: false }, 'all')).toBe(false);
  });

  it('mode all → every runtime gets the Brain', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'all')).toBe(true);
    expect(resolveBrainEnabledWith({ runtime: 'antigravity' }, 'all')).toBe(true);
  });

  it('mode off → no runtime gets the Brain', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'off')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'opencode' }, 'off')).toBe(false);
  });

  it('mode auto → frontier stays lean, non-frontier gets the Brain', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'auto')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'claude-code' }, 'auto')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'antigravity' }, 'auto')).toBe(true);
    expect(resolveBrainEnabledWith({ runtime: 'opencode' }, 'auto')).toBe(true);
  });

  it('mode auto + metered orchestrator (fable) → every runtime gets the Brain', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'auto', 'fable')).toBe(true);
    expect(resolveBrainEnabledWith({ runtime: 'claude-code' }, 'auto', 'fable')).toBe(true);
    expect(resolveBrainEnabledWith({ runtime: 'antigravity' }, 'auto', 'fable')).toBe(true);
  });

  it('subscription orchestrators do NOT flip auto — frontier stays lean', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'auto', 'codex')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'auto', 'claude')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'auto', 'collide')).toBe(false);
  });

  it('explicit override + explicit mode still beat the metered flip', () => {
    expect(resolveBrainEnabledWith({ runtime: 'codex', useBrain: false }, 'auto', 'fable')).toBe(false);
    expect(resolveBrainEnabledWith({ runtime: 'codex' }, 'off', 'fable')).toBe(false);
  });
});
