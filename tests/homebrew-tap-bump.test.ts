import { describe, expect, it } from 'vitest';

import { HOMEBREW_TAP, requestHomebrewBump } from '../scripts/lib/homebrew-tap.mjs';

describe('asking the Homebrew tap to follow a stable release', () => {
  it('dispatches the tap workflow with the version', () => {
    const calls: Array<[string, string[]]> = [];
    const result = requestHomebrewBump('0.1.822', (file, args) => { calls.push([file, args]); return ''; });
    expect(result).toEqual({ requested: true, reason: null });
    expect(calls).toEqual([['gh', ['workflow', 'run', 'bump.yml', '-R', HOMEBREW_TAP, '-f', 'version=0.1.822']]]);
  });

  it('never dispatches for a preview version', () => {
    let called = false;
    const result = requestHomebrewBump('0.1.822-preview.1', () => { called = true; return ''; });
    expect(called).toBe(false);
    expect(result.requested).toBe(false);
  });

  it('reports a failed dispatch instead of throwing, so the release goes on', () => {
    const failing = () => { throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: workflow not found\nmore' }); };
    expect(requestHomebrewBump('0.1.822', failing)).toEqual({ requested: false, reason: 'HTTP 404: workflow not found' });
  });
});
