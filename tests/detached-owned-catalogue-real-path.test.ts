import { describe, expect, it } from 'vitest';
import '@/lib/runtimes';
import { listDeclarativeRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';

describe('detached owned packet registration boundary', () => {
  it.each(['codex', 'claude-code', 'opencode', ...listDeclarativeRuntimes()])(
    'registers %s for strict batch survivor reconciliation', (runtime) => {
      expect(getOwnedSessionLifecycle(`${runtime}-owned:fixture`)?.detachedPacketIdentity).toBe(true);
    });
  it.each(['hermes', 'pi', 'pi-builtin'])(
    'does not treat the %s pipe transport as a detached batch survivor', (runtime) => {
      expect(getOwnedSessionLifecycle(`${runtime}-owned:fixture`)?.detachedPacketIdentity).not.toBe(true);
    });
});
