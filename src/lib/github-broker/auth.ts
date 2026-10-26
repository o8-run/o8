import 'server-only';

import { createHmac, createPrivateKey, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { getGitHubAppConfig, requireGitHubAppConfig } from './env';
import { readActiveIdentity, readManagedGithubToken, readSignInEpoch } from './managed';
import { assertGitHubRequestBudget, githubCredentialScope, observeGitHubRequestBudget, type GitHubReadPriority } from './request-budget';
import { sharedConditionalGitHubRead } from './conditional-read';
import { isSecondaryGitHubLimit } from './rate-limit-response';
import { GitHubOrgNotCoveredError, githubRepoAccessKey, managedGitHubOwnerMatches, publicGitHubDecision } from './repo-access';
import { publicGitHubRead } from './public-read';

const INSTALLATION_TOKEN_TTL_SKEW_MS = 60_000;
const installationTokenCache = new Map<number, { token: string; expiresAtMs: number }>();
class AnonymousReadRequired extends Error {}

/** Capture before any request await; installation ids alone do not identify an o8 account. */
export function captureGitHubAccount() {
  const config = getGitHubAppConfig();
  return { owner: readActiveIdentity(), epoch: readSignInEpoch(), appId: config?.appId ?? null,
    apiBaseUrl: config?.apiBaseUrl ?? 'https://api.github.com' };
}
type GitHubAccount = ReturnType<typeof captureGitHubAccount>;

export class GitHubAccountChangedError extends Error {
  constructor() { super('The GitHub account changed. Retry from the account that owns this draft.'); }
}

export function requireGitHubAccount(account: GitHubAccount): void {
  const current = captureGitHubAccount();
  if (current.owner !== account.owner || current.epoch !== account.epoch
    || current.appId !== account.appId || current.apiBaseUrl !== account.apiBaseUrl) throw new GitHubAccountChangedError();
}

export interface GitHubInstallationAuthorization {
  account: GitHubAccount;
  installation: Awaited<ReturnType<typeof getInstallationForRepo>>;
  token: string;
}

export async function captureGitHubInstallationAuthorization(repo: string, account: GitHubAccount): Promise<GitHubInstallationAuthorization> {
  requireGitHubAccount(account);
  const installation = await getInstallationForRepo(repo);
  requireGitHubAccount(account);
  const token = await getInstallationToken(installation.id);
  requireGitHubAccount(account);
  return { account, installation, token };
}

/**
 * Whether the broker can reach GitHub at all — BYO App config OR a live managed
 * token. Callers that used to gate on `!getGitHubAppConfig()` MUST use this, or
 * they short-circuit managed mode ("not configured") before ever trying the
 * managed token (audit #1 — the sync.ts issue/PR readers did exactly that).
 */
export function hasGitHubBrokerAccess(): boolean {
  return Boolean(getGitHubAppConfig()) || readManagedGithubToken() !== null;
}

/** Managed mode has no valid token right now (expired / not installed). Distinct
 * from "not configured" so routes can surface a reconnect prompt (audit #6). */
export class GitHubManagedUnavailableError extends Error {
  readonly code = 'github_managed_unavailable';
  constructor() {
    super('The o8 GitHub App token is unavailable — sign in again or install the o8 GitHub App to reconnect.');
    this.name = 'GitHubManagedUnavailableError';
  }
}

function githubHeaders(token: string, extra?: HeadersInit): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'o8-github-broker',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function createAppJwt() {
  const config = requireGitHubAppConfig();
  const privateKey = createPrivateKey(config.privateKey);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(config.appId)
    .sign(privateKey);
}

async function githubAppFetch(path: string, init?: RequestInit) {
  const config = requireGitHubAppConfig();
  const jwt = await createAppJwt();
  return fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: githubHeaders(jwt, init?.headers),
    cache: 'no-store',
  });
}

function buildGitHubError(response: Response, bodyText: string) {
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const pieces = [`GitHub request failed (${response.status})`];

  if (bodyText) pieces.push(bodyText.trim());
  if (remaining) pieces.push(`remaining=${remaining}`);
  if (retryAfter) pieces.push(`retryAfter=${retryAfter}s`);
  if (reset) pieces.push(`resetAt=${new Date(Number(reset) * 1000).toISOString()}`);

  return new Error(pieces.join(' · '));
}

export async function getInstallationForRepo(repoFullName: string, signal?: AbortSignal) {
  // Managed mode holds one installation. Never authorize a different owner.
  if (!getGitHubAppConfig()) {
    const managed = readManagedGithubToken();
    if (managed) {
      if (!managedGitHubOwnerMatches(repoFullName, managed.accountLogin)) throw new GitHubOrgNotCoveredError();
      return {
        id: managed.installationId,
        account: managed.accountLogin ? { login: managed.accountLogin } : undefined,
      } as { id: number; target_type?: string; permissions?: Record<string, string>; account?: { login?: string; type?: string } };
    }
    // Managed mode with no valid token (expired between the hourly mints, or
    // never installed). Throw a CLEAR, catchable error so callers surface
    // "reconnect GitHub" rather than the misleading "App is not configured"
    // that requireGitHubAppConfig would throw below (audit #6).
    throw new GitHubManagedUnavailableError();
  }
  const response = await githubAppFetch(`/repos/${repoFullName}/installation`, { signal });
  const text = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, text);
  }
  return JSON.parse(text) as {
    id: number;
    target_type?: string;
    permissions?: Record<string, string>;
    account?: { login?: string; type?: string };
  };
}

export async function getInstallationToken(installationId: number, signal?: AbortSignal) {
  // Managed mode: the license server minted this token; use it as-is. Never
  // fall through to githubAppFetch (no BYO key exists — it would throw the
  // misleading "not configured", audit #1/#6).
  if (!getGitHubAppConfig()) {
    const managed = readManagedGithubToken();
    if (managed && managed.installationId === installationId) return managed.token;
    throw new GitHubManagedUnavailableError();
  }
  const cached = installationTokenCache.get(installationId);
  if (cached && (Date.now() + INSTALLATION_TOKEN_TTL_SKEW_MS) < cached.expiresAtMs) {
    return cached.token;
  }

  const response = await githubAppFetch(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, text);
  }

  const data = JSON.parse(text) as { token: string; expires_at: string };
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAtMs: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

export async function githubInstallationFetch(repoFullName: string, path: string, init?: RequestInit,
  readOptions: { priority?: GitHubReadPriority; share?: boolean; authorization?: GitHubInstallationAuthorization } = {}) {
  const authorization = readOptions.authorization;
  const isRead = !init?.method || init.method === 'GET';
  const config = getGitHubAppConfig();
  const managed = config ? null : readManagedGithubToken();
  const decisionKey = githubRepoAccessKey(repoFullName);
  const decision = publicGitHubDecision(decisionKey);
  const outsideManagedOwner = !config && !managedGitHubOwnerMatches(repoFullName, managed?.accountLogin);
  const apiBaseUrl = authorization?.account.apiBaseUrl ?? config?.apiBaseUrl ?? 'https://api.github.com';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('GitHub request does not match the repository.');
  const repoPath = `/repos/${repoFullName.toLowerCase()}`;
  const targetPath = new URL(`${apiBaseUrl}${path}`).pathname.toLowerCase();
  const basePath = new URL(apiBaseUrl).pathname.replace(/\/$/, '').toLowerCase();
  const withinRepo = targetPath === `${basePath}${repoPath}` || targetPath.startsWith(`${basePath}${repoPath}/`);
  if (!withinRepo && path !== '/graphql') throw new Error('GitHub request does not match the repository.');
  const anonymousRead = async () => {
    // Anonymous transport is restricted to this repository's REST reads.
    if (!isRead || !withinRepo) throw new GitHubOrgNotCoveredError();
    const { response, scope } = await publicGitHubRead(repoFullName, path, apiBaseUrl, decisionKey, init, readOptions.priority,
      readOptions.share === false || init?.cache === 'reload' ? 0 : 120_000);
    return { response, installation: { id: 0, account: { login: repoFullName.split('/')[0] } } as Awaited<ReturnType<typeof getInstallationForRepo>>, scope, anonymous: true };
  };
  if (outsideManagedOwner || isRead && decision && !authorization) {
    if (!isRead || authorization) throw new GitHubOrgNotCoveredError();
    return anonymousRead();
  }
  const installation = authorization ? authorization.installation : await getInstallationForRepo(repoFullName, init?.signal ?? undefined);
  const token = authorization ? authorization.token : await getInstallationToken(installation.id, init?.signal ?? undefined);
  // Managed mode has NO BYO config — requireGitHubAppConfig() would throw here
  // even though we hold a valid token (audit #1, the bug that made every managed
  // GitHub call fail). The API base is always public GitHub in managed mode.
  const scope = githubCredentialScope(apiBaseUrl, installation.id, token);
  const budgetScope = githubCredentialScope(apiBaseUrl, installation.id, 'installation-budget');
  const resource = path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core';
  const read = async (etag?: string) => {
    assertGitHubRequestBudget(budgetScope, resource, readOptions.priority ?? 'interactive');
    const headers = new Headers(githubHeaders(token, init?.headers)); if (etag) headers.set('If-None-Match', etag);
    // No await between this guard and dispatch. Never resolve another account's
    // token after a creation has been reserved for the captured account.
    if (authorization) requireGitHubAccount(authorization.account);
    const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers, cache: 'no-store', redirect: 'manual' });
    observeGitHubRequestBudget(budgetScope, resource, response, Date.now(), await isSecondaryGitHubLimit(response));
    if (response.status === 403 || response.status === 429) assertGitHubRequestBudget(budgetScope, resource, 'interactive');
    // Retry only reads. Never use public fallback to authorize a mutation.
    if (isRead && !authorization && (response.status === 404 || response.status === 301 || response.status === 308)) {
      await response.body?.cancel().catch(() => {});
      // Leave the installation cache before changing transport/credential scope.
      throw new AnonymousReadRequired();
    }
    return response;
  };
  try {
    const response = readOptions.share && (!init?.method || init.method === 'GET')
      ? await sharedConditionalGitHubRead(JSON.stringify([scope, repoFullName.toLowerCase(), path]), read) : await read();
    // A concurrent public decision cannot relabel an installation response.
    return { response, installation, scope, anonymous: false };
  } catch (error) {
    if (error instanceof AnonymousReadRequired) return anonymousRead();
    throw error;
  }
}

export function verifyGitHubWebhookSignature(rawBody: string, signatureHeader: string | null) {
  const config = requireGitHubAppConfig();
  if (!config.webhookSecret) {
    throw new Error('GitHub App webhook secret is not configured.');
  }
  if (!signatureHeader) return false;

  const digest = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const expected = `sha256=${digest}`;
  const actual = signatureHeader;
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
