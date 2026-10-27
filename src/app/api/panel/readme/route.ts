import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');

  const home = process.env.HOME || require('os').homedir();
  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  // Try common readme filenames
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README'];
  for (const name of candidates) {
    const filePath = join(root, name);
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8');
        return viewerJson({ content, fileName: name, workspace: workspaceParam ?? root });
      } catch {
        continue;
      }
    }
  }

  return viewerJson({ content: null, workspace: workspaceParam ?? root });
}
