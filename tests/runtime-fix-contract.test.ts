import { expect, it } from 'vitest';
import { taskSignal } from '@/components/desktop/repo-focus/tabs/control-room/helpers';
import type { TaskPoolTask } from '@/components/desktop/repo-focus/tabs/control-room/types';
it('keeps zero diff signal visible after runtime substitution', () => {
  expect(taskSignal({ lastEventLabel: 'zero_diff_failed', workerRouting: { requestedRuntime: 'codex', selectedRuntime: 'claude-code', reason: 'Quota substitution' } } as TaskPoolTask)).toBe('No changes produced');
});
