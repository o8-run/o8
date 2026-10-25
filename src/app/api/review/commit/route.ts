import { NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import { guardViewerRevision, readViewerRevision } from '@/lib/files/viewer-revision';
import { homedir } from 'node:os';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

export async function POST(request: Request) {
  let body: { message?: string; workspace?: string; path?: string; expectedHeadSha?: string } & Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = body.message?.trim();
  const root = resolveRoot(body.workspace);
  const sourceRefusal = knowledgeSourceWriteRefusal(body.workspace, root);
  if (sourceRefusal) return sourceRefusal;
  if (!message) {
    return NextResponse.json({ error: 'Commit message is required' }, { status: 400 });
  }

  // Prevent shell injection via commit message
  if (message.length > 500) {
    return NextResponse.json({ error: 'Commit message too long (max 500 chars)' }, { status: 400 });
  }

  try {
    const refusal = await guardViewerRevision(root, body);
    if (refusal) return refusal;
    // Check if there are changes to commit
    const status = execFileSync('git', ['status', '--porcelain'], {
      stdio: 'pipe',
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
      cwd: root,
    }).trim();

    if (!status) {
      return NextResponse.json({ error: 'No changes to commit' }, { status: 400 });
    }

    // Stage all changes
    execFileSync('git', ['add', '-A'], { stdio: 'pipe', windowsHide: true, encoding: 'utf-8', timeout: 10000, cwd: root });

    // Commit with the provided message — argv form (no shell), so backticks/$()
    // in the message are passed literally, never interpreted by a shell.
    execFileSync('git', ['commit', '-m', message], {
      stdio: 'pipe',
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 15000,
      cwd: root,
    });

    // Get the commit hash
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: 'pipe',
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
      cwd: root,
    }).trim();

    const revision = body.expectedHeadSha === undefined ? undefined : await readViewerRevision(root, body.path).then(({ bytes: _bytes, ...value }) => value);
    return NextResponse.json({ ok: true, hash, message, revision });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to commit';
    return NextResponse.json({ error: errMessage }, { status: 500 });
  }
}
