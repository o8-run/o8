import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { confineToRoots } from '@/lib/fs/safe-path';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';

export async function resolveAssetRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();
  const requestedPath = workspace.startsWith('~') ? workspace.replace('~', homedir()) : workspace;
  return (await resolveRegisteredRepoScope(requestedPath)).repoRoot;
}

/** Canonical per-request authority only. null means defer to the original handler. */
export async function nativeAssetTarget(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('path');
  if (url.pathname === '/api/panel/file-io') {
    const { authorizeFileAccess, resolveAbsolute } = await import('./file-io-authority');
    const path = raw && resolveAbsolute(raw);
    if (!path || await authorizeFileAccess(request, path)) return null;
    return { root: dirname(path), relativePath: basename(path), path };
  }
  if (url.pathname === '/api/panel/file-asset') {
    if (!raw) return undefined;
    const root = await resolveAssetRoot(url.searchParams.get('workspace'));
    return root ? { root, relativePath: raw } : null;
  }
  if (url.pathname === '/api/panel/serve-image') {
    if (!raw) return undefined;
    const { SERVE_IMAGE_ROOTS } = await import('./serve-image-scope');
    const path = confineToRoots(raw, SERVE_IMAGE_ROOTS);
    if (!path) return null;
    const root = SERVE_IMAGE_ROOTS.map(root => resolve(root)).find(root => {
      const rel = relative(root, path);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    return root ? { root, relativePath: relative(root, path), path } : null;
  }
  if (!raw?.trim()) return null;
  const { root, path } = await (await import('./media-scope')).resolveAllowedMediaTarget(raw.trim());
  return { root, relativePath: relative(root, path), path, sourcePath: raw.trim() };
}
