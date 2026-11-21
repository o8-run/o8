import { describe, expect, it } from 'vitest';
import { runtimeFromSessionKeyId } from './runtime-capabilities';

describe('runtimeFromSessionKeyId (#1749)', () => {
  it('reads the runtime out of an owned session key', () => {
    // Four live claude-code lanes rendered the composer's Codex default while
    // their session keys said exactly what was running.
    expect(runtimeFromSessionKeyId('claude-code-owned:abc123')).toBe('claude-code');
    expect(runtimeFromSessionKeyId('codex-owned:def456')).toBe('codex');
    expect(runtimeFromSessionKeyId('opencode-owned:ghi789')).toBe('opencode');
  });

  it('reads a discovered session key too', () => {
    expect(runtimeFromSessionKeyId('claude-code-discovered:abc')).toBe('claude-code');
    expect(runtimeFromSessionKeyId('codex-discovered:xyz')).toBe('codex');
  });

  it('reads a bare runtime prefix', () => {
    expect(runtimeFromSessionKeyId('claude-code:session-1')).toBe('claude-code');
    expect(runtimeFromSessionKeyId('opencode:session-2')).toBe('opencode');
  });

  it('returns null rather than guessing when the key names no known runtime', () => {
    expect(runtimeFromSessionKeyId('not-a-runtime-owned:abc')).toBeNull();
    expect(runtimeFromSessionKeyId('thoughts-1787358397405')).toBeNull();
    expect(runtimeFromSessionKeyId(':leading-colon')).toBeNull();
    expect(runtimeFromSessionKeyId('claude-code-owned:')).toBeNull();
    expect(runtimeFromSessionKeyId('codex:   ')).toBeNull();
    expect(runtimeFromSessionKeyId('')).toBeNull();
    expect(runtimeFromSessionKeyId(null)).toBeNull();
    expect(runtimeFromSessionKeyId(undefined)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(runtimeFromSessionKeyId('  claude-code-owned:abc  ')).toBe('claude-code');
  });
});
