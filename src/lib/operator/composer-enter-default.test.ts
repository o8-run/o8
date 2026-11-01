import { describe, expect, it } from 'vitest';
import { applyPresentationUpdate, presentationSettingSources, resolvePresentationDefaults } from './presentation-defaults';

describe('composerEnterQueues', () => {
  it('defaults to steer and persists a boolean', () => {
    expect(resolvePresentationDefaults({}).composerEnterQueues).toBe(false);
    const stored = {};
    applyPresentationUpdate(stored, { composerEnterQueues: true });
    expect(resolvePresentationDefaults(stored).composerEnterQueues).toBe(true);
    expect(presentationSettingSources(stored).composerEnterQueues).toBe('file');
    expect(() => applyPresentationUpdate(stored, { composerEnterQueues: 'yes' as never })).toThrow();
  });
});
