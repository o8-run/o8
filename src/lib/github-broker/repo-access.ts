import 'server-only';
import { getGitHubAppConfig } from './env';
import { readManagedGithubToken } from './managed';
import { githubCredentialScope } from './request-budget';
import { GitHubOrgNotCoveredError } from '@/lib/github/org-access';
export { GitHubOrgNotCoveredError } from '@/lib/github/org-access';

export const PUBLIC_GITHUB_REFRESH_MS = 10 * 60_000;

const decisions = new Map<string, { denied: boolean; until: number }>();
export function githubRepoAccessKey(repo: string): string {
  const config = getGitHubAppConfig();
  const managed = config ? null : readManagedGithubToken();
  const identity = config ? `app:${config.appId}` : `${managed?.token ?? 'anonymous'}:${managed?.accountLogin ?? ''}`;
  return githubCredentialScope(config?.apiBaseUrl ?? 'https://api.github.com',
    managed?.installationId ?? 0, `${identity}:${repo.toLowerCase()}`);
}
export function publicGitHubDecision(key: string) {
  const entry = decisions.get(key);
  if (entry && Date.now() < entry.until) return entry;
  decisions.delete(key);
  return undefined;
}
export function rememberPublicGitHubDecision(key: string, denied: boolean) {
  if (decisions.size >= 128) decisions.delete(decisions.keys().next().value!);
  decisions.set(key, { denied, until: Date.now() + (denied ? PUBLIC_GITHUB_REFRESH_MS : 60 * 60_000) });
}
export function managedGitHubOwnerMatches(repo: string, account: string | null | undefined): boolean {
  return Boolean(account && repo.split('/')[0].toLowerCase() === account.toLowerCase());
}
export function usesAnonymousGitHubReads(repo: string): boolean {
  if (publicGitHubDecision(githubRepoAccessKey(repo))) return true;
  if (getGitHubAppConfig()) return false;
  const managed = readManagedGithubToken();
  return !managed || !managedGitHubOwnerMatches(repo, managed.accountLogin);
}
export function hasConfirmedPublicGitHubAccess(repo: string): boolean {
  return publicGitHubDecision(githubRepoAccessKey(repo))?.denied === false;
}
export function canReadGitHubSnapshot(repo: string): boolean {
  return !usesAnonymousGitHubReads(repo) || hasConfirmedPublicGitHubAccess(repo);
}
export function githubOrgAccessCode(message: string | null | undefined) {
  return message === new GitHubOrgNotCoveredError().message ? 'github_org_not_covered' : null;
}
