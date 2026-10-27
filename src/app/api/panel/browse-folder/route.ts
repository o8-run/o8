export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { pickNativePath } from '@/lib/desktop/native-picker';

/** Native folder selection; cancellation is distinct from picker failure. */
export async function POST() {
  const result = await pickNativePath('folder', 'Select a project folder', { timeoutMs: 60_000 });
  if (result.unavailable) {
    return NextResponse.json({ ...result, error: 'Could not open the folder picker. Paste a folder path or Git URL.' }, { status: 503 });
  }
  return NextResponse.json(result);
}
