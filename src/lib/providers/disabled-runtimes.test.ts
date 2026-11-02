import { describe, expect, it } from 'vitest';
import { disabledRuntimeRefusal, isRuntimeDisabled, runtimeForBackend } from './disabled-runtimes';

describe('disabledRuntimes enforcement', () => {
  it('maps composer backends onto runtime ids', () => {
    expect(runtimeForBackend('claude')).toBe('claude-code');
    expect(runtimeForBackend('codex')).toBe('codex');
    expect(isRuntimeDisabled('claude', ['claude-code'])).toBe(true);
    expect(isRuntimeDisabled('codex', ['claude-code'])).toBe(false);
  });
  it('refuses a new session on a disabled runtime', () => {
    const refusal = disabledRuntimeRefusal({ backend: 'codex', threadId: 'thoughts-new', disabled: ['codex'], hasHistory: () => false });
    expect(refusal).toMatch(/turned off in Settings › Providers/);
    expect(disabledRuntimeRefusal({ backend: 'codex', threadId: null, disabled: ['codex'], hasHistory: () => true })).not.toBeNull();
  });
  it('lets running sessions and enabled runtimes continue', () => {
    expect(disabledRuntimeRefusal({ backend: 'codex', threadId: 'thoughts-old', disabled: ['codex'], hasHistory: () => true })).toBeNull();
    expect(disabledRuntimeRefusal({ backend: 'claude', threadId: 'thoughts-new', disabled: ['codex'], hasHistory: () => false })).toBeNull();
  });
});
