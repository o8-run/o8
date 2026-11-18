import { NextResponse, type NextRequest } from 'next/server';

import { refuseNodePromptWrite } from '@/lib/prompt-library/write-owner';
import { requirePanelAuth } from '@/lib/panel/auth';
import { recordPromptLibraryUse } from '@/lib/prompt-library/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const ownerRefusal = refuseNodePromptWrite();
  if (ownerRefusal) return ownerRefusal;

  const { id } = await context.params;
  const prompt = recordPromptLibraryUse(id);
  if (!prompt) {
    return NextResponse.json({
      schema: 'o8/prompt-library.error/v1',
      ok: false,
      error: { code: 'prompt_not_found', message: 'Saved prompt not found.' },
    }, { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
  return NextResponse.json({
    schema: 'o8/prompt-library.entry/v1',
    ok: true,
    prompt,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
