/**
 * Targeting tier config — the pure resolution pieces (guard + coerce + merge).
 * The end-to-end env→file→fallback wiring rides the shared operator-defaults
 * recipe; here we prove the tier-specific logic.
 */

import { describe, it, expect } from 'vitest';

import {
  OPERATOR_DEFAULTS_FALLBACK,
  coerceStoredTier,
  isTargetingTier,
  mergeTier,
  type TargetingTier,
} from './defaults';

const FALLBACK: TargetingTier = { runtime: 'codex', model: '', effort: 'low' };

describe('targeting tier defaults', () => {
  it('ships codex triage @ low and codex action @ high', () => {
    expect(OPERATOR_DEFAULTS_FALLBACK.targetingTriage).toEqual({ runtime: 'codex', model: '', effort: 'low' });
    expect(OPERATOR_DEFAULTS_FALLBACK.targetingAction).toEqual({ runtime: 'codex', model: '', effort: 'high' });
  });
});

describe('isTargetingTier', () => {
  it('accepts a well-formed tier', () => {
    expect(isTargetingTier({ runtime: 'opencode', model: 'google/gemini-2.5-flash', effort: 'low' })).toBe(true);
    expect(isTargetingTier({ runtime: 'antigravity', model: 'flash', effort: 'low' })).toBe(true);
    expect(isTargetingTier({ runtime: 'codex', model: '', effort: 'max' })).toBe(true);
  });
  it('rejects bad runtime / missing model / bad effort / non-object', () => {
    expect(isTargetingTier({ runtime: 'nope', model: '', effort: 'low' })).toBe(false);
    expect(isTargetingTier({ runtime: 'codex', effort: 'low' })).toBe(false);
    expect(isTargetingTier({ runtime: 'codex', model: '', effort: 'turbo' })).toBe(false);
    expect(isTargetingTier(null)).toBe(false);
    expect(isTargetingTier('codex')).toBe(false);
  });
});

describe('coerceStoredTier', () => {
  it('fills missing/invalid subfields from fallback', () => {
    expect(coerceStoredTier({ effort: 'max' }, FALLBACK)).toEqual({ runtime: 'codex', model: '', effort: 'max' });
    expect(coerceStoredTier({ runtime: 'bogus', model: 'x', effort: 'high' }, FALLBACK)).toEqual({ runtime: 'codex', model: 'x', effort: 'high' });
  });
  it('returns undefined for a non-object (falls through to fallback upstream)', () => {
    expect(coerceStoredTier('codex', FALLBACK)).toBeUndefined();
    expect(coerceStoredTier(undefined, FALLBACK)).toBeUndefined();
  });
});

describe('mergeTier — env > file > fallback, per subfield', () => {
  it('env subfield wins; unset env subfields fall to file then fallback', () => {
    const file: TargetingTier = { runtime: 'antigravity', model: 'flash', effort: 'medium' };
    const merged = mergeTier({ effort: 'max' }, file, FALLBACK);
    expect(merged).toEqual({ runtime: 'antigravity', model: 'flash', effort: 'max' }); // effort from env, rest from file
  });
  it('no env, no file → fallback', () => {
    expect(mergeTier(null, undefined, FALLBACK)).toEqual(FALLBACK);
  });
  it('file over fallback when no env', () => {
    const file: TargetingTier = { runtime: 'opencode', model: 'm', effort: 'high' };
    expect(mergeTier(null, file, FALLBACK)).toEqual(file);
  });
});
