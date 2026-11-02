/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/ProjectStore.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: per-repository o8 app_state keys,
 * separate file/identity patches and the existing repository listing projection.
 */
import 'server-only';
import { getSqlite } from '@/lib/db';
import type { RepoRegistryEntry } from './types';
import { normalizeProjectIcon, ProjectIconInputError, type ProjectIconProjection, type ProjectIconSettings } from './project-icon-types';
import { projectIconResolver, projectIconResource, validateProjectIconPath } from './project-icon-resolver';

const key = (id: string) => `repository-icon:${id}`;
export function getProjectIconSettings(id: string): ProjectIconSettings {
  const row = getSqlite().prepare('SELECT value FROM app_state WHERE key = ?').get(key(id)) as { value: string } | undefined;
  if (row) {
    try {
      const value = JSON.parse(row.value) as ProjectIconSettings;
      return { faviconPath: typeof value.faviconPath === 'string' ? value.faviconPath : null,
        projectIcon: normalizeProjectIcon(value.projectIcon ?? null) };
    } catch { /* Invalid stored metadata retains the existing monogram fallback. */ }
  }
  return { faviconPath: null, projectIcon: null };
}
export async function updateProjectIconSettings(repo: RepoRegistryEntry, patch: { faviconPath?: unknown; projectIcon?: unknown }) {
  if (patch.faviconPath === undefined && patch.projectIcon === undefined) throw new ProjectIconInputError('Provide an icon path or identity override.');
  let faviconPath: string | null | undefined;
  if (patch.faviconPath !== undefined) {
    if (patch.faviconPath === null) faviconPath = null;
    else {
      if (typeof patch.faviconPath !== 'string' || !patch.faviconPath.trim() || patch.faviconPath.length > 1024) throw new ProjectIconInputError('Invalid project icon path.');
      faviconPath = patch.faviconPath.trim();
      const valid = await validateProjectIconPath(repo.localPath, faviconPath).catch(() => false);
      if (!valid) throw new ProjectIconInputError('Choose an image inside this repository, no larger than 1 MiB.');
    }
  }
  const projectIcon = patch.projectIcon === undefined ? undefined : normalizeProjectIcon(patch.projectIcon);
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const previous = getProjectIconSettings(repo.id);
    const settings: ProjectIconSettings = {
      faviconPath: faviconPath === undefined ? previous.faviconPath : faviconPath,
      projectIcon: projectIcon === undefined ? previous.projectIcon : projectIcon,
    };
    sqlite.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key(repo.id), JSON.stringify(settings), Date.now());
  })();
  projectIconResolver.invalidate(repo.localPath);
}
export async function projectIconProjection(repo: { id: string; localPath: string }): Promise<ProjectIconProjection> {
  const settings = getProjectIconSettings(repo.id);
  if (settings.projectIcon) {
    const icon = settings.projectIcon;
    return icon.kind === 'lucide' ? { ...icon, kind: 'glyph' } : icon;
  }
  // Resolution failures are not negative cache entries. Keep the sidebar usable
  // and retry on the next listing, with the existing monogram as the fallback.
  const resource = await projectIconResource(repo.localPath, settings.faviconPath).catch(() => null);
  return resource ? { kind: 'image', ...resource } : null;
}
