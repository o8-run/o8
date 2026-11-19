import { expect, it } from 'vitest';
import { nativeCommitNotice } from '@/lib/ws-server/native-commit-notice';
const request = { kind: 'mutation', refreshTargets: ['global'], mutation: {
  mutationId: 'composer-queue-fixture', source: 'desktop', action: 'composer-queue', status: 'completed',
  surfaceId: 'thoughts-fixture', repoPath: '/fixture/repo', createdAt: '2026-11-19T00:00:00.000Z',
} };
const frame = () => ({ version: 1, kind: 'native-commit', epoch: 'realtime-epoch', request });
it('accepts only the bounded composer metadata in the existing realtime epoch', () => {
  expect(nativeCommitNotice(frame(), 'realtime-epoch')).toEqual(request);
  expect(nativeCommitNotice(frame(), 'composer-owner-epoch')).toBeNull();
});
it.each([{ source: 'server' }, { repoPath: 'relative' }, { payload: 'private wire' }, { claimToken: 'private-fence' }])('refuses non-contract composer metadata %j', change => {
  const value = frame(); value.request = { ...request, mutation: { ...request.mutation, ...change } };
  expect(nativeCommitNotice(value, 'realtime-epoch')).toBeNull();
});
