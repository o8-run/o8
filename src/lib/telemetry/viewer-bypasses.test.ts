import { describe, expect, it } from 'vitest';
import { redactSecrets } from './scrub';
import { viewerCredentialCorpus } from '../../../tests/fixtures/viewer-credential-corpus';

describe('shared credential matcher viewer bypasses', () => {
  it.each(viewerCredentialCorpus.slice(0, 3))('$name never retains the credential', ({ text, clear }) => {
    expect(redactSecrets(text).includes(clear)).toBe(false);
  });
});
