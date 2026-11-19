import { expect, it } from 'vitest';
import { nativeCommitNotice } from './native-commit-notice';
const valid = () => ({ version: 1, kind: 'native-commit', epoch: 'current', request: { kind: 'mutation', refreshTargets: ['global'], mutation: { mutationId: 'fixture-notice-id', source: 'server', action: 'session-rule.add', status: 'completed', surfaceId: 'thoughts-fixture', createdAt: '2026-11-18T00:00:00.000Z' } } });
it('accepts only bounded committed-family metadata for the selected producer epoch', () => {
  const notice = valid(); expect(nativeCommitNotice(notice, 'current')).toEqual(notice.request);
  expect(nativeCommitNotice(notice, 'stale')).toBeNull();
  for (const action of ['worker-correction', 'runtime-action', 'orchestrator-send']) {
    const bad = valid(); bad.request.mutation.action = action; expect(nativeCommitNotice(bad, 'current')).toBeNull();
  }
  for (const key of ['source', 'status', 'createdAt', 'surfaceId']) {
    const bad = valid(); bad.request.mutation[key as keyof typeof bad.request.mutation] = key === 'surfaceId' ? 'x'.repeat(4097) : 'unsupported';
    expect(nativeCommitNotice(bad, 'current')).toBeNull();
  }
  const extra = { ...valid(), credentials: 'must never be forwarded' }; expect(nativeCommitNotice(extra, 'current')).toBeNull();
  const bad = valid(); bad.request.refreshTargets.push('sessionHistory'); expect(nativeCommitNotice(bad, 'current')).toBeNull();
});
