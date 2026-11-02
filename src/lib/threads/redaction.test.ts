import { describe, expect, it } from 'vitest';
import { redactThreadText, redactThreadValue } from './redaction';

describe('thread redaction policy', () => {
  it.each([
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234', 'sk-proj-abcdefghijklmnop1234'],
    ['export ANTHROPIC_API_KEY="anthropic-env-value"', 'anthropic-env-value'],
    ['GITHUB_TOKEN: plainvalue123', 'plainvalue123'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['curl -H "X-Api-Key: header-value-1234" https://api.example.test', 'header-value-1234'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['git clone https://deploy:url-password-1@git.example.test/repo.git', 'url-password-1'],
    ['session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAprivatebody\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAprivatebody'],
    ['token gho_abcdefghijklmnopqrstuvwxyz0123', 'gho_abcdefghijklmnopqrstuvwxyz0123'],
    ['key sk-proj-abc_def-ghi_jkl_mno_pqr', 'sk-proj-abc_def-ghi_jkl_mno_pqr'],
    ['npm npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['glpat-abcdefghijklmnopqrst', 'glpat-abcdefghijklmnopqrst'],
    ['SECRET_KEY=django-insecure-value', 'django-insecure-value'],
    ['Authorization: token opaque-token-value-1', 'opaque-token-value-1'],
  ])('masks %s', (text, secret) => {
    expect(redactThreadText(text)).not.toContain(secret);
    expect(redactThreadText(text)).toContain('[redacted]');
  });

  it('keeps the env-style variable name readable', () => {
    expect(redactThreadText('OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234')).toBe('OPENAI_API_KEY=[redacted]');
  });

  it('leaves ordinary prose and non-secret values unchanged', () => {
    for (const text of ['Basic authentication is disabled.', 'Ran 12 tests in 3.2s; MAX_TOKENS=4096 is unchanged.',
      'The tokenizer split it into tokens.', 'https://example.test/docs/page?ref=main']) {
      expect(redactThreadText(text)).toBe(text);
    }
  });

  it('masks credential-named object keys, including env-style and prefixed names', () => {
    expect(redactThreadValue({ OPENAI_API_KEY: 'a', 'X-Api-Key': 'b', client_secret: 'c', SECRET_KEY: 's', githubToken: 'd', private_key: 'e',
      max_tokens: 5, tokens: { input: 1, output: 2 }, cmd: 'ls' })).toEqual({
      OPENAI_API_KEY: '[redacted]', 'X-Api-Key': '[redacted]', client_secret: '[redacted]', SECRET_KEY: '[redacted]', githubToken: '[redacted]', private_key: '[redacted]',
      max_tokens: 5, tokens: { input: 1, output: 2 }, cmd: 'ls' });
  });
});
