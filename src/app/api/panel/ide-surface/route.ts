export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readIdeSurfaceState, writeIdeSurfaceState } from '@/lib/runtime/ide-surface-state';

export async function GET() {
  return NextResponse.json(readIdeSurfaceState());
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      terminalRepoPaths?: string[];
      activeRepoPath?: string | null;
    };
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
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
