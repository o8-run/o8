import 'server-only';

import { NextResponse } from 'next/server';
import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';

/** Product cutover is fail closed, including unsupported native requests and import. */
export function refuseNodePromptWrite() {
  if (!apiFrontDoorEnabled()) return null;
  return NextResponse.json({
    schema: 'o8/prompt-library.error/v1', ok: false,
    error: { code: 'prompt_library_native_owner', message: 'Saved prompt writes require the native operator transport.' },
  }, { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export function assertNodePromptWriter() {
  if (apiFrontDoorEnabled()) throw new Error('Saved prompt writes belong to o8d on the product transport.');
}
