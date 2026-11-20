import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { resolveDirectiveListScope } from '@/lib/cortex/directives/scope';

/** Scope and one-time data-directory initialization only; no directive reads. */
export async function nativeDirectivesScope(url: URL) {
  try {
    // Keep the original early return before scope resolution (including 404s).
    const directory = join(getDataDir(), 'directives');
    if (!existsSync(directory)) return { version: 1, directoryExists: false };
    if (!['en', 'en-US'].includes(new Intl.Collator().resolvedOptions().locale)) return null;
    const repoPath = url.searchParams.get('repoPath')?.trim() || null;
    const projectId = url.searchParams.get('projectId')?.trim();
    const scope = await resolveDirectiveListScope(projectId, repoPath);
    if (!scope) return null;
    const projectIds = [...scope.projectIds], projectSlugs = [...scope.projectSlugs];
    const strings = [...projectIds, ...projectSlugs];
    if (strings.length > 128 || strings.some(value => Buffer.byteLength(value) > 1024)) return null;
    const result = { version: 1, directoryExists: true, projectIds, projectSlugs, repoInActiveProject: scope.repoInActiveProject };
    return Buffer.byteLength(JSON.stringify(result)) <= 2048 ? result : null;
  } catch { return null; }
}
