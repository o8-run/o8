import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
// Asynchronous, so a slow commit hook never blocks the serving process's event
// loop (on the native transport, that process also carries realtime traffic).
const execFileAsync = promisify(execFile);

async function git(args: string[], root: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { windowsHide: true, encoding: 'utf-8', timeout, cwd: root });
  return String(stdout);
}

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

export async function POST(request: Request) {
  let body: { message?: string; workspace?: string };
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
    // Check if there are changes to commit
    const status = (await git(['status', '--porcelain'], root, 5000)).trim();

    if (!status) {
      return NextResponse.json({ error: 'No changes to commit' }, { status: 400 });
    }

    // Stage all changes
    await git(['add', '-A'], root, 10000);

    // Commit with the provided message — argv form (no shell), so backticks/$()
    // in the message are passed literally, never interpreted by a shell.
    await git(['commit', '-m', message], root, 15000);

    // Get the commit hash
    const hash = (await git(['rev-parse', '--short', 'HEAD'], root, 5000)).trim();

    return NextResponse.json({ ok: true, hash, message });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to commit';
    return NextResponse.json({ error: errMessage }, { status: 500 });
  }
}
