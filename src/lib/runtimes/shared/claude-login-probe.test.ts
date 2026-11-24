import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasStoredClaudeOAuthCredential } from './claude-login-probe';

describe('stored Claude login evidence', () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function home(userConfig: unknown): void {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-login-'));
    homes.push(dir);
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(userConfig));
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, '.claude'));
  }

  it('counts an account record as signed in whatever its values, so none is read', async () => {
    // No email field at all: the old check read the email and called this signed out.
    home({ oauthAccount: { accountUuid: 'fixture-account' } });
    await expect(hasStoredClaudeOAuthCredential()).resolves.toBe(true);
    home({ oauthAccount: { emailAddress: '' } });
    await expect(hasStoredClaudeOAuthCredential()).resolves.toBe(true);
  });

  it('treats a missing or empty account record as signed out', async () => {
    home({});
    await expect(hasStoredClaudeOAuthCredential()).resolves.toBe(false);
    home({ oauthAccount: {} });
    await expect(hasStoredClaudeOAuthCredential()).resolves.toBe(false);
    home({ oauthAccount: ['x'] });
    await expect(hasStoredClaudeOAuthCredential()).resolves.toBe(false);
  });
});
