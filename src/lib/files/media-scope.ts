import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const WORKSPACE_ROOT = process.env.CORTEX_IDE_WORKSPACE_ROOT || homedir();
const MEDIA_ROOT = process.env.CORTEX_IDE_MEDIA_ROOT || join(getDataDir(), 'media');
const MEDIA_ROOTS = [MEDIA_ROOT, `${WORKSPACE_ROOT}/inbox`, `${WORKSPACE_ROOT}/archive/artifacts`];
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

export async function resolveAllowedMediaTarget(rawPath: string) {
  if (!MEDIA_EXTENSIONS.has(extname(rawPath).toLowerCase())) throw new Error('Requested media type is not allowed.');
  const path = await realpath(rawPath);
  const roots = (await Promise.allSettled(MEDIA_ROOTS.map(root => realpath(root))))
    .flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const root = roots.find(root => path === root || path.startsWith(`${root}/`));
  if (!root) throw new Error('Requested media path is outside the allowed media roots.');
  return { root, path };
}
