/**
 * GET /api/cortex/codebase-memory
 *
 * Returns the live state of the codebase-memory boot indexer (#741, epic
 * #738 Context Engine v2). The status-bar pill in #742's Recall card UI
 * polls this to render the "Indexing 2/4 repos…" chip and to know when
 * the index is ready for dispatch.
 *
 * Response shape: see IndexState in src/lib/codebase-memory/types.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readIndexState } from '@/lib/codebase-memory/live-state';

export async function GET() {
  return NextResponse.json(readIndexState());
}
