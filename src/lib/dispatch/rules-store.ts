import { existsSync, readFileSync } from 'node:fs';

const REPO_SCOPED_RULE_CACHE_TTL_MS = 30_000;
const repoScopedRuleCache = new Map<string, { expiresAt: number; rules: string[] }>();

export function readRepoScopedRules(repoPath: string): string[] {
  const normalizedRepoPath = repoPath.trim().replace(/[\\/]+$/, '');
  if (!normalizedRepoPath) {
    return [];
  }

  const now = Date.now();
  const cached = repoScopedRuleCache.get(normalizedRepoPath);
  if (cached && cached.expiresAt > now) {
    return cached.rules;
  }

  const filePath = `${normalizedRepoPath}/.o8/dispatch-rules.md`;
  const rules = existsSync(filePath)
    ? readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^\s*[-*]\s+(.+)$/);
        return match?.[1]?.trim() ? [match[1].trim()] : [];
      })
    : [];

  repoScopedRuleCache.set(normalizedRepoPath, { expiresAt: now + REPO_SCOPED_RULE_CACHE_TTL_MS, rules });
  return rules;
}
