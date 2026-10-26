import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the BYO config absent regardless of the dev machine: env.ts falls back
// to ~/.o8/github-app.pem, which exists on the primary dev box — pointing
// homedir at an empty temp dir makes getGitHubAppConfig() return null, which
// is exactly a fresh user's machine (the managed path's real precondition).
const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path') as typeof import('node:path');
  return mk(j(td(), 'o8-managed-home-'));
});
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => fakeHome, default: { ...real, homedir: () => fakeHome } };
});

import {
  clearActiveIdentity,
  clearManagedGithubState,
  readManagedGithubToken,
  writeActiveIdentity,
  writeManagedGithubState,
} from '@/lib/github-broker/managed';
import {
  GitHubManagedUnavailableError,
  getInstallationForRepo,
  getInstallationToken,
  githubInstallationFetch,
  hasGitHubBrokerAccess,
} from '@/lib/github-broker/auth';

const OWNER = 'user_owner_abc';

function persistValidToken(owner = OWNER, token = 'ghs_managed_test_token') {
  writeManagedGithubState({
    installed: true,
    token,
    expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    installationId: 4242,
    accountLogin: 'someone',
    ownerClerkUserId: owner,
  });
}

/**
 * Real-path seam (reachability rule): the entitlement sync persists managed
 * GitHub App state + an active-identity anchor to disk, and the broker's REAL
 * auth functions — the ones every /api/panel GitHub route calls, INCLUDING
 * githubInstallationFetch (where the audit's HIGH #1 lived) — must pick them up
 * with no BYO env config and no network for the setup.
 */
describe('managed GitHub App broker seam', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'o8-managed-data-'));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  afterEach(() => {
    clearManagedGithubState();
    clearActiveIdentity();
    delete process.env.CORTEX_IDE_DATA_DIR;
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the token through the full broker chain when owner === active identity', async () => {
    persistValidToken();
    writeActiveIdentity(OWNER);

    const installation = await getInstallationForRepo('someone/some-repo');
    expect(installation.id).toBe(4242);
    expect(installation.account?.login).toBe('someone');
    expect(await getInstallationToken(installation.id)).toBe('ghs_managed_test_token');
  });

  it('githubInstallationFetch reaches GitHub with the managed token (audit #1 — no "not configured" throw)', async () => {
    persistValidToken();
    writeActiveIdentity(OWNER);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200 }),
    );

    const { response } = await githubInstallationFetch('someone/some-repo', '/repos/someone/some-repo/issues');
    expect(response.status).toBe(200);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe('https://api.github.com/repos/someone/some-repo/issues');
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer ghs_managed_test_token');
  });

  it('FAILS CLOSED when the active identity is a DIFFERENT user (cross-account, audit #2)', async () => {
    persistValidToken(OWNER);
    writeActiveIdentity('user_someone_else');

    expect(readManagedGithubToken()).toBeNull();
    // The broker must not fabricate an installation for a token it won't serve.
    await expect(getInstallationForRepo('someone/some-repo')).rejects.toBeInstanceOf(
      GitHubManagedUnavailableError,
    );
  });

  it('FAILS CLOSED when no active identity is recorded', () => {
    persistValidToken(OWNER);
    // no writeActiveIdentity
    expect(readManagedGithubToken()).toBeNull();
  });

  it('FAILS CLOSED for a legacy token with no owner stamp', () => {
    // A pre-binding file shape (no ownerClerkUserId) must not be served.
    writeManagedGithubState({
      installed: true,
      token: 'ghs_legacy',
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
      installationId: 4242,
      accountLogin: 'chris-example',
    });
    writeActiveIdentity(OWNER);
    expect(readManagedGithubToken()).toBeNull();
  });

  it('an expiring managed token is treated as absent (falls back, never serves stale)', () => {
    writeManagedGithubState({
      installed: true,
      token: 'ghs_about_to_die',
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      installationId: 4242,
      accountLogin: 'chris-example',
      ownerClerkUserId: OWNER,
    });
    writeActiveIdentity(OWNER);
    expect(readManagedGithubToken()).toBeNull();
  });

  it('hasGitHubBrokerAccess is TRUE in managed mode with a valid bound token (audit #1 — sync.ts readers)', () => {
    persistValidToken();
    writeActiveIdentity(OWNER);
    expect(hasGitHubBrokerAccess()).toBe(true);
  });

  it('hasGitHubBrokerAccess is FALSE with no config and no servable token', () => {
    persistValidToken();
    writeActiveIdentity('user_someone_else'); // owner mismatch → token not servable
    expect(hasGitHubBrokerAccess()).toBe(false);
  });

  it('installed:false marker never yields a token', () => {
    writeManagedGithubState({
      installed: false,
      installUrl: 'https://github.com/apps/o8-run/installations/new',
      ownerClerkUserId: OWNER,
    });
    writeActiveIdentity(OWNER);
    expect(readManagedGithubToken()).toBeNull();
  });
});
