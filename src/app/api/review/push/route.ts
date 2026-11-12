import { NextResponse } from 'next/server';
import { homedir } from 'node:os';
import { pushWorkspace } from '@/lib/review/push-operation';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

async function handlePost(request: Request) {
  let body: { workspace?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const workspace = body.workspace;
  const root = !workspace ? REPO_ROOT : workspace.startsWith('~') ? workspace.replace('~', homedir()) : workspace;
  // Next bundles cannot locate a Node helper relative to import.meta.url.
  // Keep the original in-process Git path when native ownership is disabled.
  const result = await pushWorkspace(root);
  return NextResponse.json(result.body, { status: result.status });
}

export const POST = ownedByNativeTransport(handlePost, () =>
  NextResponse.json({ error: 'Push failed' }, { status: 503 }));
