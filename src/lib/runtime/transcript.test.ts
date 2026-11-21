import { describe, expect, it } from 'vitest';

import { runtimeIdFromSessionKey } from './transcript';

describe('runtimeIdFromSessionKey', () => {
  it.each([
    ['codex:thread-1', 'codex'],
    ['codex-owned:surface-1', 'codex'],
    ['codex-discovered:thread-2', 'codex'],
    ['claude-code:thread-3', 'claude-code'],
    ['claude-code-owned:surface-2', 'claude-code'],
    ['opencode-owned:surface-4', 'opencode'],
    ['pi-owned:surface-7', 'pi'],
    ['hermes-owned:surface-10', 'hermes'],
  ])('resolves %s to %s', (sessionKey, runtimeId) => {
    expect(runtimeIdFromSessionKey(sessionKey)).toBe(runtimeId);
  });

  it('rejects malformed and unknown session keys', () => {
    expect(runtimeIdFromSessionKey('missing-separator')).toBeNull();
    expect(runtimeIdFromSessionKey('unknown-owned:surface')).toBeNull();
  });
});
