import { NextResponse } from 'next/server';
import { runPushChild } from '@/lib/providers/child-process';
import { homedir } from 'node:os';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

export async function POST(request: Request) {
  let body: { workspace?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const root = resolveRoot(body.workspace);

  try {
    const result = await runPushChild(root, request.signal);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Push failed' }, { status: 500 });
  }
}
