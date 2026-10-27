import { describe, expect, it } from 'vitest';

import { PRODUCT_EVENT_DISCLOSURES, sanitizeProductEvent } from './events';

describe('product telemetry payload allowlist', () => {
  it('discloses all nine wire events exactly once', () => {
    expect(PRODUCT_EVENT_DISCLOSURES).toEqual([
      { event: 'app.opened', fields: 'no properties' },
      { event: 'brain.asked', fields: 'no properties' },
      { event: 'orchestrator.message', fields: 'no properties' },
      { event: 'dispatch.started', fields: 'runtime — known worker-runtime enum' },
      { event: 'merge.approved', fields: 'runtime — known worker-runtime enum; pushed — boolean' },
      { event: 'repo.added', fields: 'hasRemote — boolean; isGitRepo — boolean' },
      { event: 'worker.first_launched', fields: 'no properties' },
      { event: 'merge.first_completed', fields: 'no properties' },
      { event: 'session.ended', fields: 'clean — boolean' },
    ]);
  });

  it('accepts only known events and their exact coarse fields', () => {
    expect(sanitizeProductEvent('merge.approved', {
      runtime: 'codex',
      pushed: true,
      repoName: 'private-repo',
      path: '/Users/example/private',
      prompt: 'secret prompt',
    })).toEqual({ event: 'merge.approved', props: { runtime: 'codex', pushed: true } });

    expect(sanitizeProductEvent('app.opened', { transcript: 'secret' })).toEqual({ event: 'app.opened' });
    expect(sanitizeProductEvent('orchestrator.message', { prompt: 'secret' })).toEqual({ event: 'orchestrator.message' });
    expect(sanitizeProductEvent('unknown.event', {})).toBeNull();
    expect(sanitizeProductEvent('dispatch.started', { runtime: 'private-repo' })).toBeNull();
  });
});
