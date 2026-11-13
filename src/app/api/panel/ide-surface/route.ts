import { readJsonObject } from '@/lib/panel/read-json-object';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readIdeSurfaceState, writeIdeSurfaceState } from '@/lib/runtime/ide-surface-state';

export async function GET() {
  return NextResponse.json(readIdeSurfaceState());
}

export async function POST(request: Request) {
  try {
    const body = await readJsonObject<{
      terminalRepoPaths?: string[];
      activeRepoPath?: string | null;
    }>(request);
    if (!body) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const next = writeIdeSurfaceState({
      terminalRepoPaths: body.terminalRepoPaths,
      activeRepoPath: body.activeRepoPath,
    });
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to persist IDE surface state.' },
      { status: 500 },
    );
  }
}
