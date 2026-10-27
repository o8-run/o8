import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { execFileSync } from '@/lib/providers/child-process';
import { isSafeGitRef } from '@/lib/git/refs';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '40', 10), 100);
  const branch = searchParams.get('branch');

  const home = process.env.HOME || require('os').homedir();
  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  try {
    if (branch && !isSafeGitRef(branch)) {
      return viewerJson({ error: 'Invalid branch name', commits: [], currentBranch: 'main', branches: [] });
    }
    const logArgs = [
      'log',
      '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D',
      '-n',
      String(limit),
    ];
    if (branch) logArgs.push(branch);
    const logOutput = execFileSync('git', logArgs, { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 10000 });

    const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
      try {
        // Delimit fields outside JSON so quoted subjects remain visible and inspected.
        const [hash, shortHash, author, authorEmail, date, subject, rawRefs] = line.split('\0');
        const parsed = { hash, shortHash, author, authorEmail, date, subject, refs: rawRefs };
        // Parse refs into structured data
        const refs: { type: string; name: string }[] = [];
        if (parsed.refs) {
          for (const ref of parsed.refs.split(', ').filter(Boolean)) {
            if (ref.startsWith('HEAD -> ')) {
              refs.push({ type: 'head', name: ref.replace('HEAD -> ', '') });
            } else if (ref.startsWith('tag: ')) {
              refs.push({ type: 'tag', name: ref.replace('tag: ', '') });
            } else if (ref.includes('/')) {
              refs.push({ type: 'remote', name: ref });
            } else {
              refs.push({ type: 'branch', name: ref });
            }
          }
        }
        return { ...parsed, refs };
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Get current branch
    let currentBranch = 'main';
    try {
      currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        windowsHide: true,
        cwd: root, encoding: 'utf-8', timeout: 3000,
      }).trim();
    } catch { /* silent */ }

    // Get branch list
    let branches: string[] = [];
    try {
      branches = execFileSync('git', ['branch', '--format=%(refname:short)'], {
        windowsHide: true,
        cwd: root, encoding: 'utf-8', timeout: 3000,
      }).trim().split('\n').map((b) => b.trim()).filter(Boolean).slice(0, 20);
    } catch { /* silent */ }

    return viewerJson({ commits, currentBranch, branches });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return viewerJson({ error: message, commits: [], currentBranch: 'main', branches: [] });
  }
}
